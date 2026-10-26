"""Focused demo checks; no network calls or microphone permissions required."""

import asyncio
import json
import time
from copy import deepcopy
from datetime import UTC, date, datetime
from shutil import copyfile
from types import SimpleNamespace

import duckdb
import pytest
from fastapi.testclient import TestClient

from backend.ai_requests import MODEL, AIService, InvalidAIResponse, context_for
from backend.background_tasks import Jobs
from backend.data import DEFAULT_DATA_PATH
from backend.data.schema import KPI_KEYS, DataError, load_document
from backend.server import create_app
from backend.statistics import (
    DEFAULT_STATISTICS_PATH,
    generate_fixture,
    read_statistics,
)
from backend.storage import Conflict, Store, find_call
from worker.workflow_types import WORKFLOW_NAMES

INCIDENT = "INC-2026-041"
URL = f"/api/incidents/{INCIDENT}"
DOCUMENT = load_document(DEFAULT_DATA_PATH)
KPI_LABELS = {item["key"]: item["label"] for item in DOCUMENT["kpi_definitions"]}


@pytest.fixture
def data_path(tmp_path):
    path = tmp_path / "incidents.json"
    copyfile(DEFAULT_DATA_PATH, path)
    return path


class FakeAI(AIService):
    def __init__(self):
        super().__init__("test-only")
        self.context = None

    async def extract_impact(self, incident):
        source = incident["events"][-1]["id"]
        return [
            {
                "key": key,
                "label": label,
                "value": "2,400" if key == "passengers" else "1",
                "status": "estimated",
                "source": source,
            }
            for key, label in KPI_LABELS.items()
        ]

    async def summarize_call(self, call):
        return "Call summary: 2,400 passengers; next step to be confirmed."

    async def summarize_incident(self, incident, related):
        self.context = context_for(incident, related)
        return "Updated summary: 2,400 passengers affected."

    async def chat_incident(self, incident, related, question, history):
        self.context = context_for(incident, related)
        return "The latest status report is available in the communications."

    async def chat_call(self, call, question, history):
        self.context = call["transcript"]
        return "The call reports 2,400 passengers."


def wait_ready(client, predicate):
    for _ in range(100):
        incident = client.get(URL).json()
        if predicate(incident):
            return incident
        time.sleep(0.01)
    raise AssertionError("Local workflow did not finish")


def test_data_navigation_validation_and_persistence(data_path):
    path = data_path
    with TestClient(create_app(path, FakeAI())) as client:
        incidents = client.get("/api/incidents").json()["incidents"]
        ongoing = [item for item in incidents if item["status"] == "In progress"]
        assert len(ongoing) == 4
        assert len(incidents) == len(DOCUMENT["incidents"])
        assert all(len(incident["impact"]["items"]) == 6 for incident in incidents)
        assert client.get("/").status_code == 200
        assert client.get("/archives/REX-2025-184").status_code == 200
        config = client.get("/api/config").json()
        assert config["model"] == MODEL
        assert config["storage"] == "json"
        assert config["kpi_definitions"] == DOCUMENT["kpi_definitions"]
        assert "test-only" not in json.dumps(client.get("/api/config").json())
        assert (
            client.post(URL + "/messages", json={"content": "   "}).status_code == 422
        )
        assert (
            client.post(URL + "/related", json={"related_ids": [INCIDENT]}).status_code
            == 409
        )
        assert (
            client.post(URL + "/related", json={"related_ids": ["missing"]}).status_code
            == 404
        )
        assert (
            client.post(
                URL + "/related", json={"related_ids": ["INC-2026-042", "INC-2026-042"]}
            ).status_code
            == 422
        )
        assert (
            client.post(
                URL + "/related", json={"related_ids": ["INC-2026-042"]}
            ).status_code
            == 200
        )
        assert (
            client.post(
                URL + "/messages",
                json={"content": "2,400 passengers."},
                headers={"Origin": "https://other.example"},
            ).status_code
            == 403
        )
    with TestClient(create_app(path, FakeAI())) as client:
        assert client.get(URL).json()["related_ids"] == ["INC-2026-042"]


