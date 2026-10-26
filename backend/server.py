"""Web server: serves the frontend and the incident API. Run with make demo."""

import os
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal
from urllib.parse import urlsplit

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field, field_validator

from .ai_requests import AI_ERRORS, MODEL, AIService, error_message
from .background_tasks import Jobs, timestamp
from .data import DEFAULT_DATA_PATH
from .data.schema import DataError
from .statistics import DEFAULT_STATISTICS_PATH, incident_statistics
from .storage import Conflict, NotFound, Store, find_call

ROOT = Path(__file__).resolve().parents[1]
STATIC = ROOT / "frontend"


class Input(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class MessageInput(Input):
    content: str = Field(min_length=1, max_length=6000)


class CallInput(Input):
    title: str | None = Field(default=None, min_length=1, max_length=180)
    synthetic: bool = False


class FinishInput(Input):
    transcript: str = Field(min_length=1, max_length=60000)
    duration_seconds: int = Field(default=0, ge=0, le=14400)


class RelatedInput(Input):
    related_ids: list[str] = Field(max_length=20)

    @field_validator("related_ids")
    @classmethod
    def unique(cls, value: list[str]) -> list[str]:
        if len(set(value)) != len(value):
            raise ValueError("Each related incident must be unique.")
        return value


class ActionStatusInput(Input):
    status: Literal["a_faire", "en_cours", "termine"]


class ChatTurn(Input):
    role: Literal["user", "assistant"]
    content: str = Field(min_length=1, max_length=8000)


class ChatInput(Input):
    question: str = Field(min_length=1, max_length=3000)
    history: list[ChatTurn] = Field(default_factory=list, max_length=20)


def create_app(
    data_path: str | Path | None = None,
    ai: AIService | None = None,
    *,
    statistics_path: str | Path | None = None,
) -> FastAPI:
    @asynccontextmanager
    async def lifespan(application: FastAPI):
        load_dotenv(ROOT / ".env", override=True)
        service = ai or AIService(
            os.environ.get("MISTRAL_API_KEY", ""),
            os.environ.get("SERVER_URL", "https://api.mistral.ai"),
            os.environ.get("DEPLOYMENT_NAME"),
        )
        path = data_path or os.environ.get(
            "AIGUILLEUR_DATA_FILE", str(DEFAULT_DATA_PATH)
        )
        application.state.store = Store(path)
        service.data_path = application.state.store.path
        application.state.store.recover_interrupted_work()
        application.state.ai = service
        application.state.jobs = Jobs(application.state.store, service)
        try:
            yield
        finally:
            await application.state.jobs.close()

    application = FastAPI(title="L'AIGUILLEUR · demonstration", lifespan=lifespan)

    @application.middleware("http")
    async def same_origin(request: Request, call_next):
        origin = request.headers.get("origin")
        if (
            request.method in {"POST", "PUT", "PATCH", "DELETE"}
            and origin
            and urlsplit(origin).netloc != request.headers.get("host")
        ):
            return JSONResponse(
                {"detail": "Cross-origin request rejected."}, status_code=403
            )
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "same-origin"
        response.headers["Permissions-Policy"] = "microphone=(self)"
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
            "img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; "
            "object-src 'none'; base-uri 'self'; frame-ancestors 'none'"
        )
        if request.url.path.startswith("/api/"):
            response.headers["Cache-Control"] = "no-store"
        return response

    @application.exception_handler(NotFound)
    async def missing(_request: Request, exc: NotFound):
        return JSONResponse({"detail": str(exc)}, status_code=404)

    @application.exception_handler(Conflict)
    async def conflict(_request: Request, exc: Conflict):
        return JSONResponse({"detail": str(exc)}, status_code=409)

    @application.exception_handler(DataError)
    async def data_error(_request: Request, exc: DataError):
        return JSONResponse({"detail": str(exc)}, status_code=503)

    application.mount("/static", StaticFiles(directory=STATIC), name="static")

    @application.get("/", response_class=FileResponse)
    async def index():
        return FileResponse(STATIC / "index.html")

    @application.get("/api/config")
    async def config(request: Request):
        settings = request.app.state.store.settings()
        return {
            "model": MODEL,
            "ai_available": request.app.state.ai.available,
            "storage": "json",
            "execution": "mistral-workflows",
            "timezone": settings["timezone"],
            "kpi_definitions": settings["kpi_definitions"],
            "call_defaults": settings["call_defaults"],
        }

    @application.get("/api/incident-statistics")
    def get_incident_statistics(
        start_date: str | None = None, end_date: str | None = None
    ):
        try:
            return incident_statistics(
                statistics_path or DEFAULT_STATISTICS_PATH, start_date, end_date
            )
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

    @application.get("/api/incidents")
    async def list_incidents(request: Request):
        return {"incidents": request.app.state.store.all()}

    @application.get("/api/incidents/{incident_id}")
    async def get_incident(incident_id: str, request: Request):
        return request.app.state.store.get(incident_id)

    @application.post("/api/incidents/{incident_id}/messages")
    async def add_message(incident_id: str, body: MessageInput, request: Request):
        operator = request.app.state.store.settings()["operator"]

        def add(incident: dict) -> None:
            incident["events"].append(
                {
                    "id": "EVT-" + uuid.uuid4().hex[:12],
                    "type": "message",
                    "author": operator["name"],
                    "role": operator["role"],
                    "created_at": timestamp(),
                    "content": body.content,
                }
            )
            incident["revision"] += 1

        request.app.state.store.update(incident_id, add)
        request.app.state.jobs.start_impact(incident_id)
        return request.app.state.store.get(incident_id)

    @application.post("/api/incidents/{incident_id}/calls")
    async def add_call(incident_id: str, body: CallInput, request: Request):
        incident = request.app.state.store.get(incident_id)
        if any(
            event["type"] == "call"
            and event["status"] == "en_cours"
            and not event["synthetic"]
            for record in request.app.state.store.all()
            for event in record["events"]
        ):
            raise Conflict(
                "A recorded call is already in progress. Finish or cancel it before creating another."
            )
        settings = request.app.state.store.settings()
        operator = settings["operator"]
        defaults = settings["call_defaults"]
        transcript = ""
        participants = defaults["microphone_participants"]
        if body.synthetic:
            template = settings["synthetic_call"]
            values = {
                "operator_name": operator["name"],
                "incident_owner": incident["owner"],
                "estimated_end": incident["estimated_end"],
            }
            transcript = template["transcript"].format_map(values)
            participants = [
                participant.format_map(values)
                for participant in template["participants"]
            ]
        call = {
            "id": "CALL-" + uuid.uuid4().hex[:12],
            "type": "call",
            "author": operator["name"],
            "role": operator["role"],
            "created_at": timestamp(),
            "title": body.title or defaults["title"],
            "status": "en_cours",
            "participants": participants,
            "transcript": transcript,
            "summary": "",
            "duration_seconds": 0,
            "synthetic": body.synthetic,
            "error": None,
        }

        def add(record: dict) -> None:
            record["events"].append(call)
            record["revision"] += 1

        return {
            "incident": request.app.state.store.update(incident_id, add),
            "call": call,
        }

    @application.post("/api/incidents/{incident_id}/calls/{call_id}/finish")
    async def finish_call(
        incident_id: str, call_id: str, body: FinishInput, request: Request
    ):
        def finish(incident: dict) -> None:
            call = find_call(incident, call_id)
            if call["status"] not in {"en_cours", "error"}:
                raise Conflict("This call is already finished or being processed.")
            call.update(
                {
                    "transcript": body.transcript,
                    "duration_seconds": body.duration_seconds,
                    "ended_at": timestamp(),
                    "status": "processing",
                    "error": None,
                }
            )
            incident["revision"] += 1

        incident = request.app.state.store.update(incident_id, finish)
        request.app.state.jobs.start_call_summary(incident_id, call_id)
        return incident

    @application.post("/api/incidents/{incident_id}/calls/{call_id}/cancel")
    async def cancel_call(incident_id: str, call_id: str, request: Request):
        def cancel(incident: dict) -> None:
            call = find_call(incident, call_id)
            if call["status"] not in {"en_cours", "error"}:
                raise Conflict("A finished or processing call cannot be cancelled.")
            call.update({"status": "annule", "ended_at": timestamp(), "error": None})
            incident["revision"] += 1

        request.app.state.store.update(incident_id, cancel)
        request.app.state.jobs.start_impact(incident_id)
        return request.app.state.store.get(incident_id)

    @application.post("/api/incidents/{incident_id}/related")
    async def relate(incident_id: str, body: RelatedInput, request: Request):
        store = request.app.state.store
        for related_id in body.related_ids:
            if related_id == incident_id:
                raise Conflict("An incident cannot be related to itself.")
            if store.get(related_id)["status"] != "In progress":
                raise Conflict("Only in-progress incidents can be related.")

        def update(incident: dict) -> None:
            incident["related_ids"] = body.related_ids
            incident["revision"] += 1

        store.update(incident_id, update)
        request.app.state.jobs.start_impact(incident_id)
        return store.get(incident_id)

    @application.post("/api/incidents/{incident_id}/summary")
    async def summarize(incident_id: str, request: Request):
        store = request.app.state.store
        snapshot = store.get(incident_id)
        try:
            summary = await request.app.state.ai.summarize_incident(
                snapshot, store.related(snapshot)
            )
        except AI_ERRORS as exc:
            return JSONResponse({"detail": error_message(exc)}, status_code=503)

        def save(incident: dict) -> None:
            if incident["revision"] != snapshot["revision"]:
                raise Conflict(
                    "New information arrived during generation. Restart the summary."
                )
            incident.update(
                {
                    "summary": summary,
                    "summary_updated_at": timestamp(),
                    "summary_revision": snapshot["revision"],
                    "summary_source": "mistral",
                }
            )

        return {"summary": summary, "incident": store.update(incident_id, save)}

    @application.post("/api/incidents/{incident_id}/impact")
    async def recalculate(incident_id: str, request: Request):
        request.app.state.jobs.start_impact(incident_id)
        return request.app.state.store.get(incident_id)

    @application.post("/api/incidents/{incident_id}/chat")
    async def chat_incident(incident_id: str, body: ChatInput, request: Request):
        store = request.app.state.store
        incident = store.get(incident_id)
        try:
            answer = await request.app.state.ai.chat_incident(
                incident,
                store.related(incident),
                body.question,
                [turn.model_dump() for turn in body.history],
            )
        except AI_ERRORS as exc:
            return JSONResponse({"detail": error_message(exc)}, status_code=503)
        return {"answer": answer}

    @application.post("/api/incidents/{incident_id}/calls/{call_id}/chat")
    async def chat_call(
        incident_id: str, call_id: str, body: ChatInput, request: Request
    ):
        call = find_call(request.app.state.store.get(incident_id), call_id)
        if not call["transcript"].strip():
            raise Conflict("The transcript is not available yet.")
        try:
            answer = await request.app.state.ai.chat_call(
                call, body.question, [turn.model_dump() for turn in body.history]
            )
        except AI_ERRORS as exc:
            return JSONResponse({"detail": error_message(exc)}, status_code=503)
        return {"answer": answer}

    @application.post("/api/incidents/{incident_id}/rex/actions/{action_id}")
    async def update_action(
        incident_id: str, action_id: str, body: ActionStatusInput, request: Request
    ):
        def save(incident: dict) -> None:
            review = incident.get("rex")
            if not review or incident["status"] == "In progress":
                raise NotFound("Experience review not found.")
            action = next(
                (item for item in review["action_items"] if item["id"] == action_id),
                None,
            )
            if action is None:
                raise NotFound("Follow-up action not found.")
            action["status"] = body.status

        return request.app.state.store.update(incident_id, save)

    @application.get("/archives/{archive_id}", response_class=RedirectResponse)
    async def archive(archive_id: str, request: Request):
        incident = request.app.state.store.get(archive_id)
        if not incident.get("rex") or incident["status"] == "In progress":
            raise NotFound("Experience review not found.")
        return RedirectResponse(f"/#rex/{archive_id}", status_code=307)

    return application


app = create_app()
