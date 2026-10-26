"""Answers questions from the full incident context."""

from mistralai import workflows

from worker.model_call import complete_llm
from worker.workflow_types import WORKFLOW_NAMES, LLMRequest, LLMResult


@workflows.workflow.define(
    name=WORKFLOW_NAMES["incident_chat"],
    workflow_display_name="L'AIGUILLEUR · Incident assistant",
    workflow_description="Answers questions from the full incident context.",
)
class IncidentAssistantWorkflow:
    @workflows.workflow.entrypoint
    async def run(self, request: LLMRequest) -> LLMResult:
        return await complete_llm(request, task="incident_chat")
