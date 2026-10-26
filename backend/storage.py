"""Read and atomically persist the JSON incident data backbone."""

import json
import os
from collections.abc import Callable
from copy import deepcopy
from pathlib import Path
from tempfile import NamedTemporaryFile
from threading import RLock

from .data import DEFAULT_DATA_PATH
from .data.schema import DataError, load_document, validate_document


class NotFound(LookupError):
    pass


class Conflict(RuntimeError):
    pass


class Store:
    def __init__(self, path: str | Path = DEFAULT_DATA_PATH) -> None:
        self.path = Path(path).expanduser().resolve()
        self.lock = RLock()
        load_document(self.path)

    def _write(self, document: dict, previous: bytes) -> None:
        validate_document(document, self.path)
        content = (
            json.dumps(document, ensure_ascii=False, indent=2, allow_nan=False) + "\n"
        )
        temporary = None
        try:
            with NamedTemporaryFile(
                mode="w",
                encoding="utf-8",
                dir=self.path.parent,
                prefix=f".{self.path.name}.",
                suffix=".tmp",
                delete=False,
            ) as file:
                temporary = Path(file.name)
                file.write(content)
                file.flush()
                os.fsync(file.fileno())
            if self.path.read_bytes() != previous:
                raise Conflict("The JSON file was modified while saving. Retry.")
            temporary.replace(self.path)
        except OSError as exc:
            raise DataError(
                f"Cannot save {self.path}. The previous data file was not replaced."
            ) from exc
        finally:
            if temporary is not None and temporary.exists():
                temporary.unlink()

    def get(self, identifier: str) -> dict:
        with self.lock:
            document = load_document(self.path)
            for incident in document["incidents"]:
                if incident["id"] == identifier:
                    return incident
        raise NotFound("Incident not found.")

    def all(self) -> list[dict]:
        with self.lock:
            return sorted(
                load_document(self.path)["incidents"],
                key=lambda incident: incident["id"],
            )

    def settings(self) -> dict:
        with self.lock:
            document = load_document(self.path)
            return {key: value for key, value in document.items() if key != "incidents"}

    def related(self, incident: dict) -> list[dict]:
        return [self.get(identifier) for identifier in incident["related_ids"]]

    def update(self, identifier: str, change: Callable[[dict], None]) -> dict:
        with self.lock:
            try:
                previous = self.path.read_bytes()
            except OSError as exc:
                raise DataError(f"Cannot read {self.path} before updating it.") from exc
            document = load_document(self.path)
            for incident in document["incidents"]:
                if incident["id"] != identifier:
                    continue
                before = deepcopy(incident)
                change(incident)
                if incident != before:
                    self._write(document, previous)
                return incident
        raise NotFound("Incident not found.")

    def recover_interrupted_work(self) -> None:
        for incident in self.all():

            def recover(record: dict) -> None:
                if record["impact"]["status"] == "running":
                    record["impact"]["status"] = "error"
                    record["impact"]["error"] = (
                        "Update interrupted by a restart. Run the calculation again."
                    )
                for event in record["events"]:
                    if event["type"] != "call":
                        continue
                    if event["status"] == "processing":
                        event["status"] = "error"
                        event["error"] = (
                            "Summary interrupted by a restart. The transcript is preserved; retry."
                        )
                    elif event["status"] == "en_cours" and not event["synthetic"]:
                        event["status"] = "error"
                        event["error"] = (
                            "Recording interrupted. Enter the available transcript to finish the call."
                        )

            self.update(incident["id"], recover)


def find_call(incident: dict, call_id: str) -> dict:
    for event in incident["events"]:
        if event["id"] == call_id and event["type"] == "call":
            return event
    raise NotFound("Call not found.")
