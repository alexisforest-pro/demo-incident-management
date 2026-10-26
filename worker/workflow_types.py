"""Pure request/result contracts and feature-to-workflow routing."""

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

Task = Literal[
    "incident_summary", "call_summary", "impact", "incident_chat", "call_chat"
]

WORKFLOW_NAMES: dict[Task, str] = {
    "incident_summary": "aiguilleur-incident-summary",
    "call_summary": "aiguilleur-call-summary",
    "impact": "aiguilleur-impact-extraction",
    "incident_chat": "aiguilleur-incident-assistant",
    "call_chat": "aiguilleur-call-assistant",
}


class ChatMessage(BaseModel):
    role: Literal["system", "user", "assistant"]
    content: str = Field(min_length=1)


class LLMRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    messages: list[ChatMessage] = Field(min_length=1)


class LLMResult(BaseModel):
    task: Task
    model: str
    content: str
