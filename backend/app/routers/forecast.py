import numpy as np
import pandas as pd
from fastapi import APIRouter, HTTPException

from .. import database, gemini_client
from ..models import ForecastRequest

router = APIRouter(prefix="/api/datasets", tags=["forecast"])

FREQ_MAP = {"day": "D", "week": "W", "month": "MS"}

SYSTEM_INSTRUCTION = (
    "You are a business analyst. Given a historical time series summary and a computed linear "
    "forecast, write a short (3-5 sentence) plain-English commentary: describe the trend "
    "direction and rate, call out any caution about relying on a simple linear projection, and "
    "give one practical suggestion. Do not invent numbers beyond what's given."
)


@router.get("/{dataset_id}/forecastable-columns")
async def forecastable_columns(dataset_id: str):
    try:
        meta = database.get_dataset(dataset_id)
    except database.DatasetNotFound:
        raise HTTPException(404, "Dataset not found. Upload a CSV first.")
    date_cols = [c["name"] for c in meta["columns"] if c["type"] == "datetime"]
    numeric_cols = [c["name"] for c in meta["columns"] if c["type"] in ("integer", "float")]
    return {"date_columns": date_cols, "numeric_columns": numeric_cols}


@router.post("/{dataset_id}/forecast")
async def forecast(dataset_id: str, req: ForecastRequest):
    try:
        database.get_dataset(dataset_id)
    except database.DatasetNotFound:
        raise HTTPException(404, "Dataset not found. Upload a CSV first.")

    if req.granularity not in FREQ_MAP:
        raise HTTPException(400, f"granularity must be one of {list(FREQ_MAP)}")
    if req.periods < 1 or req.periods > 60:
        raise HTTPException(400, "periods must be between 1 and 60")

    sql = (
        f"SELECT strftime('%Y-%m-%d', {req.date_column}) as day, "
        f"SUM({req.value_column}) as value FROM data "
        f"WHERE {req.date_column} IS NOT NULL AND {req.value_column} IS NOT NULL "
        f"GROUP BY day ORDER BY day"
    )
    try:
        result = database.run_query(dataset_id, sql)
    except database.UnsafeSQLError as e:
        raise HTTPException(400, str(e))
    except Exception as e:
        raise HTTPException(
            400,
            f"Could not aggregate '{req.date_column}'/'{req.value_column}': {e}. "
            "Make sure you picked a date column and a numeric column.",
        )

    if len(result["rows"]) < 3:
        raise HTTPException(400, "Not enough data points (need at least 3) to forecast")

    df = pd.DataFrame(result["rows"], columns=result["columns"])
    df["day"] = pd.to_datetime(df["day"])
    df = df.set_index("day").sort_index()

    freq = FREQ_MAP[req.granularity]
    series = df["value"].resample(freq).sum()
    series = series.fillna(0)

    if len(series) < 3:
        raise HTTPException(400, "Not enough periods after aggregation to forecast")

    x = np.arange(len(series))
    y = series.values.astype(float)
    slope, intercept = np.polyfit(x, y, 1)
    fitted = slope * x + intercept
    residual_std = float(np.std(y - fitted)) if len(y) > 2 else 0.0

    future_x = np.arange(len(series), len(series) + req.periods)
    future_y = slope * future_x + intercept
    future_index = pd.date_range(
        start=series.index[-1], periods=req.periods + 1, freq=freq
    )[1:]

    historical = [
        {"period": str(idx.date()), "value": round(float(v), 4)}
        for idx, v in series.items()
    ]
    forecast_points = [
        {
            "period": str(idx.date()),
            "value": round(float(v), 4),
            "low": round(float(v - 1.28 * residual_std), 4),
            "high": round(float(v + 1.28 * residual_std), 4),
        }
        for idx, v in zip(future_index, future_y)
    ]

    trend_direction = "increasing" if slope > 0 else ("decreasing" if slope < 0 else "flat")
    prompt = (
        f"Historical series ({req.granularity}ly, {len(series)} points) of {req.value_column}: "
        f"starts at {historical[0]['value']}, ends at {historical[-1]['value']}. "
        f"Linear trend slope per period: {round(float(slope), 4)} ({trend_direction}). "
        f"Forecasted next {req.periods} period(s): from {forecast_points[0]['value']} to "
        f"{forecast_points[-1]['value']}."
    )

    commentary = ""
    try:
        commentary = gemini_client.generate_text(SYSTEM_INSTRUCTION, prompt, temperature=0.3)
    except gemini_client.GeminiNotConfigured:
        commentary = (
            "AI commentary unavailable: set GEMINI_API_KEY in backend/.env to enable it."
        )
    except Exception as e:
        commentary = f"AI commentary unavailable ({e})"

    return {
        "date_column": req.date_column,
        "value_column": req.value_column,
        "granularity": req.granularity,
        "historical": historical,
        "forecast": forecast_points,
        "trend_direction": trend_direction,
        "slope_per_period": round(float(slope), 6),
        "commentary": commentary,
    }
