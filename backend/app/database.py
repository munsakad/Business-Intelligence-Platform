import json
import re
import sqlite3
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

from . import config

TABLE_NAME = "data"

# In-memory registry: dataset_id -> metadata dict. Mirrored to catalog.json on
# every change so the list of uploaded datasets survives a backend restart
# (the underlying per-dataset SQLite files were already persisted to disk).
_REGISTRY: dict[str, dict[str, Any]] = {}


class DatasetNotFound(Exception):
    pass


class UnsafeSQLError(Exception):
    pass


def _sqlite_path(dataset_id: str) -> Path:
    return config.DATA_DIR / f"{dataset_id}.sqlite"


def _catalog_path() -> Path:
    return config.DATA_DIR / "catalog.json"


def _save_catalog() -> None:
    path = _catalog_path()
    tmp = path.with_suffix(".json.tmp")
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(list(_REGISTRY.values()), f, default=str)
        tmp.replace(path)
    except OSError:
        pass  # best-effort; an upload still works for the current process


def _load_catalog() -> None:
    path = _catalog_path()
    if not path.exists():
        return
    try:
        with open(path, "r", encoding="utf-8") as f:
            items = json.load(f)
    except (OSError, json.JSONDecodeError):
        return
    for meta in items:
        dataset_id = meta.get("dataset_id")
        # skip stale entries whose underlying SQLite file is gone
        if dataset_id and Path(meta.get("path", "")).exists():
            _REGISTRY[dataset_id] = meta


_load_catalog()


def _infer_friendly_type(series: pd.Series) -> str:
    if pd.api.types.is_bool_dtype(series):
        return "boolean"
    if pd.api.types.is_datetime64_any_dtype(series):
        return "datetime"
    if pd.api.types.is_integer_dtype(series):
        return "integer"
    if pd.api.types.is_float_dtype(series):
        return "float"
    return "text"


def _try_parse_dates(series: pd.Series) -> pd.Series:
    """Best-effort: convert object columns that look like dates into datetime."""
    if series.dtype != object:
        return series
    sample = series.dropna().astype(str).head(20)
    if sample.empty:
        return series
    date_like = re.compile(r"^\d{4}[-/]\d{1,2}[-/]\d{1,2}|^\d{1,2}[-/]\d{1,2}[-/]\d{2,4}")
    hits = sample.apply(lambda v: bool(date_like.match(v.strip())))
    if hits.mean() < 0.8:
        return series
    parsed = pd.to_datetime(series, errors="coerce", format="mixed")
    if parsed.notna().mean() < 0.8:
        return series
    return parsed


def _profile_column(series: pd.Series, friendly_type: str) -> dict[str, Any]:
    profile: dict[str, Any] = {"null_count": int(series.isna().sum())}
    non_null = series.dropna()
    if friendly_type in ("integer", "float"):
        if len(non_null):
            profile.update(
                min=float(non_null.min()),
                max=float(non_null.max()),
                mean=round(float(non_null.mean()), 4),
            )
    elif friendly_type == "datetime":
        if len(non_null):
            profile.update(min=str(non_null.min()), max=str(non_null.max()))
    else:
        distinct = non_null.astype(str).nunique()
        profile["distinct_count"] = int(distinct)
        if distinct <= 20:
            profile["sample_values"] = sorted(non_null.astype(str).unique().tolist())[:20]
        else:
            profile["sample_values"] = non_null.astype(str).unique()[:5].tolist()
    return profile