def test_message_trigger_manual_summary_and_full_incident_context(data_path):
    ai = FakeAI()
    with TestClient(create_app(data_path, ai)) as client:
        initial = client.get(URL).json()
        added = client.post(
            URL + "/messages", json={"content": "New status report: 2,400 passengers."}
        ).json()
        assert added["revision"] == initial["revision"] + 1
        assert added["impact"]["status"] == "running"
        ready = wait_ready(
            client, lambda incident: incident["impact"]["status"] == "ready"
        )
        assert ready["impact"]["revision"] == ready["revision"]
        assert ready["impact"]["items"][0]["value"] == "2,400"
        assert ready["summary"] == initial["summary"]
        summary = client.post(URL + "/summary", json={}).json()["incident"]
        assert summary["summary_source"] == "mistral"
        assert summary["summary_revision"] == summary["revision"]
        response = client.post(
            URL + "/chat",
            json={"question": "What is the latest status report?", "history": []},
        )
        assert response.status_code == 200
        context = json.loads(ai.context)
        assert context["header"]["id"] == INCIDENT
        assert (
            context["communications"][-1]["content"]
            == "New status report: 2,400 passengers."
        )
        assert any(event.get("summary") for event in context["communications"])
        assert context["related_incidents"]


def test_call_summary_then_impact_and_transcript_chat(data_path):
    ai = FakeAI()
    with TestClient(create_app(data_path, ai)) as client:
        result = client.post(
            URL + "/calls", json={"title": "Coordination call", "synthetic": True}
        ).json()
        call = result["call"]
        call_url = URL + f"/calls/{call['id']}"
        assert call["status"] == "en_cours" and call["synthetic"]
        assert call["transcript"]
        assert (
            client.post(call_url + "/finish", json={"transcript": " "}).status_code
            == 422
        )
        transcript = (
            "00:12 — Alex: 2,400 passengers, 15 trains, 4 cancellations; delay 60 min."
        )
        response = client.post(
            call_url + "/finish",
            json={"transcript": transcript, "duration_seconds": 180},
        )
        assert response.status_code == 200
        ready = wait_ready(
            client,
            lambda incident: (
                find_call(incident, call["id"])["status"] == "termine"
                and incident["impact"]["status"] == "ready"
            ),
        )
        ended = find_call(ready, call["id"])
        assert ended["summary"] and ended["transcript"] == transcript
        assert ended["duration_seconds"] == 180
        assert ready["impact"]["revision"] == ready["revision"]
        assert (
            client.post(
                call_url + "/finish", json={"transcript": transcript}
            ).status_code
            == 409
        )
        assert (
            client.post(
                call_url + "/chat", json={"question": "What is the status report?"}
            ).status_code
            == 200
        )
        assert ai.context == transcript
        new_call = client.post(URL + "/calls", json={"synthetic": False}).json()["call"]
        assert client.post(URL + "/calls", json={"synthetic": False}).status_code == 409
        cancelled = client.post(URL + f"/calls/{new_call['id']}/cancel", json={}).json()
        assert find_call(cancelled, new_call["id"])["status"] == "annule"


def test_ai_unavailable_keeps_data_and_recovers_interrupted_work(data_path):
    path = data_path
    with TestClient(create_app(path, AIService(""))) as client:
        assert client.get("/api/config").json()["ai_available"] is False
        client.post(URL + "/messages", json={"content": "Message saved offline."})
        failed = wait_ready(
            client, lambda incident: incident["impact"]["status"] == "error"
        )
        assert failed["events"][-1]["content"] == "Message saved offline."
        assert "MISTRAL_API_KEY" in failed["impact"]["error"]
        assert client.post(URL + "/summary", json={}).status_code == 503
        call = client.post(URL + "/calls", json={"synthetic": False}).json()["call"]
        client.post(
            URL + f"/calls/{call['id']}/finish",
            json={"transcript": "Transcript saved."},
        )
        failed = wait_ready(
            client,
            lambda incident: find_call(incident, call["id"])["status"] == "error",
        )
        assert find_call(failed, call["id"])["transcript"] == "Transcript saved."
        client.app.state.store.update(
            INCIDENT, lambda incident: incident["impact"].update(status="running")
        )
    with TestClient(create_app(path, FakeAI())) as client:
        assert client.get(URL).json()["impact"]["status"] == "error"
        client.post(URL + "/impact", json={})
        wait_ready(client, lambda incident: incident["impact"]["status"] == "ready")
        client.post(
            URL + f"/calls/{call['id']}/finish",
            json={"transcript": "Transcript saved."},
        )
        wait_ready(
            client,
            lambda incident: find_call(incident, call["id"])["status"] == "termine",
        )


