"""Run every L’AIGUILLEUR LLM request as a Mistral Workflows execution.

Prompts are built here; the named feature workflows (worker/workflows) perform the
mistral-large-4 call on the worker. This module only starts executions and
validates their results — it never calls the chat API directly.
"""

import asyncio
import contextlib
import logging
import uuid
from pathlib import Path
from time import perf_counter
from typing import Any, Literal

from httpx import HTTPError
from mistralai.client.errors import MistralError, NoResponseError
from mistralai.workflows.client import get_mistral_client
from pydantic import BaseModel, ConfigDict, Field

from worker.workflow_types import WORKFLOW_NAMES, Task

from . import prompts
from .data import DEFAULT_DATA_PATH
from .data.schema import KPI_KEYS, load_document
from .prompts import MODEL, context_for

__all__ = [
    "AI_ERRORS",
    "MODEL",
    "AIService",
    "AIUnavailable",
    "InvalidAIResponse",
    "context_for",
]

# Below the browser’s 90-second request timeout, so the UI receives a clear error.
WORKFLOW_TIMEOUT_SECONDS = 80
# Short status checks: results surface within half a second of completion, and no
# HTTP connection is held open long enough to hit a gateway timeout.
POLL_INTERVAL_SECONDS = 0.5
TERMINAL_FAILURES = {"FAILED", "CANCELED", "TERMINATED", "TIMED_OUT"}

logger = logging.getLogger("uvicorn.error")


class AIUnavailable(RuntimeError):
    pass


class InvalidAIResponse(RuntimeError):
    pass


class WorkflowFailed(RuntimeError):
    pass


AI_ERRORS = (
    AIUnavailable,
    InvalidAIResponse,
    WorkflowFailed,
    MistralError,
    NoResponseError,
    HTTPError,
    TimeoutError,
    ValueError,
)


class ExtractedItem(BaseModel):
    model_config = ConfigDict(extra="forbid")

    key: Literal["passengers", "trains", "delay", "cancelled", "teams", "recovery"]
    value: str | None = Field(max_length=160)
    status: Literal["confirmed", "estimated", "unknown"]
    source: str = Field(max_length=100)


class Extraction(BaseModel):
    model_config = ConfigDict(extra="forbid")

    items: list[ExtractedItem] = Field(min_length=6, max_length=6)


def error_message(exc: Exception) -> str:
    if isinstance(exc, AIUnavailable):
        return str(exc)
    if isinstance(exc, WorkflowFailed):
        return (
            "The AI workflow failed. Check that the worker is running (make start-worker) "
            "then retry; your data is preserved."
        )
    if isinstance(exc, (InvalidAIResponse, ValueError)):
        return "The AI response could not be validated. Retry."
    if isinstance(exc, TimeoutError):
        return (
            "The AI workflow did not respond in time. Check that the worker is running "
            "(make start-worker); your data is preserved."
        )
    status = getattr(exc, "status_code", None)
    if status in {401, 403}:
        return "Mistral access denied. Check the MISTRAL_API_KEY on the server."
    if status == 429:
        return "Mistral rate limit reached. Wait and retry."
    if status in {400, 404, 422}:
        return (
            "The AI workflow is missing or rejected the request. "
            "Start the worker with make start-worker."
        )
    return "The AI service is unavailable. Retry; your data is preserved."