def ingest_csv(file_bytes: bytes, filename: str) -> dict[str, Any]:
    df = pd.read_csv(pd.io.common.BytesIO(file_bytes))
    if df.empty:
        raise ValueError("CSV has no rows")
    if len(df) > config.MAX_UPLOAD_ROWS:
        raise ValueError(f"CSV has {len(df)} rows, max supported is {config.MAX_UPLOAD_ROWS}")

    # normalize column names to be SQL-friendly while keeping a display label
    original_columns = list(df.columns)
    clean_columns = []
    seen = set()
    for col in original_columns:
        clean = re.sub(r"\W+", "_", str(col).strip()).strip("_").lower() or "col"
        if clean[0].isdigit():
            clean = f"c_{clean}"
        base = clean
        i = 1
        while clean in seen:
            clean = f"{base}_{i}"
            i += 1
        seen.add(clean)
        clean_columns.append(clean)
    df.columns = clean_columns

    for col in df.columns:
        df[col] = _try_parse_dates(df[col])

    dataset_id = uuid.uuid4().hex[:12]
    path = _sqlite_path(dataset_id)
    conn = sqlite3.connect(path)
    try:
        df.to_sql(TABLE_NAME, conn, index=False, if_exists="replace")
    finally:
        conn.close()

    columns = []
    for orig, clean in zip(original_columns, clean_columns):
        ftype = _infer_friendly_type(df[clean])
        columns.append(
            {
                "name": clean,
                "original_name": str(orig),
                "type": ftype,
                "profile": _profile_column(df[clean], ftype),
            }
        )

    meta = {
        "dataset_id": dataset_id,
        "filename": filename,
        "uploaded_at": datetime.utcnow().isoformat() + "Z",
        "row_count": int(len(df)),
        "columns": columns,
        "path": str(path),
        "preview": df.head(config.MAX_PREVIEW_ROWS).astype(object).where(pd.notnull(df), None).to_dict(orient="records"),
    }
    _REGISTRY[dataset_id] = meta
    _save_catalog()
    return meta


def list_datasets() -> list[dict[str, Any]]:
    items = [
        {k: v for k, v in meta.items() if k not in ("path", "preview")}
        for meta in _REGISTRY.values()
    ]
    return sorted(items, key=lambda m: m.get("uploaded_at", ""), reverse=True)


def get_dataset(dataset_id: str) -> dict[str, Any]:
    meta = _REGISTRY.get(dataset_id)
    if not meta:
        raise DatasetNotFound(dataset_id)
    return meta


def delete_dataset(dataset_id: str) -> None:
    meta = _REGISTRY.pop(dataset_id, None)
    if not meta:
        raise DatasetNotFound(dataset_id)
    try:
        Path(meta["path"]).unlink(missing_ok=True)
    except OSError:
        pass
    _save_catalog()


def schema_for_prompt(dataset_id: str) -> str:
    meta = get_dataset(dataset_id)
    lines = [f"Table name: {TABLE_NAME}", f"Row count: {meta['row_count']}", "Columns:"]
    for col in meta["columns"]:
        p = col["profile"]
        extra = ""
        if col["type"] in ("integer", "float") and "min" in p:
            extra = f" (range {p['min']} to {p['max']}, avg {p.get('mean')})"
        elif col["type"] == "datetime" and "min" in p:
            extra = f" (range {p['min']} to {p['max']})"
        elif "sample_values" in p:
            extra = f" (examples: {', '.join(map(str, p['sample_values'][:6]))})"
        lines.append(f"  - {col['name']}: {col['type']}{extra}")
    return "\n".join(lines)


_FORBIDDEN = re.compile(
    r"\b(insert|update|delete|drop|alter|create|attach|detach|pragma|vacuum|replace\s+into|reindex)\b",
    re.IGNORECASE,
)


def validate_select_sql(sql: str) -> str:
    """Raise UnsafeSQLError unless sql is a single, read-only SELECT statement."""
    cleaned = sql.strip().rstrip(";").strip()
    if not cleaned:
        raise UnsafeSQLError("Empty query")
    if ";" in cleaned:
        raise UnsafeSQLError("Multiple statements are not allowed")
    if not re.match(r"^\s*(select|with)\b", cleaned, re.IGNORECASE):
        raise UnsafeSQLError("Only SELECT queries are allowed")
    if _FORBIDDEN.search(cleaned):
        raise UnsafeSQLError("Query contains a disallowed keyword")
    return cleaned


def run_query(dataset_id: str, sql: str, limit: int = config.MAX_QUERY_RESULT_ROWS) -> dict[str, Any]:
    meta = get_dataset(dataset_id)
    safe_sql = validate_select_sql(sql)
    # open read-only so even a bug in validation can't mutate the file
    uri = f"file:{meta['path']}?mode=ro"
    conn = sqlite3.connect(uri, uri=True)
    try:
        cur = conn.cursor()
        cur.execute(safe_sql)
        cols = [d[0] for d in cur.description] if cur.description else []
        rows = cur.fetchmany(limit)
        rows = [
            [v.item() if isinstance(v, (np.generic,)) else v for v in row]
            for row in rows
        ]
        return {"columns": cols, "rows": rows, "sql": safe_sql, "row_count": len(rows)}
    finally:
        conn.close()
