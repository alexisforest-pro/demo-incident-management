# AGENTS.md

Guidance for coding agents working on L’AIGUILLEUR. Read this before changing code. User-facing documentation is in `README.md`.

## What this project is

An AI-assisted railway incident-management demo, built on a Mistral Workflows starter project. The UI, code, comments and docs are in English. All data is synthetic.

## Hard rules

These come from the product owner. Don't break them without explicit approval.

- **No operator branding.** The real railway operator must never be named anywhere: code, UI, data, docs, commit messages. Use generic terms ("the network", "the agency").
- **Product name:** `L’AIGUILLEUR`, with "AI" in a different color. In HTML: `L’<span>AI</span>GUILLEUR`.
- **Model:** every LLM request uses `mistral-large-4`, defined once as `MODEL` in `backend/prompts.py`. Never add a fallback model.
- **Every LLM call goes through a named feature workflow.** The web app must not call the chat API directly. New AI features get a workflow file in `worker/workflows/`, a `Task` value and a name in `worker/workflow_types.py`; reuse the shared plugin-call helper in `worker/model_call.py`.
- **No fake AI output.** If a model call fails, show the error and keep the user's data. Never substitute canned text. Sample content in the data must stay labeled as sample (`summary_source: "demo"`, `impact.origin: "demo"`, `synthetic: true`).
- **The incident summary is generated on demand only** (button), never automatically.
- **No emoji** anywhere.
- **It's a demo.** Keep it simple, keep tests few and focused, don't add infrastructure.

## Architecture

```text
Browser ──HTTP──> Web server (make demo) ──starts workflow runs──> Mistral Workflows API
                        │                                                  │
                 incidents.json                                            ▼
                                                     Worker (make start-worker) ──> mistral-large-4
```

Two processes run locally:

- **Web server** (`backend/`, FastAPI on `127.0.0.1:8000`): API and data, and serves `frontend/`. Builds prompts, starts workflow runs, validates results.
- **Worker** (`worker/`): auto-discovers and runs the five named AI feature workflows in `worker/workflows/`.

### Layout and modules

The project started from the Mistral Workflows starter template and was reorganized into one folder per part. There is no `src/` folder. `backend` and `worker` are Python packages installed in editable mode (`uv sync`), so imports look like `from backend.prompts import MODEL` or `from worker.workflow_types import WORKFLOW_NAMES`.

| Path | Responsibility |
|---|---|
| `frontend/` | Browser code, served by the backend at `/static/`: `index.html`, `app.js` (about 1,100 lines, plain JS, no build step), `styles.css`. |
| `backend/server.py` | `create_app(data_path=None, ai=None)` and the module-level `app` (`uvicorn backend.server:app`). Routes, request models, same-origin check, security headers, serves `frontend/`. Loads `.env` from the project root with `override=True`. |
| `backend/storage.py` | The only code that reads or writes the JSON file. `Store`: `get`, `all`, `settings`, `related`, `update(id, change_fn)`, `recover_interrupted_work`; plus `find_call`. |
| `backend/data/incidents.json` | All data: the single source of truth. |
| `backend/data/schema.py` | Pydantic validation: required fields, unique IDs, valid references, timezone-aware timestamps. Unknown extra fields are kept. |
| `backend/prompts.py` | `MODEL`, `context_for`, one builder per task; concise answers and compact JSON without dropping incident knowledge. Pure functions with no I/O, because the workflow sandbox imports this module. |
| `backend/ai_requests.py` | `AIService`: starts workflow runs, polls them, validates results (including KPI sources), turns errors into English UI messages. |
| `backend/background_tasks.py` | `Jobs`: background tasks in the web server: call summary, then KPI update; KPI update after any change. |
| `worker/workflows/` | One file/class per feature: `incident_summary.py`, `call_summary.py`, `impact_extraction.py`, `incident_assistant.py`, `call_assistant.py`. Each fixes its task; only impact requests JSON. |
| `worker/workflow_types.py` | Pure `Task` and `WORKFLOW_NAMES` mapping; input `LLMRequest{messages}` (no caller task/structured flag), output `LLMResult{task, model, content}`. Safe to import in backend and sandbox. |
| `worker/model_call.py` | Shared deterministic helper calling the Mistral plugin activity with `model=MODEL`, `reasoning_effort="none"` and `MAX_TOKENS_BY_TASK`, then rejecting empty/truncated content and stripping thinking chunks. |
| `worker/start.py` | Auto-discovers every workflow class in `worker/workflows/` and runs the worker (Docker `CMD`). |
| `worker/start_with_reload.py` | `make start-worker`: runs `worker.start` and restarts it when a `.py` file in `worker/` or `backend/` changes. |
| `worker/run_workflow.py` | `make execute`: starts one workflow run from the command line. |
| `tests/test_incidents.py` | Focused tests. No network, no microphone. |
| `reference/ui_sketch.png` | UI sketch from the brief. Not used by the code. |

### Named workflows

