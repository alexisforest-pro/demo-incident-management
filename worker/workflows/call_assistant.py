"""Answers questions from a call's transcript and summary."""

from mistralai import workflows

from worker.model_call import complete_llm
from worker.workflow_types import WORKFLOW_NAMES, LLMRequest, LLMResult


@workflows.workflow.define(
    name=WORKFLOW_NAMES["call_chat"],
    workflow_display_name="L'AIGUILLEUR · Call assistant",
    workflow_description="Answers questions from a call's transcript and summary.",
)
class CallAssistantWorkflow:
    @workflows.workflow.entrypoint
    async def run(self, request: LLMRequest) -> LLMResult:
        return await complete_llm(request, task="call_chat")