def test_impact_workflow_discards_stale_revision(data_path):
    async def scenario():
        first_started, release = asyncio.Event(), asyncio.Event()

        class SlowAI(FakeAI):
            count = 0

            async def extract_impact(self, incident):
                self.count += 1
                if self.count == 1:
                    first_started.set()
                    await release.wait()
                return await super().extract_impact(incident)

        store, ai = Store(data_path), SlowAI()
        jobs = Jobs(store, ai)
        try:
            jobs.start_impact(INCIDENT)
            await first_started.wait()
            store.update(
                INCIDENT,
                lambda incident: incident.update(revision=incident["revision"] + 1),
            )
            jobs.start_impact(INCIDENT)
            release.set()
            await asyncio.gather(*jobs.tasks)
            latest = store.get(INCIDENT)
            assert latest["impact"]["revision"] == latest["revision"]
            assert ai.count == 2
        finally:
            await jobs.close()

    asyncio.run(scenario())


def test_json_is_live_backbone_and_shared_defaults(data_path):
    document = load_document(data_path)
    document["operator"]["name"] = "Test operator"
    document["call_defaults"]["title"] = "JSON call"
    document["synthetic_call"]["transcript"] = (
        "00:00 — {operator_name}: 3,000 passengers, confirmed by {incident_owner}."
    )
    document["kpi_definitions"][0]["label"] = "Passengers affected"
    data_path.write_text(
        json.dumps(document, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    with TestClient(create_app(data_path, FakeAI())) as client:
        document = load_document(data_path)
        document["incidents"][0]["title"] = "Title edited directly in JSON"
        document["incidents"][0]["revision"] += 1
        document["incidents"].append(
            {
                **deepcopy(document["incidents"][0]),
                "id": "INC-2026-045",
                "related_ids": [],
            }
        )
        data_path.write_text(
            json.dumps(document, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        assert client.get(URL).json()["title"] == "Title edited directly in JSON"
        assert (
            len(client.get("/api/incidents").json()["incidents"])
            == len(DOCUMENT["incidents"]) + 1
        )
        assert (
            client.get("/api/config").json()["kpi_definitions"][0]["label"]
            == "Passengers affected"
        )
        result = client.post(URL + "/calls", json={"synthetic": True}).json()
        call = result["call"]
        assert call["title"] == "JSON call"
        assert call["author"] == "Test operator"
        assert "3,000 passengers" in call["transcript"]
        assert "Giuliana Ferrandi" in call["transcript"]
        client.post(
            URL + "/messages", json={"content": "Message saved in the JSON file."}
        )
        ready = wait_ready(
            client, lambda incident: incident["impact"]["status"] == "ready"
        )
        saved = load_document(data_path)
        assert (
            saved["incidents"][0]["events"][-1]["content"]
            == "Message saved in the JSON file."
        )
        assert ready["events"][-1]["author"] == "Test operator"
        assert (
            find_call(saved["incidents"][0], call["id"])["transcript"]
            == call["transcript"]
        )
        assert saved["synthetic_call"] == document["synthetic_call"]


def test_json_validation_preserves_invalid_file_and_rejects_conflicts(
    data_path, tmp_path
):
    store = Store(data_path)
    previous = data_path.read_bytes()
    with pytest.raises(DataError):
        store.update(
            INCIDENT, lambda incident: incident.update(related_ids=["missing"])
        )
    assert data_path.read_bytes() == previous
    assert not list(data_path.parent.glob(".*.tmp"))

    def edit_during_update(incident):
        external = load_document(data_path)
        external["incidents"][1]["title"] = "Concurrent edit kept"
        data_path.write_text(json.dumps(external, ensure_ascii=False), encoding="utf-8")
        incident["title"] = "Edit to be rejected"

    with pytest.raises(Conflict):
        store.update(INCIDENT, edit_during_update)
    assert Store(data_path).all()[1]["title"] == "Concurrent edit kept"
    assert store.get(INCIDENT)["title"] != "Edit to be rejected"
    assert not list(data_path.parent.glob(".*.tmp"))
    with pytest.raises(DataError):
        Store(tmp_path / "missing.json")
    assert not (tmp_path / "missing.json").exists()
    data_path.write_text('{"incidents":', encoding="utf-8")
    invalid = data_path.read_bytes()
    with pytest.raises(DataError):
        store.get(INCIDENT)
    assert data_path.read_bytes() == invalid


def test_all_llm_requests_run_through_named_workflows(data_path):
    starts = []
    document = load_document(data_path)
    document["kpi_definitions"][0]["label"] = "Custom JSON label"
    data_path.write_text(json.dumps(document, ensure_ascii=False), encoding="utf-8")
    incident = deepcopy(document["incidents"][0])
    items = [
        {"key": key, "value": "1", "status": "confirmed", "source": "EVT-041-04"}
        for key in KPI_LABELS
    ]

    results = {}
    polls = []

    class FakeExecutions:
        async def get_workflow_execution_async(self, execution_id, **kwargs):
            polls.append(execution_id)
            if polls.count(execution_id) == 1:
                return SimpleNamespace(status="RUNNING", result=None)
            return SimpleNamespace(status="COMPLETED", result=results[execution_id])

    class FakeWorkflows:
        executions = FakeExecutions()

        async def execute_workflow_async(self, **kwargs):
            starts.append(kwargs)
            content = (
                json.dumps({"items": items})
                if kwargs["workflow_identifier"] == "aiguilleur-impact-extraction"
                else "Test response."
            )
            results[kwargs["execution_id"]] = {
                "task": next(
                    task
                    for task, name in WORKFLOW_NAMES.items()
                    if name == kwargs["workflow_identifier"]
                ),
                "model": MODEL,
                "content": content,
            }
            return SimpleNamespace(execution_id=kwargs["execution_id"])

    async def scenario():
        ai = AIService("test-only", deployment_name="demo-deployment")
        ai._client = SimpleNamespace(workflows=FakeWorkflows())
        ai.data_path = data_path
        await ai.summarize_incident(incident, [])
        await ai.summarize_call(incident["events"][2])
        await ai.chat_incident(incident, [], "What is the status report?", [])
        await ai.chat_call(incident["events"][2], "What are the next actions?", [])
        result = await ai.extract_impact(incident)
        assert len(result) == len(KPI_KEYS)
        assert result[0]["label"] == "Custom JSON label"
        assert [start["workflow_identifier"] for start in starts] == [
            "aiguilleur-incident-summary",
            "aiguilleur-call-summary",
            "aiguilleur-incident-assistant",
            "aiguilleur-call-assistant",
            "aiguilleur-impact-extraction",
        ]
        assert all(set(start["input"]) == {"messages"} for start in starts)
        assert len({start["execution_id"] for start in starts}) == len(starts)
        assert set(polls) == set(results)
        assert all(start["deployment_name"] == "demo-deployment" for start in starts)
        extraction_context = json.loads(starts[-1]["input"]["messages"][-1]["content"])
        assert all(
            event.get("status") != "en_cours"
            for event in extraction_context["communications"]
        )
        items[0]["source"] = "invented-event"
        with pytest.raises(InvalidAIResponse):
            await ai.extract_impact(incident)

    asyncio.run(scenario())


def test_named_workflows_use_the_plugin_and_are_all_discovered(monkeypatch):
    from mistralai.workflows import WorkflowError, execute_workflow
    from mistralai.workflows.core.definition.workflow_definition import (
        get_workflow_definition,
    )
    from pydantic import ValidationError

    from worker import model_call
    from worker.start import discover_workflows
    from worker.workflow_types import LLMRequest

    discovered = discover_workflows()
    by_name = {get_workflow_definition(cls).name: cls for cls in discovered}
    assert len(discovered) == 5
    assert set(by_name) == set(WORKFLOW_NAMES.values())
    seen = []
    mode = "success"

    async def fake_chat_complete(params):
        seen.append(params)
        message = SimpleNamespace(
            content=[
                SimpleNamespace(type="thinking", thinking=[]),
                SimpleNamespace(type="text", text="Workflow summary."),
            ]
        )
        choices = [SimpleNamespace(finish_reason="stop", message=message)]
        if mode == "empty":
            choices = []
        elif mode == "truncated":
            choices[0].finish_reason = "length"
        elif mode == "blank":
            message.content = " "
        return SimpleNamespace(model=params.model, choices=choices)

    monkeypatch.setattr(
        model_call.workflows_mistralai, "mistralai_chat_complete", fake_chat_complete
    )
    messages = [
        {"role": "system", "content": "Instructions"},
        {"role": "user", "content": "Data"},
        {"role": "assistant", "content": "Previous answer"},
    ]
    request = LLMRequest(messages=messages)
    # Callers cannot turn an assistant into another task or change output mode.
    with pytest.raises(ValidationError):
        LLMRequest(messages=messages, task="impact", structured=True)

    async def scenario():
        nonlocal mode
        for task, name in WORKFLOW_NAMES.items():
            result = await asyncio.wait_for(
                execute_workflow(by_name[name], params=request), timeout=15
            )
            assert result.task == task
            assert result.model == MODEL and result.content == "Workflow summary."
            completion = seen[-1]
            assert completion.model == MODEL
            assert completion.reasoning_effort == "none"
            assert completion.max_tokens == model_call.MAX_TOKENS_BY_TASK[task]
            if task == "impact":
                assert completion.response_format.type == "json_object"
            else:
                assert completion.response_format is None
            assert [type(m).__name__ for m in completion.messages] == [
                "SystemMessage",
                "UserMessage",
                "AssistantMessage",
            ]
        for failure_mode in ("empty", "truncated", "blank"):
            mode = failure_mode
            with pytest.raises(WorkflowError):
                await asyncio.wait_for(
                    execute_workflow(
                        by_name[WORKFLOW_NAMES["call_summary"]], params=request
                    ),
                    timeout=15,
                )

    asyncio.run(scenario())


def test_compact_prompts_preserve_full_context_and_chat_history():
    from backend import prompts

    incident = deepcopy(DOCUMENT["incidents"][0])
    related = [DOCUMENT["incidents"][2]]
    context = json.loads(prompts.context_for(incident, related))
    assert context["communications"] == incident["events"]
    assert context["header"]["description"] == incident["description"]
    assert context["incident_summary"] == incident["summary"]
    assert context["impact"] == incident["impact"]
    assert context["similar_past_incidents"] == incident["history"]
    assert context["related_incidents"][0]["summary"] == related[0]["summary"]
    history = [
        {"role": "user", "content": "Previous question"},
        {"role": "assistant", "content": "Previous answer"},
    ]
    messages = prompts.incident_chat_messages(incident, related, "And now?", history)
    assert messages[-3:-1] == history
    assert messages[-1]["content"] == "And now?"
    assert "80 words maximum" in messages[0]["content"]


def test_rex_archives_action_tracking_and_assistant_context(data_path):
    ai = FakeAI()
    with TestClient(create_app(data_path, ai)) as client:
        records = client.get("/api/incidents").json()["incidents"]
        reviews = {record["id"]: record for record in records if record.get("rex")}
        referenced = {past["id"] for record in records for past in record["history"]}
        assert set(reviews) == referenced and len(reviews) == 12
        for identifier, record in reviews.items():
            assert record["status"] == "Closed" and record["ended_at"]
            assert record["synthetic"] and record["rex"]["synthetic"]
            assert record["summary_source"] == record["impact"]["origin"] == "demo"
            assert len(record["rex"]["five_whys"]) == 5
            assert record["rex"]["action_items"] and record["events"]
            assert record["history"] == record["related_ids"] == []
            archive = client.get(f"/archives/{identifier}", follow_redirects=False)
            assert archive.status_code == 307
            assert archive.headers["location"] == f"/#rex/{identifier}"
        record = reviews["REX-2025-184"]
        url = "/api/incidents/REX-2025-184"
        action = record["rex"]["action_items"][0]
        action_url = f"{url}/rex/actions/{action['id']}"
        assert client.post(action_url, json={"status": "invalid"}).status_code == 422
        assert (
            client.post(
                url + "/rex/actions/missing", json={"status": "termine"}
            ).status_code
            == 404
        )
        assert (
            client.post(
                URL + "/rex/actions/missing", json={"status": "termine"}
            ).status_code
            == 404
        )
        assert client.get("/archives/missing").status_code == 404
        assert client.get(f"/archives/{INCIDENT}").status_code == 404
        assert (
            client.post(
                action_url,
                json={"status": "termine"},
                headers={"Origin": "https://other.example"},
            ).status_code
            == 403
        )
        updated = client.post(action_url, json={"status": "termine"}).json()
        assert updated["rex"]["action_items"][0]["status"] == "termine"
        assert updated["events"] == record["events"]
        assert updated["impact"] == record["impact"]
        assert (
            client.post(
                url + "/chat", json={"question": "What is the root cause?"}
            ).status_code
            == 200
        )
        context = json.loads(ai.context)
        assert context["experience_review"] == updated["rex"]
        assert context["header"]["ended_at"] == record["ended_at"]
        call = next(event for event in record["events"] if event["type"] == "call")
        assert (
            client.post(
                f"{url}/calls/{call['id']}/chat",
                json={"question": "What is the status report?"},
            ).status_code
            == 200
        )
        assert ai.context == call["transcript"]
    assert (
        Store(data_path).get(record["id"])["rex"]["action_items"][0]["status"]
        == "termine"
    )


def test_rex_validation_preserves_data_on_invalid_review(data_path):
    store = Store(data_path)
    previous = data_path.read_bytes()
    identifier = "REX-2025-184"
    for change in (
        lambda record: record["rex"]["five_whys"].pop(),
        lambda record: record["rex"]["action_items"][0].update(deadline="not-a-date"),
        lambda record: record["rex"]["action_items"].append(
            deepcopy(record["rex"]["action_items"][0])
        ),
        lambda record: record.update(status="In progress"),
        lambda record: record.update(ended_at="2025-11-18T10:00:00"),
    ):
        with pytest.raises(DataError):
            store.update(identifier, change)
        assert data_path.read_bytes() == previous
    with pytest.raises(DataError):
        store.update(INCIDENT, lambda record: record["history"][0].update(id="missing"))
    assert data_path.read_bytes() == previous


@pytest.fixture
def statistics_path(tmp_path):
    path = tmp_path / "incident_statistics.parquet"
    with duckdb.connect(config={"TimeZone": "UTC"}) as connection:
        connection.sql(
            """
            SELECT * FROM (VALUES
                ('a', TIMESTAMPTZ '2026-01-01 00:00:00+00', 'G3', true),
                ('b', TIMESTAMPTZ '2026-01-31 23:59:59.999999+00', 'G3', true),
                ('c', TIMESTAMPTZ '2026-01-15 12:00:00+00', 'G2', true),
                ('d', TIMESTAMPTZ '2026-01-16 12:00:00+00', 'G1', true),
                ('e', TIMESTAMPTZ '2026-03-01 00:00:00+00', 'G2', true),
                ('f', TIMESTAMPTZ '2026-04-01 00:30:00+02', 'G1', true),
                ('g', TIMESTAMPTZ '2026-04-01 00:00:00+00', 'G3', true)
            ) AS incidents(id, started_at, severity, synthetic)
            """
        ).to_parquet(str(path))
    return path


def test_statistics_exact_counts_empty_months_and_inclusive_utc_dates(
    data_path, statistics_path
):
    before = statistics_path.read_bytes()
    with TestClient(
        create_app(data_path, FakeAI(), statistics_path=statistics_path)
    ) as client:
        response = client.get(
            "/api/incident-statistics",
            params={"start_date": "2026-01-01", "end_date": "2026-03-31"},
        )
        assert response.status_code == 200
        assert response.json() == {
            "synthetic": True,
            "source": "incident_statistics.parquet",
            "start_date": "2026-01-01",
            "end_date": "2026-03-31",
            "available_from": "2026-01-01",
            "available_to": "2026-04-01",
            "months": [
                {"month": "2026-01", "G3": 2, "G2": 1, "G1": 1, "total": 4},
                {"month": "2026-02", "G3": 0, "G2": 0, "G1": 0, "total": 0},
                {"month": "2026-03", "G3": 0, "G2": 1, "G1": 1, "total": 2},
            ],
        }
        for start, end, expected in (
            ("2026-01-31", "2026-03-01", [1, 0, 1]),
            ("2026-01-15", "2026-01-16", [2]),
            ("2026-01-31", "2026-01-31", [1]),
            ("2026-04-01", "2026-04-01", [1]),
            ("2025-12-01", "2026-01-01", [0, 1]),
        ):
            result = client.get(
                "/api/incident-statistics",
                params={"start_date": start, "end_date": end},
            )
            assert result.status_code == 200
            assert [month["total"] for month in result.json()["months"]] == expected
    assert statistics_path.read_bytes() == before


def test_statistics_defaults_single_bounds_and_limit(
    data_path, statistics_path, monkeypatch
):
    monkeypatch.setattr("backend.statistics.utc_today", lambda: date(2026, 10, 19))
    with TestClient(
        create_app(data_path, FakeAI(), statistics_path=statistics_path)
    ) as client:
        result = client.get("/api/incident-statistics").json()
        assert result["start_date"] == "2025-11-01"
        assert result["end_date"] == "2026-10-19"
        assert len(result["months"]) == 12
        assert result["months"][0]["month"] == "2025-11"
        assert result["months"][-1]["month"] == "2026-10"
        assert sum(month["total"] for month in result["months"]) == 7
        for query, expected_start, expected_end in (
            ({"start_date": "2026-03-01"}, "2026-03-01", "2026-10-19"),
            ({"end_date": "2026-03-31"}, "2026-01-01", "2026-03-31"),
        ):
            response = client.get("/api/incident-statistics", params=query)
            assert response.status_code == 200
            assert response.json()["start_date"] == expected_start
            assert response.json()["end_date"] == expected_end
        response = client.get(
            "/api/incident-statistics",
            params={"start_date": "2016-11-01", "end_date": "2026-10-19"},
        )
        assert response.status_code == 200
        assert len(response.json()["months"]) == 120


def test_statistics_rejects_invalid_dates_order_and_oversized_periods(
    data_path, statistics_path, monkeypatch
):
    monkeypatch.setattr("backend.statistics.utc_today", lambda: date(2026, 10, 19))
    with TestClient(
        create_app(data_path, FakeAI(), statistics_path=statistics_path)
    ) as client:
        for query in (
            {"start_date": "invalid"},
            {"end_date": "2026-02-30"},
            {"start_date": "2026-1-01"},
            {"start_date": "20260101"},
            {"start_date": "2026-01-01T00:00:00Z"},
            {"end_date": "1790812800"},
            {"start_date": ""},
            {"start_date": "0000-01-01"},
            {"start_date": "2026-04-01", "end_date": "2026-03-31"},
            {"start_date": "2016-10-31", "end_date": "2026-10-19"},
            {"start_date": "2026-10-20"},
            {"end_date": "2025-12-31"},
        ):
            response = client.get("/api/incident-statistics", params=query)
            assert response.status_code == 422, query
            assert "detail" in response.json()


def test_statistics_fixture_is_synthetic_varied_past_and_reproducible(
    data_path, tmp_path
):
    path = tmp_path / "fixture.parquet"
    copyfile(DEFAULT_STATISTICS_PATH, path)
    rows = read_statistics(path)
    assert min(day for day, _ in rows) == date(2023, 11, 1)
    assert max(day for day, _ in rows) == date(2026, 10, 19)
    with duckdb.connect(config={"TimeZone": "UTC"}) as connection:
        connection.register("relation", connection.from_parquet(str(path)))
        records = connection.execute(
            "SELECT id, started_at AT TIME ZONE 'UTC', severity, synthetic FROM relation ORDER BY id"
        ).fetchall()
    assert len({row[0] for row in records}) == len(records)
    assert all(row[3] is True and row[2] in {"G1", "G2", "G3"} for row in records)
    assert all(
        datetime(2023, 11, 1, tzinfo=UTC)
        <= row[1].replace(tzinfo=UTC)
        <= datetime(2026, 10, 19, tzinfo=UTC)
        for row in records
    )
    regenerated = tmp_path / "regenerated.parquet"
    generate_fixture(regenerated)
    with duckdb.connect(config={"TimeZone": "UTC"}) as connection:
        connection.register("relation", connection.from_parquet(str(regenerated)))
        assert (
            connection.execute(
                "SELECT id, started_at AT TIME ZONE 'UTC', severity, synthetic FROM relation ORDER BY id"
            ).fetchall()
            == records
        )
    previous = regenerated.read_bytes()
    with pytest.raises(FileExistsError):
        generate_fixture(regenerated)
    assert regenerated.read_bytes() == previous
    with TestClient(create_app(data_path, FakeAI(), statistics_path=path)) as client:
        result = client.get(
            "/api/incident-statistics",
            params={"start_date": "2023-11-01", "end_date": "2026-10-19"},
        )
        assert result.status_code == 200
        months = result.json()["months"]
        assert len(months) == 36
        assert months[0]["month"] == "2023-11" and months[-1]["month"] == "2026-10"
        assert sum(month["total"] for month in months) == len(records)
        assert len({month["total"] for month in months}) > 10
        for severity in ("G3", "G2", "G1"):
            assert all(month[severity] > 0 for month in months)
            assert len({month[severity] for month in months}) > 5
        assert all(
            month["total"] == month["G3"] + month["G2"] + month["G1"]
            for month in months
        )


def test_statistics_missing_corrupt_and_invalid_files_return_503(
    data_path, tmp_path, statistics_path
):
    missing = tmp_path / "missing.parquet"
    corrupt = tmp_path / "corrupt.parquet"
    corrupt.write_bytes(b"not a parquet file")
    invalid = tmp_path / "invalid.parquet"
    with duckdb.connect(config={"TimeZone": "UTC"}) as connection:
        connection.from_parquet(str(statistics_path)).to_parquet(str(invalid))
    for path in (missing, corrupt):
        before = path.read_bytes() if path.exists() else None
        with TestClient(
            create_app(data_path, FakeAI(), statistics_path=path)
        ) as client:
            response = client.get("/api/incident-statistics")
            assert response.status_code == 503
            assert response.json() == {
                "detail": "Statistics unavailable: the Parquet file is missing, unreadable or invalid."
            }
            assert "months" not in response.json()
        assert (path.read_bytes() if path.exists() else None) == before
    for query in (
        "SELECT id, started_at, severity, false AS synthetic FROM relation",
        "SELECT id, started_at, 'G4' AS severity, synthetic FROM relation",
        "SELECT 'duplicate' AS id, started_at, severity, synthetic FROM relation",
        "SELECT id, CAST(started_at AS TIMESTAMP) AS started_at, severity, synthetic FROM relation",
        "SELECT id FROM relation",
        "SELECT * FROM relation WHERE false",
    ):
        with duckdb.connect(config={"TimeZone": "UTC"}) as connection:
            connection.register(
                "relation", connection.from_parquet(str(statistics_path))
            )
            connection.sql(query).to_parquet(str(invalid))
        before = invalid.read_bytes()
        with TestClient(
            create_app(data_path, FakeAI(), statistics_path=invalid)
        ) as client:
            response = client.get("/api/incident-statistics")
            assert response.status_code == 503, query
            assert "Statistics unavailable" in response.json()["detail"]
        assert invalid.read_bytes() == before