| Task | File | Workflow name |
|---|---|---|
| `incident_summary` | `incident_summary.py` | `aiguilleur-incident-summary` |
| `call_summary` | `call_summary.py` | `aiguilleur-call-summary` |
| `impact` | `impact_extraction.py` | `aiguilleur-impact-extraction` |
| `incident_chat` | `incident_assistant.py` | `aiguilleur-incident-assistant` |
| `call_chat` | `call_assistant.py` | `aiguilleur-call-assistant` |

The old generic `aiguilleur-llm` workflow/file was removed. Old runs may remain in AI Studio; new requests use only the names above. Restart both the backend and worker after this migration.

## How an AI request works

1. A route (`server.py`) or background task (`background_tasks.py`) calls an `AIService` method (`ai_requests.py`): `summarize_incident`, `summarize_call`, `extract_impact`, `chat_incident` or `chat_call`.
2. `prompts.py` builds the messages.
3. `AIService.complete()` selects `WORKFLOW_NAMES[task]` with `execution_id = "aiguilleur-{task}-{uuid}"` and `deployment_name` from `.env`, then calls `get_workflow_execution_async` every 0.5 s.
4. On the worker, the workflow calls the plugin activity `mistralai_chat_complete` with `model=MODEL`. The shared `complete_llm` helper fails without retry on an empty or truncated answer, and drops any thinking chunks.
5. `ai_requests.py` checks the result (non-empty, matching task, `model == MODEL`). For KPIs: exactly six keys, and each source must be `"header"` or a real event ID.
6. The route or task saves the result through `Store.update` (`storage.py`).

Two of these choices fix real failures. Don't revert them:

- **Polling instead of `wait_for_result=True`.** Waiting on the API returned a gateway 504 after about 60 s on long prompts, even when the run finished sooner.
- **Explicit `execution_id`.** Without it, concurrent starts came back with the same ID.

The overall limit is 80 s (`WORKFLOW_TIMEOUT_SECONDS`), which stays under the browser's 90 s request timeout. When it's hit, the run is cancelled.

## Data model

`incidents.json` top level: `schema_version` (1), `timezone` ("UTC"), `kpi_definitions`, `operator`, `call_defaults`, `synthetic_call`, `incidents`.

Each incident has header fields (`id`, `title`, `category`, `severity` G1–G3, `status`, `location`, `line`, `region`, `started_at`, `estimated_end`, `owner`, `description`), plus `summary`, `related_ids`, `events`, `impact`, `history` and the version fields below.

**Events:**

- Message: `{id, type: "message", author, role, created_at, content}`.
- Call: `{id, type: "call", author, role, created_at, title, status, participants, transcript, summary, duration_seconds, synthetic, error}`, plus optional `ended_at`, `summary_source`, `summary_updated_at`.

**Call statuses:**

```text
en_cours ──finish──> processing ──summary saved──> termine
    │                    └────────failure──────> error ──finish again──> processing
    └──cancel──> annule          (cancel is also allowed from error)
```

**Impact:** `{items[6], origin: demo|mistral, updated_at, revision, status: ready|running|error, error}`. Each item: `{key, label, value|null, status: confirmed|estimated|unknown, source}`. The six keys are fixed in `schema.KPI_KEYS`: `passengers`, `trains`, `delay`, `cancelled`, `teams`, `recovery`. Labels come from `kpi_definitions`. "confirmed" means stated explicitly in a source, not verified.

**Versions.** These drive the "out of date" flags in the UI and prevent saving outdated results:

- `revision` goes up by 1 on every content change: new message, call created/finished/cancelled, call summary saved, links changed.
- `summary_revision` and `impact.revision` record the `revision` they were generated from. A lower value means "out of date".
- A KPI result is saved only if `revision` hasn't changed since the request started. Otherwise the job runs again on the latest data.
- An incident summary isn't saved if new information arrived during generation (HTTP 409).

**Store guarantees.** Writes happen under a lock and replace the file atomically. The file is validated before writing; an invalid result raises and the file stays as it was. If the file changed on disk during an update, the update is refused (`Conflict`). A missing or invalid file raises `DataError`; the store never creates or resets it.

**On startup**, `recover_interrupted_work` marks KPI updates still `running` and calls still `processing` as `error`, along with unfinished microphone calls. Their data is kept.

## API

All routes are under `/api` except `/` and `/archives/{id}`. Cross-origin writes are refused with 403.

| Method and path | Purpose |
|---|---|
| `GET /api/config` | Model, AI availability, storage, KPI definitions, call defaults |
| `GET /api/incidents`, `GET /api/incidents/{id}` | Read data |
| `POST …/messages` | Add a message, then start a KPI update |
| `POST …/calls` `{title?, synthetic}` | Create a call. Only one unfinished microphone call at a time (409). |
| `POST …/calls/{cid}/finish` `{transcript, duration_seconds}` | Finish a call, then summary, then KPI update, in the background |
| `POST …/calls/{cid}/cancel` | Cancel a call |
| `POST …/related` `{related_ids}` | Replace links. Must be other ongoing incidents. |
| `POST …/summary` | Generate the summary and wait for it |
| `POST …/impact` | Retry the KPI update |
| `POST …/chat`, `POST …/calls/{cid}/chat` `{question, history}` | Chat, waiting for the answer |
| `GET /archives/{id}` | Demo archive page for a past incident |

