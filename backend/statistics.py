"""Monthly counts from an independent synthetic Parquet dataset, without AI."""

import argparse
import random
import re
from collections import Counter
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

import duckdb

from .data.schema import DataError

DEFAULT_STATISTICS_PATH = (
    Path(__file__).with_name("data") / "incident_statistics.parquet"
)
FIXTURE_SEED = 20261019
FIXTURE_FROM = date(2023, 11, 1)
FIXTURE_TO = date(2026, 10, 19)
MAX_MONTHS = 120


def utc_today() -> date:
    return datetime.now(UTC).date()


def month_index(value: date) -> int:
    return (value.year - 1) * 12 + value.month - 1


def month_start(index: int) -> date:
    year, month = divmod(index, 12)
    return date(year + 1, month + 1, 1)


def parse_date(value: str | None) -> date | None:
    if value is None:
        return None
    if not re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}", value):
        raise ValueError("Dates must use the format YYYY-MM-DD.")
    try:
        return date.fromisoformat(value)
    except ValueError as exc:
        raise ValueError("The given date is invalid.") from exc


def validate_period(start: date, end: date) -> None:
    if start > end:
        raise ValueError(
            "The start date must be earlier than or equal to the end date."
        )
    if month_index(end) - month_index(start) + 1 > MAX_MONTHS:
        raise ValueError("The period must not exceed 120 calendar months.")


def read_statistics(path: str | Path) -> list[tuple[date, str]]:
    """Read and validate every row; normalize timestamps to UTC before dating."""
    try:
        with duckdb.connect(config={"TimeZone": "UTC"}) as connection:
            relation = connection.from_parquet(str(Path(path).expanduser().resolve()))
            schema = dict(zip(relation.columns, map(str, relation.types), strict=True))
            if schema != {
                "id": "VARCHAR",
                "started_at": "TIMESTAMP WITH TIME ZONE",
                "severity": "VARCHAR",
                "synthetic": "BOOLEAN",
            }:
                raise ValueError("Invalid statistics schema")
            connection.register("records", relation)
            # Returning a UTC timestamp without timezone avoids a pytz dependency.
            rows = connection.execute(
                "SELECT id, started_at AT TIME ZONE 'UTC', severity, synthetic "
                "FROM records"
            ).fetchall()
        if not rows:
            raise ValueError("Empty statistics dataset")
        seen = set()
        result = []
        for identifier, started_at, severity, synthetic in rows:
            if (
                not identifier
                or identifier in seen
                or started_at is None
                or severity not in {"G1", "G2", "G3"}
                or synthetic is not True
            ):
                raise ValueError("Invalid statistics row")
            seen.add(identifier)
            result.append((started_at.date(), severity))
        return result
    except (duckdb.Error, OSError, ValueError) as exc:
        raise DataError(
            "Statistics unavailable: the Parquet file is missing, unreadable or invalid."
        ) from exc


def incident_statistics(
    path: str | Path = DEFAULT_STATISTICS_PATH,
    start_date: str | None = None,
    end_date: str | None = None,
) -> dict:
    start, end = parse_date(start_date), parse_date(end_date)
    today = utc_today()
    if start is None and end is None:
        start = month_start(max(0, month_index(today) - 11))
    end = end or today
    if start is not None:
        validate_period(start, end)

    rows = read_statistics(path)
    available_from = min(day for day, _ in rows)
    available_to = max(day for day, _ in rows)
    start = start or available_from
    validate_period(start, end)
    counts = Counter(
        (day.strftime("%Y-%m"), severity)
        for day, severity in rows
        if start <= day <= end
    )
    months = []
    for index in range(month_index(start), month_index(end) + 1):
        month = month_start(index).strftime("%Y-%m")
        values = {severity: counts[month, severity] for severity in ("G3", "G2", "G1")}
        months.append({"month": month, **values, "total": sum(values.values())})
    return {
        "synthetic": True,
        "source": "incident_statistics.parquet",
        "start_date": start.isoformat(),
        "end_date": end.isoformat(),
        "available_from": available_from.isoformat(),
        "available_to": available_to.isoformat(),
        "months": months,
    }


def generate_fixture(path: str | Path) -> None:
    """Write the reproducible 36-month fixture; never overwrite an existing file."""
    path = Path(path)
    if path.exists():
        raise FileExistsError(path)
    rng = random.Random(FIXTURE_SEED)
    rows: list[tuple[str, datetime, str, bool]] = []
    for index in range(month_index(FIXTURE_FROM), month_index(FIXTURE_TO) + 1):
        first = month_start(index)
        last = min(month_start(index + 1) - timedelta(days=1), FIXTURE_TO)
        for severity in ("G1", "G2", "G3"):
            for _ in range(rng.randint(3, 18)):
                started_at = datetime(
                    first.year,
                    first.month,
                    rng.randint(1, last.day),
                    rng.randrange(24),
                    rng.randrange(60),
                    rng.randrange(60),
                    tzinfo=UTC,
                )
                # The final anchor is midnight; every generated row is earlier.
                started_at = min(
                    started_at, datetime.combine(FIXTURE_TO, datetime.min.time(), UTC)
                )
                rows.append((f"STAT-{len(rows) + 1:05d}", started_at, severity, True))
    for boundary in (FIXTURE_FROM, FIXTURE_TO):
        rows.append(
            (
                f"STAT-{len(rows) + 1:05d}",
                datetime.combine(boundary, datetime.min.time(), UTC),
                "G3",
                True,
            )
        )
    with duckdb.connect(config={"TimeZone": "UTC"}) as connection:
        connection.execute(
            "CREATE TABLE incidents (id VARCHAR, started_at TIMESTAMPTZ, "
            "severity VARCHAR, synthetic BOOLEAN)"
        )
        connection.executemany("INSERT INTO incidents VALUES (?, ?, ?, ?)", rows)
        connection.sql("SELECT * FROM incidents ORDER BY id").to_parquet(
            str(path), compression="snappy"
        )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Generate the seeded statistics fixture."
    )
    parser.add_argument(
        "path", type=Path, help="New Parquet output path (must not exist)"
    )
    generate_fixture(parser.parse_args().path)
