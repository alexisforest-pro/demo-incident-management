"""Validate editable JSON data without discarding additional incident fields."""

import json
from datetime import date, datetime
from pathlib import Path
from string import Formatter
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator

KPIKey = Literal["passengers", "trains", "delay", "cancelled", "teams", "recovery"]
KPI_KEYS: tuple[KPIKey, ...] = (
    "passengers",
    "trains",
    "delay",
    "cancelled",
    "teams",
    "recovery",
)
Identifier = Annotated[
    str, Field(min_length=1, max_length=120, pattern=r"^[A-Za-z0-9_-]+$")
]
Text = Annotated[str, Field(min_length=1)]


class DataError(RuntimeError):
    """The data file is missing, unreadable or invalid; never reset it silently."""


class DataModel(BaseModel):
    model_config = ConfigDict(extra="allow", strict=True)


class KPIDefinition(DataModel):
    key: KPIKey
    label: Text


class Operator(DataModel):
    name: Text
    role: Text


class CallDefaults(DataModel):
    title: Text
    microphone_participants: list[Text]


class SyntheticCall(DataModel):
    participants: list[Text]
    transcript: Text

    @model_validator(mode="after")
    def valid_placeholders(self):
        for template in [self.transcript, *self.participants]:
            for _, field, spec, conversion in Formatter().parse(template):
                if field is not None and (
                    field not in {"operator_name", "incident_owner", "estimated_end"}
                    or spec
                    or conversion
                ):
                    raise ValueError("Unsupported synthetic-call placeholder.")
        return self


class Message(DataModel):
    id: Identifier
    type: Literal["message"]
    author: Text
    role: str
    created_at: Text
    content: str


class Call(DataModel):
    id: Identifier
    type: Literal["call"]
    author: Text
    role: str
    created_at: Text
    title: Text
    status: Literal["en_cours", "processing", "termine", "error", "annule"]
    participants: list[Text]
    transcript: str
    summary: str
    duration_seconds: int = Field(ge=0)
    synthetic: bool
    error: str | None


class KPIItem(DataModel):
    key: KPIKey
    label: Text
    value: str | None
    status: Literal["confirmed", "estimated", "unknown"]
    source: str


class Impact(DataModel):
    items: list[KPIItem]
    origin: Literal["demo", "mistral"]
    updated_at: str | None
    revision: int = Field(ge=0)
    status: Literal["ready", "running", "error"]
    error: str | None

    @model_validator(mode="after")
    def unique_kpis(self):
        if len(self.items) != len(KPI_KEYS) or {item.key for item in self.items} != set(
            KPI_KEYS
        ):
            raise ValueError(
                "Each impact must contain the six supported KPI keys exactly once."
            )
        return self


class HistoricalIncident(DataModel):
    id: Identifier
    title: Text
    date: Text
    location: Text
    category: Text
    severity: Text
    confidence: int = Field(ge=0, le=100)
    summary: str
    url: Text


class Why(DataModel):
    question: Text
    answer: Text


class ActionItem(DataModel):
    id: Identifier
    title: Text
    owner: Text
    deadline: Text
    status: Literal["a_faire", "en_cours", "termine"]

    @model_validator(mode="after")
    def valid_deadline(self):
        date.fromisoformat(self.deadline)
        return self


class ExperienceReview(DataModel):
    synthetic: bool
    what_happened: Text
    consequences: Text
    five_whys: list[Why] = Field(min_length=5, max_length=5)
    action_items: list[ActionItem] = Field(min_length=1)

    @model_validator(mode="after")
    def unique_actions(self):
        identifiers = [item.id for item in self.action_items]
        if len(identifiers) != len(set(identifiers)):
            raise ValueError("Action item IDs must be unique within a review.")
        return self


class Incident(DataModel):
    id: Identifier
    title: Text
    category: Text
    severity: Text
    status: Text
    location: Text
    line: Text
    region: Text
    started_at: Text
    estimated_end: str
    owner: Text
    description: str
    summary: str
    related_ids: list[Identifier]
    events: list[Annotated[Message | Call, Field(discriminator="type")]]
    impact: Impact
    history: list[HistoricalIncident]
    synthetic: bool
    revision: int = Field(ge=0)
    summary_revision: int = Field(ge=0)
    summary_updated_at: str | None
    summary_source: Literal["demo", "mistral"]
    ended_at: str | None = None
    rex: ExperienceReview | None = None

    @model_validator(mode="after")
    def valid_references(self):
        if self.rex is not None and (self.status == "In progress" or not self.ended_at):
            raise ValueError("An experience review needs a past incident and end time.")
        event_ids = [event.id for event in self.events]
        if len(event_ids) != len(set(event_ids)):
            raise ValueError(f"Duplicate event ID in {self.id}.")
        if self.id in self.related_ids or len(self.related_ids) != len(
            set(self.related_ids)
        ):
            raise ValueError(f"Invalid related incident IDs in {self.id}.")
        for item in self.impact.items:
            if item.source and item.source not in {"header", *event_ids}:
                raise ValueError(f"Unknown KPI source {item.source} in {self.id}.")
        for value in [
            self.started_at,
            self.ended_at,
            self.summary_updated_at,
            self.impact.updated_at,
            *(event.created_at for event in self.events),
        ]:
            if value is not None and datetime.fromisoformat(value).tzinfo is None:
                raise ValueError("Incident timestamps must include a timezone.")
        return self


class Dataset(DataModel):
    schema_version: Literal[1]
    timezone: Literal["UTC"]
    kpi_definitions: list[KPIDefinition]
    operator: Operator
    call_defaults: CallDefaults
    synthetic_call: SyntheticCall
    incidents: list[Incident]

    @model_validator(mode="after")
    def valid_identifiers(self):
        identifiers = [incident.id for incident in self.incidents]
        if len(identifiers) != len(set(identifiers)):
            raise ValueError("Incident IDs must be unique.")
        reviews = {
            incident.id for incident in self.incidents if incident.rex is not None
        }
        for incident in self.incidents:
            if not set(incident.related_ids).issubset(identifiers):
                raise ValueError(f"Unknown related incident in {incident.id}.")
            if any(past.id not in reviews for past in incident.history):
                raise ValueError(f"Missing experience review in {incident.id}.")
        keys = [item.key for item in self.kpi_definitions]
        if len(keys) != len(KPI_KEYS) or set(keys) != set(KPI_KEYS):
            raise ValueError("Define the six supported KPI keys exactly once.")
        return self


def validate_document(document: dict, path: Path) -> dict:
    try:
        Dataset.model_validate(document)
    except ValidationError as exc:
        issue = exc.errors(include_input=False)[0]
        location = ".".join(str(part) for part in issue["loc"]) or "document"
        raise DataError(
            f"Invalid data in {path} at {location}: {issue['msg']}"
        ) from exc
    return document


def load_document(path: Path) -> dict:
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise DataError(
            f"Invalid JSON in {path}, line {exc.lineno}, column {exc.colno}."
        ) from exc
    except (OSError, UnicodeError) as exc:
        raise DataError(
            f"Cannot read {path}. Check the data file and its permissions."
        ) from exc
    return validate_document(document, path)
