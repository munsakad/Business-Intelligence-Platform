import json

from fastapi import APIRouter, HTTPException

from .. import database, gemini_client

router = APIRouter(prefix="/api/datasets", tags=["report"])

SYSTEM_INSTRUCTION = (
    "You are a senior business analyst writing an executive report about a dataset. "
    "You are given the table schema (with real min/max/mean/distinct-value statistics already "
    "computed) and a small sample of rows. Write a clear markdown report with these sections: "
    "## Executive Summary (2-4 sentences), ## Key Metrics (bullet list grounded in the given "
    "statistics), ## Trends & Patterns (what the data suggests, reasoning from the stats and "
    "sample rows, avoid inventing numbers not derivable from what's given), ## Data Quality Notes "
    "(nulls, possible issues), and ## Recommendations (3-5 concrete, actionable bullets). "
    "Only state numbers that are present in or directly derivable from the provided schema "
    "statistics or sample rows. Keep it concise and business-friendly, no more than ~450 words."
)


@router.post("/{dataset_id}/report")
async def generate_report(dataset_id: str):
    try:
        meta = database.get_dataset(dataset_id)
    except database.DatasetNotFound:
        raise HTTPException(404, "Dataset not found. Upload a CSV first.")

    schema_text = database.schema_for_prompt(dataset_id)
    sample_rows = json.dumps(meta["preview"][:10], default=str)

    prompt = (
        f"Dataset: {meta['filename']}, {meta['row_count']} rows.\n\n"
        f"Schema and statistics:\n{schema_text}\n\n"
        f"Sample rows (JSON):\n{sample_rows}"
    )

    try:
        markdown = gemini_client.generate_text(SYSTEM_INSTRUCTION, prompt)
    except gemini_client.GeminiNotConfigured as e:
        raise HTTPException(400, str(e))
    except Exception as e:
        raise HTTPException(502, f"Gemini request failed: {e}")

    return {"dataset_id": dataset_id, "markdown": markdown}
