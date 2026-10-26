"""Shared sandbox-safe model call used by the five feature workflows.

Network I/O is performed by the Mistral plugin activity, not this helper.
The model is fixed here and only impact extraction requests JSON output.
"""

import mistralai.workflows.plugins.mistralai as workflows_mistralai
from mistralai import workflows

from backend.prompts import MODEL
from worker.workflow_types import ChatMessage, LLMRequest, LLMResult, Task

# Short factual answers; impact needs room for all six validated JSON items.
MAX_TOKENS_BY_TASK: dict[Task, int] = {
    "incident_summary": 256,
    "call_summary": 320,
    "impact": 512,
    "incident_chat": 256,
    "call_chat": 256,
}


def _plugin_message(
    message: ChatMessage,
) -> workflows_mistralai.ChatCompletionRequestMessage:
    if message.role == "system":
        return workflows_mistralai.SystemMessage(content=message.content)
    if message.role == "assistant":
        return workflows_mistralai.AssistantMessage(content=message.content)
    return workflows_mistralai.UserMessage(content=message.content)


def _answer_text(content: object) -> str:
    """Keep only the final answer; reasoning chunks are never returned."""
    if isinstance(content, str):
        return content.strip()
    parts = [getattr(chunk, "text", None) for chunk in content or []]  # type: ignore[attr-defined]
    return "\n".join(part for part in parts if isinstance(part, str)).strip()


async def complete_llm(
    request: LLMRequest, *, task: Task, structured: bool = False
) -> LLMResult:
    completion = workflows_mistralai.ChatCompletionRequest(
        model=MODEL,
        messages=[_plugin_message(message) for message in request.messages],
        response_format=(
            workflows_mistralai.ResponseFormat(type="json_object")
            if structured
            else None
        ),
        max_tokens=MAX_TOKENS_BY_TASK[task],
        reasoning_effort="none",
    )
    response = await workflows_mistralai.mistralai_chat_complete(completion)
    if not response.choices:
        raise workflows.WorkflowError(
            "Empty completion", type="empty_completion", non_retryable=True
        )
    choice = response.choices[0]
    if choice.finish_reason == "length":
        raise workflows.WorkflowError(
            "Truncated completion", type="truncated_completion", non_retryable=True
        )
    content = _answer_text(choice.message.content if choice.message else None)
    if not content:
        raise workflows.WorkflowError(
            "Empty completion", type="empty_completion", non_retryable=True
        )
    return LLMResult(task=task, model=response.model or MODEL, content=content)
