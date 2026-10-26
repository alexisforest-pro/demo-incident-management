"""Local async workflows: completed call → summary → impact extraction."""

import asyncio
import logging
from collections.abc import Coroutine
from datetime import UTC, datetime
from typing import Any

from .ai_requests import AI_ERRORS, AIService, error_message
from .storage import Store, find_call

logger = logging.getLogger(__name__)


def timestamp() -> str:
    return datetime.now(UTC).isoformat()


class Jobs:
    def __init__(self, store: Store, ai: AIService) -> None:
        self.store = store
        self.ai = ai
        self.tasks: set[asyncio.Task] = set()
        self.impact_tasks: dict[str, asyncio.Task] = {}

    def spawn(self, coroutine: Coroutine[Any, Any, None]) -> asyncio.Task:
        task = asyncio.create_task(coroutine)
        self.tasks.add(task)
        task.add_done_callback(self._finished)
        return task

    def _finished(self, task: asyncio.Task) -> None:
        self.tasks.discard(task)
        if not task.cancelled() and task.exception():
            logger.error(
                "Local workflow failed unexpectedly: %s",
                type(task.exception()).__name__,
            )

    async def close(self) -> None:
        pending = list(self.tasks)
        for task in pending:
            task.cancel()
        await asyncio.gather(*pending, return_exceptions=True)

    def start_impact(self, incident_id: str) -> None:
        def mark_running(incident: dict) -> None:
            incident["impact"]["status"] = "running"
            incident["impact"]["error"] = None

        self.store.update(incident_id, mark_running)
        task = self.impact_tasks.get(incident_id)
        if task is None or task.done():
            self.impact_tasks[incident_id] = self.spawn(self._impact(incident_id))

    def _publish_impact(
        self, incident_id: str, revision: int, items: list[dict]
    ) -> bool:
        applied = False

        def apply(incident: dict) -> None:
            nonlocal applied
            if incident["revision"] != revision:
                return
            incident["impact"] = {
                "items": items,
                "origin": "mistral",
                "updated_at": timestamp(),
                "revision": revision,
                "status": "ready",
                "error": None,
            }
            applied = True

        self.store.update(incident_id, apply)
        return applied

    def _fail_impact(self, incident_id: str, revision: int, message: str) -> bool:
        applied = False

        def fail(incident: dict) -> None:
            nonlocal applied
            if incident["revision"] == revision:
                incident["impact"]["status"] = "error"
                incident["impact"]["error"] = message
                applied = True

        self.store.update(incident_id, fail)
        return applied

    async def _impact(self, incident_id: str) -> None:
        while True:
            snapshot = self.store.get(incident_id)
            revision = snapshot["revision"]
            try:
                items = await self.ai.extract_impact(snapshot)
            except AI_ERRORS as exc:
                if self._fail_impact(incident_id, revision, error_message(exc)):
                    return
                continue
            if self._publish_impact(incident_id, revision, items):
                return
            # New information arrived during extraction; only the latest revision is published.

    def start_call_summary(self, incident_id: str, call_id: str) -> None:
        self.spawn(self._call_summary(incident_id, call_id))

    async def _call_summary(self, incident_id: str, call_id: str) -> None:
        call = find_call(self.store.get(incident_id), call_id)
        try:
            summary = await self.ai.summarize_call(call)
        except AI_ERRORS as exc:
            message = error_message(exc)

            def fail(incident: dict) -> None:
                current = find_call(incident, call_id)
                current["status"] = "error"
                current["error"] = message

            self.store.update(incident_id, fail)
            return

        def apply(incident: dict) -> None:
            current = find_call(incident, call_id)
            current["summary"] = summary
            current["summary_source"] = "mistral"
            current["summary_updated_at"] = timestamp()
            current["status"] = "termine"
            current["error"] = None
            incident["revision"] += 1

        self.store.update(incident_id, apply)
        self.start_impact(incident_id)
