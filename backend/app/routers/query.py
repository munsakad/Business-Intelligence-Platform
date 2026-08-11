import sqlite3

from fastapi import APIRouter, HTTPException

from .. import database, gemini_client
from ..models import QueryRequest

router = APIRouter(prefix="/api/datasets", tags=["query"])

SQL_SCHEMA = {
    "type": "object",
    "properties": {
        "sql": {"type": "string", "description": "A single SQLite SELECT statement."},
        "explanation": {
            "type": "string",
            "description": "One or two plain-English sentences describing what the query does.",
        },
    },
    "required": ["sql", "explanation"],
}

SYSTEM_INSTRUCTION = (
    "You are a senior data analyst who writes precise SQLite SQL. "
    "Given a table schema and a question, write ONE read-only SELECT statement "
    "(SQLite dialect) that answers the question. Rules: "
    "only query the table named 'data'; never use INSERT/UPDATE/DELETE/DROP/ALTER/PRAGMA/ATTACH; "
    "never use a semicolon or multiple statements; "
    "use column names exactly as given; "
    "if the question implies a chart-worthy aggregation, GROUP BY and ORDER BY sensibly and LIMIT results to at most 200 rows; "
    "prefer aliasing aggregate columns with clear names."
)


def _ask_gemini_for_sql(schema_text: str, question: str, prior_error: str | None = None) -> dict:
    prompt = f"Schema:\n{schema_text}\n\nQuestion: {question}"
    if prior_error:
        prompt += (
            f"\n\nYour previous SQL failed with this SQLite error:\n{prior_error}\n"
            "Fix the query and try again."
        )
    return gemini_client.generate_json(SYSTEM_INSTRUCTION, prompt, SQL_SCHEMA)


@router.post("/{dataset_id}/query")
async def run_nl_query(dataset_id: str, req: QueryRequest):
    try:
        database.get_dataset(dataset_id)
    except database.DatasetNotFound:
        raise HTTPException(404, "Dataset not found. Upload a CSV first.")

    schema_text = database.schema_for_prompt(dataset_id)

    try:
        gen = _ask_gemini_for_sql(schema_text, req.question)
    except gemini_client.GeminiNotConfigured as e:
        raise HTTPException(400, str(e))
    except Exception as e:
        raise HTTPException(502, f"Gemini request failed: {e}")

    sql = gen.get("sql", "")
    try:
        result = database.run_query(dataset_id, sql)
    except database.UnsafeSQLError as e:
        raise HTTPException(400, f"Generated query was rejected for safety: {e}")
    except sqlite3.Error as e:
        # give the model one chance to self-correct
        try:
            gen = _ask_gemini_for_sql(schema_text, req.question, prior_error=str(e))
            sql = gen.get("sql", "")
            result = database.run_query(dataset_id, sql)
        except database.UnsafeSQLError as e2:
            raise HTTPException(400, f"Generated query was rejected for safety: {e2}")
        except sqlite3.Error as e2:
            raise HTTPException(400, f"Generated SQL failed twice: {e2}")

    return {
        "question": req.question,
        "sql": result["sql"],
        "explanation": gen.get("explanation", ""),
        "columns": result["columns"],
        "rows": result["rows"],
        "row_count": result["row_count"],
    }
