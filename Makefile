.PHONY: start-worker execute installdeps lint format typecheck lint-workflows check docker-build docker-run

IMAGE ?= workflow-worker
HOST ?= 127.0.0.1
PORT ?= 8000
PROJECT_DIR := $(dir $(abspath $(lastword $(MAKEFILE_LIST))))

.PHONY: demo test-demo

## Start the web server (backend + frontend); override with HOST=localhost PORT=8001
demo:
	uv run --project "$(PROJECT_DIR)" python -m uvicorn backend.server:app --host "$(HOST)" --port "$(PORT)"

## Run the tests (no Mistral requests)
test-demo:
	uv run --project "$(PROJECT_DIR)" pytest "$(PROJECT_DIR)tests/test_incidents.py" -q

## Install dependencies
installdeps:
	uv sync

## Lint and format-check backend, worker and tests with ruff
lint:
	uv run ruff check backend/ worker/ tests/
	uv run ruff format --check backend/ worker/ tests/

## Auto-format backend, worker and tests and apply ruff autofixes
format:
	uv run ruff format backend/ worker/ tests/
	uv run ruff check --fix backend/ worker/ tests/

## Type-check backend and worker with mypy
typecheck:
	uv run mypy backend/ worker/ --follow-untyped-imports

## Lint workflows for determinism / I/O / structure issues (semgrep, advisory)
lint-workflows:
	uv run semgrep --config .agents/skills/workflows/scripts/linting/rules/ --quiet worker/workflows/

## Run all checks: ruff lint, mypy types, and workflow lint
check: lint typecheck lint-workflows

## Start the worker: runs worker/workflows/ and restarts on file changes
start-worker:
	uv run python -m worker.start_with_reload

## Build the worker image — the same Dockerfile Mistral Cloud builds
docker-build:
	docker build -t $(IMAGE) .

## Run the worker image locally, passing your .env values as container env vars
docker-run:
	docker run --rm --env-file .env $(IMAGE)

## Trigger a workflow execution
## Usage: make execute workflow=aiguilleur-incident-assistant input='{"messages": [{"role": "user", "content": "Bonjour"}]}'
execute:
	uv run python -m worker.run_workflow $(if $(workflow),--workflow $(workflow),) $(if $(input),--input '$(input)',)
