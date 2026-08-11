# Cortex &mdash; AI Business Intelligence from a CSV

Upload a CSV. Gemini profiles it and generates a dashboard, answers natural-language
questions as SQL, writes a narrative report, and forecasts a trend &mdash; all running
as real queries against your data, not just text the model made up.

## Architecture

```
bi-platform/
  backend/     FastAPI + SQLite + Gemini API
  frontend/    React (Vite) + Recharts
```

**How the "grounding" works:** the model never invents chart numbers. For the dashboard
and SQL console, Gemini writes SQL; the backend validates it's a safe, single, read-only
`SELECT` and executes it against SQLite; only the real query results are shown. The
forecast's trend line is a plain linear regression computed in Python (numpy) &mdash;
Gemini only writes the plain-English commentary about it. The report is grounded in
column statistics (min/max/mean/distinct values) computed directly from your data.

| Feature | Endpoint | What happens |
|---|---|---|
| Upload | `POST /api/datasets/upload` | CSV &rarr; pandas &rarr; SQLite table `data`, schema + column stats inferred |
| List datasets | `GET /api/datasets` | Returns every previously uploaded dataset (persisted, newest first) |
| Delete dataset | `DELETE /api/datasets/{id}` | Removes a dataset's SQLite file and catalog entry |
| Dashboard | `POST /api/datasets/{id}/dashboard` | Gemini proposes 5-7 KPI/chart widgets as SQL; backend runs each query |
| SQL Console | `POST /api/datasets/{id}/query` | Gemini turns a question into one SELECT; backend runs it (auto-retries once on SQL error) |
| Report | `POST /api/datasets/{id}/report` | Gemini writes a markdown report from computed stats + a data sample |
| Forecast | `POST /api/datasets/{id}/forecast` | Backend aggregates + fits a linear trend; Gemini writes commentary |
| Health | `GET /api/health` | Reports whether a Gemini key is configured and how many datasets are stored |

**Frontend extras:** a "Recent datasets" list in the sidebar lets you jump back into any
previously uploaded dataset (or delete it) without re-uploading; a status dot in the sidebar
and a banner on the main page flag a missing `GEMINI_API_KEY` or an unreachable backend; SQL
Console results and dashboard tables have an "Export CSV" button, and reports have a
"Download .md" button.

## Prerequisites

- Python 3.11+
- Node.js 18+
- A Gemini API key from [Google AI Studio](https://aistudio.google.com/apikey)

## 1. Backend setup

```bash
cd backend
python3 -m venv venv
source venv/bin/activate        # Windows: venv\Scripts\activate
pip install -r requirements.txt

cp .env.example .env
# edit .env and paste your GEMINI_API_KEY

uvicorn app.main:app --reload --port 8000
```

The API is now at `http://localhost:8000` (interactive docs at `/docs`).

## 2. Frontend setup

In a second terminal:

```bash
cd frontend
npm install
cp .env.example .env   # default already points at http://localhost:8000
npm run dev
```

Open `http://localhost:5173`, upload a CSV, and go.

## Notes & limitations

- **Storage.** Uploaded datasets are stored as SQLite files under `backend/data/`, and the
  catalog of what's been uploaded (filename, schema, stats) is mirrored to
  `backend/data/catalog.json` so it survives a backend restart. This is still a single flat
  file with no per-user isolation or locking &mdash; swap it for a real database (e.g.
  Postgres) in `app/database.py` before deploying multi-user.
- **SQL safety.** Every AI-generated query is checked to be a single `SELECT`/`WITH`
  statement (no `INSERT`/`UPDATE`/`DELETE`/`DROP`/`ATTACH`/`PRAGMA`/etc.) and is executed
  over a **read-only** SQLite connection as a second layer of defense.
  This is meant for trusted, single-user local use &mdash; add auth, per-user
  rate limits, and stricter sandboxing before exposing it publicly.
  If it rejects a query, ask the SQL Console a differently-worded question.
- **Model name.** `backend/.env` defaults to `gemini-3.5-flash`. Google periodically retires
  older model names for new API keys &mdash; if you see a `404 NOT_FOUND ... no longer
  available to new users` error, list the models your key can actually call and swap
  `GEMINI_MODEL` to one of them (no code changes needed):
  ```bash
  cd backend && venv/Scripts/python -c "
  from dotenv import load_dotenv; load_dotenv()
  import os
  from google import genai
  client = genai.Client(api_key=os.getenv('GEMINI_API_KEY'))
  for m in client.models.list():
      methods = getattr(m, 'supported_actions', None) or getattr(m, 'supported_generation_methods', None)
      if methods and 'generateContent' in methods:
          print(m.name)
  "
  ```
  Note that a model showing up in that list doesn't guarantee it works for your key
  (some deprecated names are still enumerated) &mdash; if one still 404s, try the next.
- **Large CSVs.** Rows are capped (`MAX_UPLOAD_ROWS` in `backend/app/config.py`,
  default 500k) and query results are capped at 1000 rows returned to the UI; SQL
  aggregation still runs over the full table.
- **Forecast** uses a simple linear trend on the aggregated time series (day/week/month).
  It's a reasonable first pass, not a substitute for a proper seasonal/ARIMA model on
  data with strong seasonality.

## Extending it

- Swap SQLite for DuckDB or Postgres in `app/database.py` if you need bigger data or
  concurrent multi-user access.
- Add a persistence layer (e.g. a `datasets` table) so uploads survive a backend restart.
- Add auth (e.g. a simple API key or OAuth) before deploying anywhere shared.
- The dashboard/report/forecast prompts live at the top of each file in
  `backend/app/routers/` &mdash; tune them there.
