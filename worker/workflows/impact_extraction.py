"""Extracts the six incident KPIs as JSON from the communications."""

from mistralai import workflows

from worker.model_call import complete_llm
from worker.workflow_types import WORKFLOW_NAMES, LLMRequest, LLMResult


@workflows.workflow.define(
    name=WORKFLOW_NAMES["impact"],
    workflow_display_name="L'AIGUILLEUR · Impact extraction",
    workflow_description="Extracts the six incident KPIs as JSON from the communications.",
)
class ImpactExtractionWorkflow:
    @workflows.workflow.entrypoint
    async def run(self, request: LLMRequest) -> LLMResult:
        return await complete_llm(request, task="impact", structured=True)
