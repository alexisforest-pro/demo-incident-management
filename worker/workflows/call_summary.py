"""Summarizes the facts, decisions and actions of a completed call."""

from mistralai import workflows

from worker.model_call import complete_llm
from worker.workflow_types import WORKFLOW_NAMES, LLMRequest, LLMResult


@workflows.workflow.define(
    name=WORKFLOW_NAMES["call_summary"],
    workflow_display_name="L'AIGUILLEUR · Call summary",
    workflow_description="Summarizes the facts, decisions and actions of a completed call.",
)
class CallSummaryWorkflow:
    @workflows.workflow.entrypoint
    async def run(self, request: LLMRequest) -> LLMResult:
        return await complete_llm(request, task="call_summary")
