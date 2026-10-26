# L’AIGUILLEUR

An AI-assisted railway incident-management demo. It reimagines a legacy incident tool (a list of ongoing incidents, and one page per incident with its chronology of events) and adds AI assistance: summaries, call transcripts, an incident assistant, automatic impact KPIs and similar past incidents.

The UI is in English. All data is synthetic. Every LLM request uses `mistral-large-4` and runs as a [Mistral Workflows](https://docs.mistral.ai/workflows/getting-started/introduction) execution.

> **Demo only.** This is not an operational safety system. KPIs, summaries and historical matches are illustrative, and AI output always needs human validation.

## Quick start

Requirements: Python 3.12+, [uv](https://docs.astral.sh/uv/), a Mistral API key with access to `mistral-large-4`, and Chrome (recommended for speech recognition).

1. Install dependencies:

   ```bash
   uv sync
   ```

2. Create `.env` at the project root:

   ```bash
   MISTRAL_API_KEY=your-key
   SERVER_URL=https://api.mistral.ai
   DEPLOYMENT_NAME=your-unique-deployment-name
   ```

   `DEPLOYMENT_NAME` routes workflow executions to your own worker. Pick a name nobody else uses (for example `<hostname>-demo-aiguilleur`).

3. Start the two processes, each in its own terminal:

   ```bash
   make start-worker   # terminal 1: runs all five AI workflows
   make demo           # terminal 2: web UI and API on http://127.0.0.1:8000
   ```

4. Open http://127.0.0.1:8000.

If port `8000` is already in use, start the web server on another port:

```bash
make demo PORT=8001
```

Then open http://127.0.0.1:8001. You can also choose the local hostname with `make demo HOST=localhost PORT=8001`. The defaults remain `HOST=127.0.0.1` and `PORT=8000`; these can be passed to `make` or exported in your shell. Keep the host on a loopback address for this local-only demo. `SERVER_URL` is the Mistral API URL, not the local app address; leave it unchanged.

Do not run two web servers against the same JSON file. If the existing server is another instance of this app, stop it first or use a separate dataset through `AIGUILLEUR_DATA_FILE`.

Without the worker, the app still loads and saves data, but AI actions fail with an error telling you to start it.

## Features

**Navigation.** Two entries: *Ongoing incidents* lists only ongoing incidents; *REX* lists completed events. Click a row to open its details; the top-left *Back* button returns to its list. Search and severity filters are kept separately for both lists. The top-right REX period filter offers 3, 6, 12 (default), 24 or 36 calendar months, including the current month through today in UTC, or an inclusive custom date range (120 months maximum). It filters REX records by incident start date and is retained when returning from a detail page.

**Incident list.** A compact table with one row per incident: reference, start time (UTC), event and location, sector and line, severity and status, estimated recovery, and communication counts. The overview counters show the total ongoing incidents and the SEV1/SEV2/SEV3 breakdown. SEV1 is highest (strong red), SEV2 is lighter red, and SEV3 is orange. The existing data levels are displayed as G3 → SEV1, G2 → SEV2, G1 → SEV3; the JSON data is unchanged. Click a row to open the incident, or focus its title and press Enter. Search and severity filters are retained; the table scrolls horizontally on small screens.

**Incident page:**

| Block | What it does |
|---|---|
| Header | Incident details and an AI summary, regenerated on demand with a button. |
| Related incidents | Links to other ongoing incidents, chosen from a picker. |
| Communications | Timeline of messages and calls. Calls have their own color and an *In progress* / *Closed* status. A finished call shows its summary in the timeline. |
| Call panel | Opens in the page with three tabs: *Summary*, *Transcript*, *Chat*. |
| Assistant | Answers questions using the whole incident: header, communications, call summaries, KPIs, related and past incidents. |
| Impact | Six KPIs: passengers, trains, estimated delay, cancelled trains, mobilized teams, estimated recovery. Each one cites the message or call it comes from. They update automatically after a new message or a finished call. |
| History | Similar past incidents with a confidence score. Each opens a preview, then links directly to its full REX detail page. |

**REX (post-incident reviews).** Twelve synthetic past events cover all the existing similar-incident examples. Their detail pages reuse the incident summary and six impact KPIs, followed by a blameless account of what happened, consequences, and five whys. Action items appear alongside the review with an owner, deadline and persisted status (*To do*, *In progress*, *Closed*). Communications, call transcripts and the same AI assistant remain available below; REX pages do not show similar incidents. The assistant receives the review and action items through the existing named workflow, not a new model integration. Legacy `/archives/{id}` links redirect to `/#rex/{id}`.

**Monthly severity chart.** The REX view displays incident counts per month as stacked bars: G3 → SEV1 (red), G2 → SEV2 (pink), G1 → SEV3 (orange). The same period selector controls the chart and REX list; search and severity filters affect only the list. Monthly totals, a legend and tooltips make the counts readable. The REX view shows the chart without top count cards, a data table or technical footer notes. Demo-content notices use the exact label “Synthetic demo data”. The chart uses an independent, clearly labeled synthetic Parquet sample, not the twelve documented REX records or AI output. Empty periods are shown explicitly; an unreadable file displays an error rather than fabricated fallback values.

**New calls.** Two options:

- **Microphone.** Records your voice and transcribes it live using the browser's speech recognition. When you stop, you review and confirm the transcript; the app then writes the summary and updates the KPIs. If speech recognition isn't available, the audio is still recorded and you type the transcript.
- **Synthetic.** Creates a call with a sample transcript, clearly labeled as such.

## How it works

```text
Browser ──HTTP──> Web server (make demo) ──starts workflow runs──> Mistral Workflows API
                        │                                                  │
                 incidents.json                                            ▼
                                                     Worker (make start-worker) ──> mistral-large-4
```

- The **web server** (FastAPI) serves the UI and API, validates requests and saves every change to `incidents.json`. For AI work, it builds the prompt and starts the named workflow for that feature.
- The **worker** runs the five feature workflows. They share the model-call helper in `worker/model_call.py`, which calls `mistral-large-4` through the Mistral plugin and returns only the final answer. An empty or truncated answer fails without retry. Each feature has its own named workflow and execution history in AI Studio.
- The web server checks each run every 0.5 s and saves the result. It gives up after 80 s and cancels the run.

| AI feature | Workflow name | Trigger |
|---|---|---|
| Incident summary | `aiguilleur-incident-summary` | Summary button; waits for the result |
| Call summary | `aiguilleur-call-summary` | Finishing a call; background |
| Impact KPIs | `aiguilleur-impact-extraction` | New message, finished call summary, link change, retry; background |
| Incident assistant | `aiguilleur-incident-assistant` | Asking an incident question; waits for the result |
| Call assistant | `aiguilleur-call-assistant` | Asking a call question; waits for the result |

Workflow inputs contain `messages` only. The selected workflow fixes the task; KPI extraction always requests JSON output. Prompts remain in `backend/prompts.py`. The history block still uses sample matches, not an AI workflow.

### Project layout

```text
demo-aiguilleur/
├── frontend/                        # What runs in the browser (no build step)
│   ├── index.html                   # Page structure
│   ├── app.js                       # All UI behavior: list, incident page, calls, microphone, chats
│   └── styles.css                   # Look and colors
├── backend/                         # The web server (make demo)
│   ├── server.py                    # API routes; also serves the frontend files
│   ├── storage.py                   # Reads and writes incidents.json
│   ├── ai_requests.py               # Starts workflow runs and validates their results
│   ├── prompts.py                   # Prompt texts and the model name
│   ├── background_tasks.py          # Background steps: call summary, then KPI update
│   ├── statistics.py                # Read-only monthly statistics and seeded fixture generator
│   └── data/
│       ├── incidents.json           # Documented incidents: the single source of truth
│       ├── incident_statistics.parquet # Independent synthetic chart sample
│       └── schema.py                # Validation of the JSON file
├── worker/                          # The Mistral Workflows worker (make start-worker)
│   ├── workflows/                   # One file per AI feature
│   │   ├── incident_summary.py      # Header summary
│   │   ├── call_summary.py          # Finished-call summary
│   │   ├── impact_extraction.py     # Six impact KPIs
│   │   ├── incident_assistant.py    # Incident chat
│   │   └── call_assistant.py        # Call chat
│   ├── model_call.py                # Shared mistral-large-4 call and answer checks
│   ├── workflow_types.py            # Workflow input/output types and workflow names
│   ├── start.py                     # Finds the workflows and starts the worker
│   ├── start_with_reload.py         # Same, restarting on code changes (make start-worker)
│   └── run_workflow.py              # Starts one workflow run from the command line (make execute)
├── tests/test_incidents.py          # Focused tests, no network calls
├── reference/ui_sketch.png          # UI sketch from the brief
├── Makefile                         # All commands
├── AGENTS.md                        # Guidance for coding agents
└── Dockerfile                       # Worker image
```

## Data

All documented incident data lives in **`backend/data/incidents.json`**. The app reads it on every request and writes every change back to it, so you can edit it by hand.

| Key | Contents |
|---|---|
| `incidents` | Ongoing incidents and completed REX records: headers, communications, KPIs and links. REX records also have `ended_at` and `rex` (what happened, consequences, five whys, action items). |
| `kpi_definitions` | The six KPI keys and their display labels |
| `operator` | Name and role used as the author of new messages and calls |
| `call_defaults` | Default call title and microphone participants |
| `synthetic_call` | Sample transcript for synthetic calls. Placeholders: `{operator_name}`, `{incident_owner}`, `{estimated_end}` |

**Chart data:** `backend/data/incident_statistics.parquet` is a separate read-only synthetic statistical sample covering November 2023 through October 2026. Each row is one fictional incident (`id`, UTC `started_at`, stored `severity`, `synthetic: true`). The backend reads and groups it with DuckDB through `GET /api/incident-statistics?start_date=YYYY-MM-DD&end_date=YYYY-MM-DD`, including zero-count months. These statistical rows do not have detail pages and are never merged into the editable incident file. Run `uv sync` after updating dependencies. The 1,099-row sample is reproducible with `uv run python -m backend.statistics /tmp/incident_statistics.parquet` (the output path must not already exist); generation never overwrites a file.

**Editing by hand:**

- Keep IDs unique and references valid (related incidents, KPI sources, historical matches pointing to complete REX records). Each review needs exactly five whys; action IDs are unique within the review, with an owner, ISO date deadline and `a_faire`, `en_cours` or `termine` status. An invalid file is reported as an error and is never overwritten.
- When you change an incident's content, increase its `revision` by 1. This makes the UI show that the summary and KPIs are out of date.
- Manual edits don't trigger AI updates. Use the summary button or the KPI *Recalculate* button afterwards.
- Stop the web server before large edits.

To use a different dataset, copy the file and set `AIGUILLEUR_DATA_FILE=/path/to/copy.json`.

**Not saved:** recorded audio and chat conversations stay in the browser and disappear when you reload the page. Audio is never uploaded. Confirmed transcripts are saved and sent to Mistral.

## Configuration

| Variable | Used by | Purpose |
|---|---|---|
| `MISTRAL_API_KEY` | Web server, worker | API key. Never sent to the browser. |
| `SERVER_URL` | Web server, worker | Mistral API URL. Default `https://api.mistral.ai`. |
| `DEPLOYMENT_NAME` | Web server, worker | Routes workflow runs to your worker. Must match on both sides. |
| `AIGUILLEUR_DATA_FILE` | Web server | Optional path to another data file. |

## Development

```bash
make test-demo   # app and workflow tests (no network calls)
make check       # ruff on backend, worker and tests; mypy on backend and worker; workflow determinism rules
```

The tests cover saving and validation, the message and call flows, protection against outdated KPI results, routing of all five AI requests to their named workflows, worker discovery, JSON output mode, and invalid-response handling.

To try one workflow on its own against the real API:

```bash
uv run python .agents/skills/workflows/scripts/test_workflow.py worker/workflows/incident_assistant.py \
  --input '{"messages": [{"role": "user", "content": "Say hello."}]}' \
  --timeout 60
```

## Deployment

The `Dockerfile` builds **the worker only** (the frontend and tests are left out): Mistral Cloud runs it and it discovers all five workflows in `worker/workflows/` automatically. The web UI is not containerized; run it with `make demo`.

```bash
make docker-build
make docker-run   # passes .env values as environment variables
```

`.dockerignore` excludes `.env`, so the API key never ends up in the image.

## AI latency and diagnostics

All five workflows use `reasoning_effort="none"` for these short factual demo tasks. Prompts request concise answers (80 words for incident summaries and chats, 100 for call summaries). Token limits in `worker/model_call.py` are 256 for incident summaries/chats, 320 for call summaries, and 512 for KPI JSON. A truncated response is rejected, never silently displayed. Compact JSON removes whitespace, not incident content: transcripts, messages, summaries, KPIs, related and historical context are retained.

A 13-request end-to-end check on 13 October 2026 returned **11 answers below 8 s**, with a **5.98 s median** and no failures. The incident-assistant HTTP route completed in **5.59 s**. Two outliers took 13.32 s (assistant) and 19.36 s (KPIs); traces showed the time was spent in the model, not retries. This is a small measurement sample, not a latency guarantee. No streaming, fake responses or alternate model are used.

The original failed assistant run was picked up immediately; its model request took 84.4 s and the app terminated the workflow after its 80 s wait limit. We kept that safety limit rather than increasing it to hide the delay.

The backend logs the task, execution ID and elapsed seconds at workflow start/completion/timeout; it does not log prompts, answers or API keys. Use the execution ID to inspect the run and model activity in AI Studio. After Python changes, `make start-worker` reloads the worker automatically; restart `make demo` to load new backend prompts and logging.

## Limitations

- **One user, local machine.** The web server listens on `127.0.0.1`. Two processes writing the same JSON file aren't supported.
- **Only the model calls are durable.** The chain "call summary, then KPI update" runs in the web server. If you restart it mid-chain, the step shows as failed and you retry it from the UI.
- **Latency.** Most requests in the latest sample finished below 8 s, but model-load outliers still occur. Call summary and KPI extraction are sequential, so their combined time can exceed 8 s. See the measurements above.
- **Microphone** needs `localhost` or HTTPS. Browser speech recognition may send audio to the browser vendor's service; the UI says so.
- **Confirmed KPIs** are values stated explicitly in a message or call, not independently checked.