Errors: 404 not found, 409 conflict, 422 invalid input, 503 AI or data problem. The body is `{detail}` with an English message.

## Frontend

- One `app.js` file: an IIFE with a single `state` object. Views switch through the URL hash (`#overview`, `#incident/{id}`). Chat histories and recorded audio live only in browser memory.
- **Escape every value** through `escapeHTML` (alias `e`) before inserting it with `innerHTML`. The CSP allows only `'self'` scripts: no inline scripts, no CDN.
- The UI refreshes data every 2.8 s while a KPI update or call summary is running, and only then. Typed drafts are kept across refreshes (`data-draft`); don't break this.
- Microphone flow: `MediaRecorder` plus `SpeechRecognition` (`fr-FR`), live transcript, review and confirm, then `finish`. Navigation and closing are locked while recording. Microphone tracks are always released. A refused permission cancels the call on the server.
- Times are shown in UTC with a "UTC" label.
- UI severity terminology is "Severity": stored G3 → SEV1 (highest, strong red), G2 → SEV2 (lighter red), G1 → SEV3 (orange). `SEVERITIES` in `app.js` controls badges, filters and overview counts. Counts cover ongoing incidents and are independent of table filters. Keep stored data levels unchanged for this display mapping.

## Commands

```bash
uv sync                # install
make start-worker      # worker with auto-reload (worker.start_with_reload)
make demo              # web server, 127.0.0.1:8000
make test-demo         # tests
make check             # ruff + mypy on backend/worker/tests, semgrep on worker/workflows (also run by the Vibe post-turn hook)
```

`make format` applies ruff fixes and formatting to the same folders.

There's no Node install. To syntax-check `frontend/app.js`, use any `node --check`. One copy ships with the Playwright tool if installed: `~/.local/share/uv/tools/playwright/lib/python3.14/site-packages/playwright/driver/node`.

## Testing

- Tests copy `incidents.json` into a temp directory (`data_path` fixture). **Never let a test write to the real data file.**
- Tests replace `AIService` with a fake subclass; there are no network calls.
- To check the workflow without a worker, run it locally with `mistralai.workflows.execute_workflow(...)` and stub `workflows_mistralai.mistralai_chat_complete`. That's what `test_named_workflows_use_the_plugin_and_are_all_discovered` does for all five workflows, including discovery and failure cases.
- For a live check, start a worker, then use `create_app(<temp copy>)` with `fastapi.testclient.TestClient`. Measure elapsed time after awaiting the result. Most recent requests were below 8 s, but model outliers occurred; see README.

## Workflow rules

The full SDK guide is at `.agents/skills/workflows/SKILL.md`. Read it before editing `worker/workflows/`. The essentials:

- The workflow body must be deterministic: no I/O, no `datetime.now`, `uuid4`, `random` or `os.environ`. Model calls happen only inside activities (here, the plugin's `mistralai_chat_complete`).
- No top-level imports of `httpx`, `requests` or `mistralai.client.Mistral` in workflow files; the sandbox rejects them when the worker starts. That's why prompts live in the pure `prompts.py`.
- Activity timeouts must be `timedelta`. Workflow and activity signatures need full type hints.
- After changing a workflow, restart the worker.

## Configuration and secrets

- `.env` holds `MISTRAL_API_KEY`, `SERVER_URL`, `DEPLOYMENT_NAME`. It's gitignored and dockerignored. **Never print, log or commit the key.**
- `DEPLOYMENT_NAME` must be the same for the web server and the worker, or runs won't reach the worker.
- The shell may already have a different `MISTRAL_API_KEY` exported. The app loads `.env` with `override=True`; do the same in scripts.
- Optional: `AIGUILLEUR_DATA_FILE` points the web server at another JSON file.

## Known limits and next steps

- **Latency target:** below 8 s for most calls, without streaming or changing `mistral-large-4`. Applied `reasoning_effort="none"`, concise prompts, compact JSON, task token budgets (256 summary/chat, 320 call summary, 512 impact). Do not restore the 8,000-token/default-reasoning settings. Full context and chat history remain intact. The client is already reused. In 13 end-to-end samples, 11 were below 8 s, median 5.98 s; two model outliers were 13.32/19.36 s. No hard latency guarantee. The failed run `aiguilleur-incident_chat-3c9b13b619a048a7a82834e4480c3cf7` spent 84.4 s in one model attempt before app termination at 80 s. Backend logs task/execution ID/elapsed via `uvicorn.error`, never content or keys. Further options need measurement: smaller task-specific context or merging call summary + KPI, without silently losing knowledge.
- The call-summary-then-KPI chain is orchestrated in the web server, not as a workflow, so it isn't durable across restarts.
- Single-user, local only. The JSON file isn't safe for several writers.
- The Dockerfile deploys the worker only.

## Conventions

- Match the existing style: Python 3.12+ typing, Pydantic v2, ruff formatting.
- UI text is in English, and AI-facing prompts are in English too.
- Keep changes minimal; don't refactor what wasn't asked.
- After a change: run the tests and checks above. Check UI changes in a browser if you can.
