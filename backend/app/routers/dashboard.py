import sqlite3

from fastapi import APIRouter, HTTPException

from .. import database, gemini_client

router = APIRouter(prefix="/api/datasets", tags=["dashboard"])

DASHBOARD_SCHEMA = {
    "type": "object",
    "properties": {
        "title": {"type": "string"},
        "widgets": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "title": {"type": "string"},
                    "type": {
                        "type": "string",
                        "enum": ["kpi", "bar", "line", "pie", "table"],
                    },
                    "description": {
                        "type": "string",
                        "description": "One sentence on the insight this widget surfaces.",
                    },
                    "sql": {"type": "string", "description": "SQLite SELECT statement against table 'data'."},
                    "x_field": {"type": "string", "description": "Column from the SQL result used for the x-axis / label. Empty for kpi."},
                    "y_field": {"type": "string", "description": "Column from the SQL result used for the y-axis / value."},
                },
                "required": ["title", "type", "description", "sql", "x_field", "y_field"],
            },
        },
    },
    "required": ["title", "widgets"],
}

SYSTEM_INSTRUCTION = (
    "You are a BI analyst designing a dashboard for a dataset, similar to how a Power BI "
    "expert would. Given a table schema, propose 5 to 7 widgets total: include 2-3 'kpi' "
    "widgets (single headline numbers, e.g. totals/averages/counts), and the rest a mix of "
    "'bar', 'line', 'pie', or 'table' widgets that reveal the most useful trends, breakdowns, "
    "and outliers in the data. Rules for every widget: only query the table named 'data'; "
    "write ONE read-only SQLite SELECT per widget; never modify data; no semicolons; "
    "GROUP BY / ORDER BY / LIMIT sensibly (LIMIT 25 max for bar/pie/table, LIMIT 200 for line); "
    "for 'kpi' widgets the SQL must return exactly one row with one numeric column, x_field "
    "should be an empty string and y_field the column name; for line/bar/pie the SQL must return "
    "a label column and a numeric column, referenced by x_field and y_field respectively; "
    "use column names exactly as given in the schema. Favor time-based trends when a datetime "
    "column exists, and category breakdowns when text columns with low cardinality exist."
)


@router.post("/{dataset_id}/dashboard")
async def generate_dashboard(dataset_id: str):
    try:
        database.get_dataset(dataset_id)
    except database.DatasetNotFound:
        raise HTTPException(404, "Dataset not found. Upload a CSV first.")

    schema_text = database.schema_for_prompt(dataset_id)

    try:
        spec = gemini_client.generate_json(
            SYSTEM_INSTRUCTION, f"Schema:\n{schema_text}", DASHBOARD_SCHEMA
        )
    except gemini_client.GeminiNotConfigured as e:
        raise HTTPException(400, str(e))
    except Exception as e:
        raise HTTPException(502, f"Gemini request failed: {e}")

    widgets = []
    for w in spec.get("widgets", []):
        widget = {
            "title": w.get("title", "Untitled"),
            "type": w.get("type", "table"),
            "description": w.get("description", ""),
            "x_field": w.get("x_field") or None,
            "y_field": w.get("y_field") or None,
            "sql": w.get("sql", ""),
            "data": [],
            "error": None,
        }
        try:
            result = database.run_query(dataset_id, widget["sql"])
            rows = [dict(zip(result["columns"], row)) for row in result["rows"]]
            widget["data"] = rows
            widget["sql"] = result["sql"]
        except (database.UnsafeSQLError, sqlite3.Error) as e:
            widget["error"] = str(e)
        widgets.append(widget)

    return {"title": spec.get("title", "Dashboard"), "widgets": widgets}