class AIService:
    def __init__(
        self,
        api_key: str,
        server_url: str = "https://api.mistral.ai",
        deployment_name: str | None = None,
    ) -> None:
        self.api_key = api_key
        self.server_url = server_url
        self.deployment_name = deployment_name or None
        self.data_path: Path = DEFAULT_DATA_PATH
        self._client: Any = None

    @property
    def available(self) -> bool:
        return bool(self.api_key)

    def _workflows_client(self) -> Any:
        if self._client is None:
            self._client = get_mistral_client(
                api_key=self.api_key, server_url=self.server_url
            )
        return self._client

    async def complete(self, task: Task, messages: prompts.Messages) -> str:
        if not self.available:
            raise AIUnavailable(
                "Set MISTRAL_API_KEY in .env, then restart the server. "
                "The sample data remains viewable; no AI response is simulated."
            )
        client = self._workflows_client()
        options: dict[str, Any] = {}
        if self.deployment_name:
            options["deployment_name"] = self.deployment_name
        # A unique ID per request keeps concurrent executions distinguishable.
        execution_id = f"aiguilleur-{task}-{uuid.uuid4().hex}"
        started = perf_counter()
        logger.info("AI workflow started: task=%s execution_id=%s", task, execution_id)
        await client.workflows.execute_workflow_async(
            workflow_identifier=WORKFLOW_NAMES[task],
            execution_id=execution_id,
            input={"messages": messages},
            timeout_ms=15000,
            **options,
        )
        try:
            execution = await asyncio.wait_for(
                self._wait_for(client, execution_id), timeout=WORKFLOW_TIMEOUT_SECONDS
            )
        except TimeoutError:
            logger.warning(
                "AI workflow timed out: task=%s execution_id=%s elapsed=%.2fs",
                task,
                execution_id,
                perf_counter() - started,
            )
            with contextlib.suppress(*AI_ERRORS):
                await client.workflows.executions.terminate_workflow_execution_async(
                    execution_id=execution_id, timeout_ms=10000
                )
            raise
        result = getattr(execution, "result", None)
        if not isinstance(result, dict) or not isinstance(result.get("content"), str):
            raise WorkflowFailed("Workflow returned no result")
        content = result["content"].strip()
        if not content:
            raise InvalidAIResponse("Empty completion")
        if result.get("task") != task:
            raise InvalidAIResponse("Unexpected workflow task")
        if result.get("model") != MODEL:
            raise InvalidAIResponse("Unexpected model")
        logger.info(
            "AI workflow completed: task=%s execution_id=%s elapsed=%.2fs",
            task,
            execution_id,
            perf_counter() - started,
        )
        return content

    @staticmethod
    async def _wait_for(client: Any, execution_id: str) -> Any:
        while True:
            execution = await client.workflows.executions.get_workflow_execution_async(
                execution_id=execution_id, timeout_ms=15000
            )
            status = str(execution.status or "").upper()
            if status == "COMPLETED":
                return execution
            if status in TERMINAL_FAILURES:
                raise WorkflowFailed(f"Workflow {status.lower()}")
            await asyncio.sleep(POLL_INTERVAL_SECONDS)

    async def summarize_incident(self, incident: dict, related: list[dict]) -> str:
        return await self.complete(
            "incident_summary", prompts.incident_summary_messages(incident, related)
        )

    async def summarize_call(self, call: dict) -> str:
        return await self.complete("call_summary", prompts.call_summary_messages(call))

    async def extract_impact(self, incident: dict) -> list[dict]:
        raw = await self.complete("impact", prompts.impact_messages(incident))
        extraction = Extraction.model_validate_json(raw)
        by_key: dict[str, ExtractedItem] = {item.key: item for item in extraction.items}
        if set(by_key) != set(KPI_KEYS):
            raise InvalidAIResponse("Missing or duplicated KPI")
        valid_sources = {"header", *(event["id"] for event in incident["events"])}
        result = []
        definitions = load_document(self.data_path)["kpi_definitions"]
        for definition in definitions:
            key, label = definition["key"], definition["label"]
            item = by_key[key]
            if item.status == "unknown":
                item.value, item.source = None, ""
            elif not item.value or item.source not in valid_sources:
                raise InvalidAIResponse("KPI without valid source")
            result.append({**item.model_dump(), "label": label})
        return result

    async def chat_incident(
        self,
        incident: dict,
        related: list[dict],
        question: str,
        history: list[dict],
    ) -> str:
        return await self.complete(
            "incident_chat",
            prompts.incident_chat_messages(incident, related, question, history),
        )

    async def chat_call(self, call: dict, question: str, history: list[dict]) -> str:
        return await self.complete(
            "call_chat", prompts.call_chat_messages(call, question, history)
        )
