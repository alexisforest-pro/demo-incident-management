"""Summarizes the incident's situation, impacts and actions on demand."""

from mistralai import workflows

from worker.model_call import complete_llm
from worker.workflow_types import WORKFLOW_NAMES, LLMRequest, LLMResult


@workflows.workflow.define(
    name=WORKFLOW_NAMES["incident_summary"],
    workflow_display_name="L'AIGUILLEUR · Incident summary",
    workflow_description="Summarizes the incident's situation, impacts and actions on demand.",
)
class IncidentSummaryWorkflow:
    @workflows.workflow.entrypoint
    async def run(self, request: LLMRequest) -> LLMResult:
        return await complete_llm(request, task="incident_summary")
