// Stand-in for the FastAPI backend in the static GitHub Pages build
// (VITE_DEMO=true). Uploaded CSVs are parsed and loaded into an in-browser
// SQLite database (sql.js / WebAssembly), and backend/app/routers are ported
// route-for-route: Gemini writes the SQL, the validated read-only SELECT runs
// against the real data, and forecasts are an actual least-squares fit.
// Without a Gemini key, the AI steps fall back to clearly labelled heuristics.
import initSqlJs from "sql.js";
import wasmUrl from "sql.js/dist/sql-wasm.wasm?url";
import Papa from "papaparse";
import { GEMINI_MODEL, GeminiNotConfigured, generateJson, generateText, hasKey } from "./gemini.js";
import { mountDemoPanel } from "./demoPanel.js";

const TABLE = "data";
const MAX_UPLOAD_ROWS = 500000;
const MAX_PREVIEW_ROWS = 25;
const MAX_QUERY_RESULT_ROWS = 1000;
const REPO_URL = "https://github.com/munsakad/Business-Intelligence-Platform";

const sqlReady = initSqlJs({ locateFile: () => wasmUrl });
const registry = new Map(); // dataset_id -> { meta, db }

class HttpError extends Error {
  constructor(status, detail) {
    super(detail);
    this.status = status;
  }
}
class UnsafeSQLError extends Error {}
class SqliteError extends Error {}

const q = (name) => '"' + String(name).replace(/"/g, '""') + '"';
const pyNum = (v) => (Number.isInteger(v) ? v.toFixed(1) : String(v));
const round = (v, d) => Math.round(v * 10 ** d) / 10 ** d;

// ---- ingest (port of database.ingest_csv) -------------------------------------
const NULLS = new Set(["", "NA", "N/A", "NaN", "nan", "null", "NULL", "None", "#N/A", "n/a", "<NA>"]);
const NUM = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;
const INT = /^[-+]?\d+$/;
const BOOL = /^(true|false)$/i;
const DATE_LIKE = /^\d{4}[-/]\d{1,2}[-/]\d{1,2}|^\d{1,2}[-/]\d{1,2}[-/]\d{2,4}/;

function cleanName(col, seen) {
  let clean = String(col).trim().replace(/\W+/g, "_").replace(/^_+|_+$/g, "").toLowerCase() || "col";
  if (/^\d/.test(clean)) clean = "c_" + clean;
  const base = clean;
  let i = 1;
  while (seen.has(clean)) clean = base + "_" + i++;
  seen.add(clean);
  return clean;
}

const pad = (n) => String(n).padStart(2, "0");
function parseDate(s) {
  let y, mo, d, h = 0, mi = 0, se = 0, m;
  if ((m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/))) {
    [y, mo, d] = [+m[1], +m[2], +m[3]];
    if (m[4]) [h, mi, se] = [+m[4], +m[5], +(m[6] || 0)];
  } else if ((m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})/))) {
    [mo, d, y] = [+m[1], +m[2], +m[3]]; // pandas default: month first
    if (y < 100) y += y < 69 ? 2000 : 1900;
  } else return null;
  const dt = new Date(Date.UTC(y, mo - 1, d, h, mi, se));
  if (dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return y + "-" + pad(mo) + "-" + pad(d) + " " + pad(h) + ":" + pad(mi) + ":" + pad(se);
}

function inferColumn(raw) {
  const vals = raw.map((v) => (v == null || NULLS.has(String(v).trim()) ? null : String(v).trim()));
  const nonNull = vals.filter((v) => v !== null);
  const hasNull = nonNull.length < vals.length;
  if (!nonNull.length) return { type: "float", values: vals };
  if (!hasNull && nonNull.every((v) => BOOL.test(v)))
    return { type: "boolean", values: vals.map((v) => (/^true$/i.test(v) ? 1 : 0)) };
  if (nonNull.every((v) => NUM.test(v))) {
    const isInt = !hasNull && nonNull.every((v) => INT.test(v));
    return { type: isInt ? "integer" : "float", values: vals.map((v) => (v === null ? null : Number(v))) };
  }
  const sample = nonNull.slice(0, 20);
  if (sample.filter((v) => DATE_LIKE.test(v)).length / sample.length >= 0.8) {
    const parsed = vals.map((v) => (v === null ? null : parseDate(v)));
    if (parsed.filter(Boolean).length / vals.length >= 0.8) return { type: "datetime", values: parsed };
  }
  return { type: "text", values: vals };
}

function profileColumn(type, values) {
  const nonNull = values.filter((v) => v !== null);
  const p = { null_count: values.length - nonNull.length };
  if (type === "integer" || type === "float") {
    if (nonNull.length) {
      let min = Infinity, max = -Infinity, sum = 0;
      for (const v of nonNull) {
        if (v < min) min = v;
        if (v > max) max = v;
        sum += v;
      }
      Object.assign(p, { min, max, mean: round(sum / nonNull.length, 4) });
    }
  } else if (type === "datetime") {
    if (nonNull.length) {
      const sorted = [...nonNull].sort();
      Object.assign(p, { min: sorted[0], max: sorted[sorted.length - 1] });
    }
  } else {
    const strs = nonNull.map((v) => (type === "boolean" ? (v ? "True" : "False") : String(v)));
    const uniq = [...new Set(strs)];
    p.distinct_count = uniq.length;
    p.sample_values = uniq.length <= 20 ? [...uniq].sort().slice(0, 20) : uniq.slice(0, 5);
  }
  return p;
}

async function ingestCsv(text, filename) {
  const parsed = Papa.parse(text, { skipEmptyLines: "greedy" });
  const [header, ...rows] = parsed.data;
  if (!header || !rows.length) throw new HttpError(400, "CSV has no rows");
  if (rows.length > MAX_UPLOAD_ROWS)
    throw new HttpError(400, "CSV has " + rows.length + " rows, max supported is " + MAX_UPLOAD_ROWS);

  const seen = new Set();
  const cols = header.map((h, j) => ({
    name: cleanName(h, seen),
    original: String(h),
    ...inferColumn(rows.map((r) => r[j])),
  }));

  const SQL = await sqlReady;
  const db = new SQL.Database();
  const sqlType = { integer: "INTEGER", float: "REAL", boolean: "INTEGER", datetime: "TIMESTAMP", text: "TEXT" };
  db.run("CREATE TABLE " + TABLE + " (" + cols.map((c) => q(c.name) + " " + sqlType[c.type]).join(", ") + ")");
  const stmt = db.prepare("INSERT INTO " + TABLE + " VALUES (" + cols.map(() => "?").join(", ") + ")");
  db.run("BEGIN");
  for (let i = 0; i < rows.length; i++) stmt.run(cols.map((c) => c.values[i] ?? null));
  db.run("COMMIT");
  stmt.free();

  const display = (c, i) => (c.type === "boolean" && c.values[i] !== null ? !!c.values[i] : c.values[i] ?? null);
  const meta = {
    dataset_id: crypto.randomUUID().replace(/-/g, "").slice(0, 12),
    filename,
    uploaded_at: new Date().toISOString(),
    row_count: rows.length,
    columns: cols.map((c) => ({
      name: c.name,
      original_name: c.original,
      type: c.type,
      profile: profileColumn(c.type, c.values),
    })),
    preview: rows
      .slice(0, MAX_PREVIEW_ROWS)
      .map((_, i) => Object.fromEntries(cols.map((c) => [c.name, display(c, i)]))),
  };
  registry.set(meta.dataset_id, { meta, db });
  return meta;
}

function schemaForPrompt(meta) {
  const lines = ["Table name: " + TABLE, "Row count: " + meta.row_count, "Columns:"];
  for (const col of meta.columns) {
    const p = col.profile;
    let extra = "";
    if ((col.type === "integer" || col.type === "float") && "min" in p)
      extra = " (range " + pyNum(p.min) + " to " + pyNum(p.max) + ", avg " + pyNum(p.mean) + ")";
    else if (col.type === "datetime" && "min" in p) extra = " (range " + p.min + " to " + p.max + ")";
    else if ("sample_values" in p) extra = " (examples: " + p.sample_values.slice(0, 6).join(", ") + ")";
    lines.push("  - " + col.name + ": " + col.type + extra);
  }
  return lines.join("\n");
}

// ---- read-only SQL (port of validate_select_sql / run_query) --------------------
const FORBIDDEN = /\b(insert|update|delete|drop|alter|create|attach|detach|pragma|vacuum|replace\s+into|reindex)\b/i;

function validateSelectSql(sql) {
  const cleaned = String(sql || "").trim().replace(/;+$/, "").trim();
  if (!cleaned) throw new UnsafeSQLError("Empty query");
  if (cleaned.includes(";")) throw new UnsafeSQLError("Multiple statements are not allowed");
  if (!/^\s*(select|with)\b/i.test(cleaned)) throw new UnsafeSQLError("Only SELECT queries are allowed");
  if (FORBIDDEN.test(cleaned)) throw new UnsafeSQLError("Query contains a disallowed keyword");
  return cleaned;
}

function runQuery(entry, sql, limit = MAX_QUERY_RESULT_ROWS) {
  const safeSql = validateSelectSql(sql);
  let stmt;
  try {
    stmt = entry.db.prepare(safeSql);
    const columns = stmt.getColumnNames();
    const rows = [];
    while (rows.length < limit && stmt.step()) rows.push(stmt.get());
    return { columns, rows, sql: safeSql, row_count: rows.length };
  } catch (e) {
    throw new SqliteError(e.message);
  } finally {
    stmt?.free();
  }
}

async function callGemini(fn) {
  try {
    return await fn();
  } catch (e) {
    throw new HttpError(e instanceof GeminiNotConfigured ? 400 : 502, e.message);
  }
}

// ---- dashboard (port of routers/dashboard.py) ----------------------------------
const DASHBOARD_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    widgets: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          type: { type: "string", enum: ["kpi", "bar", "line", "pie", "table"] },
          description: { type: "string", description: "One sentence on the insight this widget surfaces." },
          sql: { type: "string", description: "SQLite SELECT statement against table 'data'." },
          x_field: { type: "string", description: "Column from the SQL result used for the x-axis / label. Empty for kpi." },
          y_field: { type: "string", description: "Column from the SQL result used for the y-axis / value." },
        },
        required: ["title", "type", "description", "sql", "x_field", "y_field"],
      },
    },
  },
  required: ["title", "widgets"],
};

const DASHBOARD_SYSTEM =
  "You are a BI analyst designing a dashboard for a dataset, similar to how a Power BI " +
  "expert would. Given a table schema, propose 5 to 7 widgets total: include 2-3 'kpi' " +
  "widgets (single headline numbers, e.g. totals/averages/counts), and the rest a mix of " +
  "'bar', 'line', 'pie', or 'table' widgets that reveal the most useful trends, breakdowns, " +
  "and outliers in the data. Rules for every widget: only query the table named 'data'; " +
  "write ONE read-only SQLite SELECT per widget; never modify data; no semicolons; " +
  "GROUP BY / ORDER BY / LIMIT sensibly (LIMIT 25 max for bar/pie/table, LIMIT 200 for line); " +
  "for 'kpi' widgets the SQL must return exactly one row with one numeric column, x_field " +
  "should be an empty string and y_field the column name; for line/bar/pie the SQL must return " +
  "a label column and a numeric column, referenced by x_field and y_field respectively; " +
  "use column names exactly as given in the schema. Favor time-based trends when a datetime " +
  "column exists, and category breakdowns when text columns with low cardinality exist.";

function pickColumns(meta) {
  const nums = meta.columns.filter((c) => (c.type === "integer" || c.type === "float") && !/(^|_)id$/.test(c.name));
  const cats = meta.columns.filter(
    (c) => c.type === "text" && c.profile.distinct_count > 1 && c.profile.distinct_count <= 25
  );
  const date = meta.columns.find((c) => c.type === "datetime");
  const preferred = ["revenue", "sales", "amount", "total", "profit", "value", "cost", "price"];
  const measure = preferred.map((w) => nums.find((c) => c.name.includes(w))).find(Boolean) || nums[0];
  return { nums, cats, date, measure };
}

// offline stand-in for Gemini's dashboard spec; the SQL still runs for real
function heuristicDashboard(meta) {
  const { cats, date, measure } = pickColumns(meta);
  const w = [
    { title: "Total rows", type: "kpi", description: "Number of records in the dataset.",
      sql: "SELECT COUNT(*) AS row_count FROM data", x_field: "", y_field: "row_count" },
  ];
  if (measure) {
    const m = measure.name;
    w.push({ title: "Total " + m, type: "kpi", description: "Sum of " + m + " across all rows.",
      sql: "SELECT ROUND(SUM(" + q(m) + "), 2) AS " + q("total_" + m) + " FROM data", x_field: "", y_field: "total_" + m });
    w.push({ title: "Average " + m, type: "kpi", description: "Mean " + m + " per row.",
      sql: "SELECT ROUND(AVG(" + q(m) + "), 2) AS " + q("avg_" + m) + " FROM data", x_field: "", y_field: "avg_" + m });
  }
  const agg = measure ? "ROUND(SUM(" + q(measure.name) + "), 2)" : "COUNT(*)";
  const yf = measure ? measure.name : "row_count";
  if (date) {
    w.push({ title: yf + " by month", type: "line", description: "Monthly trend of " + yf + ".",
      sql: "SELECT strftime('%Y-%m', " + q(date.name) + ") AS month, " + agg + " AS " + q(yf) + " FROM data WHERE " +
        q(date.name) + " IS NOT NULL GROUP BY month ORDER BY month LIMIT 200", x_field: "month", y_field: yf });
  }
  cats.slice(0, 2).forEach((c, i) => {
    w.push({ title: yf + " by " + c.name, type: i === 0 ? "bar" : "pie",
      description: "How " + yf + " splits across " + c.name + ".",
      sql: "SELECT " + q(c.name) + " AS " + q(c.name) + ", " + agg + " AS " + q(yf) + " FROM data GROUP BY " + q(c.name) +
        " ORDER BY " + q(yf) + " DESC LIMIT 25", x_field: c.name, y_field: yf });
  });
  if (measure) {
    w.push({ title: "Top 10 rows by " + measure.name, type: "table", description: "Largest individual records.",
      sql: "SELECT * FROM data ORDER BY " + q(measure.name) + " DESC LIMIT 10", x_field: "", y_field: "" });
  }
  return { title: meta.filename + " overview (offline heuristic)", widgets: w };
}

async function generateDashboard(entry) {
  const spec = hasKey()
    ? await callGemini(() => generateJson(DASHBOARD_SYSTEM, "Schema:\n" + schemaForPrompt(entry.meta), DASHBOARD_SCHEMA))
    : heuristicDashboard(entry.meta);
  const widgets = (spec.widgets || []).map((w) => {
    const widget = {
      title: w.title || "Untitled",
      type: w.type || "table",
      description: w.description || "",
      x_field: w.x_field || null,
      y_field: w.y_field || null,
      sql: w.sql || "",
      data: [],
      error: null,
    };
    try {
      const result = runQuery(entry, widget.sql);
      widget.data = result.rows.map((row) => Object.fromEntries(result.columns.map((c, i) => [c, row[i]])));
      widget.sql = result.sql;
    } catch (e) {
      widget.error = e.message;
    }
    return widget;
  });
  return { title: spec.title || "Dashboard", widgets };
}

// ---- natural-language SQL (port of routers/query.py) -----------------------------
const SQL_SCHEMA = {
  type: "object",
  properties: {
    sql: { type: "string", description: "A single SQLite SELECT statement." },
    explanation: { type: "string", description: "One or two plain-English sentences describing what the query does." },
  },
  required: ["sql", "explanation"],
};

const QUERY_SYSTEM =
  "You are a senior data analyst who writes precise SQLite SQL. " +
  "Given a table schema and a question, write ONE read-only SELECT statement " +
  "(SQLite dialect) that answers the question. Rules: " +
  "only query the table named 'data'; never use INSERT/UPDATE/DELETE/DROP/ALTER/PRAGMA/ATTACH; " +
  "never use a semicolon or multiple statements; " +
  "use column names exactly as given; " +
  "if the question implies a chart-worthy aggregation, GROUP BY and ORDER BY sensibly and LIMIT results to at most 200 rows; " +
  "prefer aliasing aggregate columns with clear names.";

// offline answers for the console's three example prompts
function offlineSql(meta, question) {
  const { cats, measure } = pickColumns(meta);
  const key = question.trim().toLowerCase();
  if (key === "what are the top 5 rows by value?" && measure)
    return { sql: "SELECT * FROM data ORDER BY " + q(measure.name) + " DESC LIMIT 5",
      explanation: "Offline heuristic: the five rows with the highest " + measure.name + "." };
  if (key === "show totals grouped by category" && cats[0]) {
    const c = cats[0].name;
    const agg = measure ? ", ROUND(SUM(" + q(measure.name) + "), 2) AS " + q("total_" + measure.name) : "";
    return { sql: "SELECT " + q(c) + ", COUNT(*) AS row_count" + agg + " FROM data GROUP BY " + q(c) + " ORDER BY row_count DESC",
      explanation: "Offline heuristic: row counts" + (measure ? " and total " + measure.name : "") + " for each " + c + "." };
  }
  if (key === "how many rows have missing data?")
    return { sql: "SELECT COUNT(*) AS rows_with_missing_data FROM data WHERE " +
        meta.columns.map((c) => q(c.name) + " IS NULL").join(" OR "),
      explanation: "Offline heuristic: counts rows where any column is empty." };
  return null;
}

async function runNlQuery(entry, question) {
  const schemaText = schemaForPrompt(entry.meta);
  const ask = async (priorError) => {
    if (!hasKey()) {
      const offline = offlineSql(entry.meta, question);
      if (!offline)
        throw new HttpError(400, "Offline mode only answers the example questions. Add a Gemini API key in the demo panel to ask anything.");
      return offline;
    }
    let prompt = "Schema:\n" + schemaText + "\n\nQuestion: " + question;
    if (priorError)
      prompt += "\n\nYour previous SQL failed with this SQLite error:\n" + priorError + "\nFix the query and try again.";
    return callGemini(() => generateJson(QUERY_SYSTEM, prompt, SQL_SCHEMA));
  };

  let gen = await ask();
  let result;
  try {
    result = runQuery(entry, gen.sql);
  } catch (e) {
    if (e instanceof UnsafeSQLError) throw new HttpError(400, "Generated query was rejected for safety: " + e.message);
    try {
      gen = await ask(e.message); // one chance to self-correct
      result = runQuery(entry, gen.sql);
    } catch (e2) {
      if (e2 instanceof HttpError) throw e2;
      if (e2 instanceof UnsafeSQLError) throw new HttpError(400, "Generated query was rejected for safety: " + e2.message);
      throw new HttpError(400, "Generated SQL failed twice: " + e2.message);
    }
  }
  return {
    question,
    sql: result.sql,
    explanation: gen.explanation || "",
    columns: result.columns,
    rows: result.rows,
    row_count: result.row_count,
  };
}

// ---- report (port of routers/report.py) ------------------------------------------
const REPORT_SYSTEM =
  "You are a senior business analyst writing an executive report about a dataset. " +
  "You are given the table schema (with real min/max/mean/distinct-value statistics already " +
  "computed) and a small sample of rows. Write a clear markdown report with these sections: " +
  "## Executive Summary (2-4 sentences), ## Key Metrics (bullet list grounded in the given " +
  "statistics), ## Trends & Patterns (what the data suggests, reasoning from the stats and " +
  "sample rows, avoid inventing numbers not derivable from what's given), ## Data Quality Notes " +
  "(nulls, possible issues), and ## Recommendations (3-5 concrete, actionable bullets). " +
  "Only state numbers that are present in or directly derivable from the provided schema " +
  "statistics or sample rows. Keep it concise and business-friendly, no more than ~450 words.";

function offlineReport(meta) {
  const fmt = (v) => (typeof v === "number" ? v.toLocaleString(undefined, { maximumFractionDigits: 2 }) : v);
  const byType = {};
  meta.columns.forEach((c) => (byType[c.type] = (byType[c.type] || 0) + 1));
  const lines = [
    "> Offline mode: this report is a template filled from the computed column statistics. " +
      "Add a Gemini API key in the demo panel for an AI-written analysis.",
    "",
    "## Executive Summary",
    "**" + meta.filename + "** has " + meta.row_count.toLocaleString() + " rows across " + meta.columns.length +
      " columns (" + Object.entries(byType).map(([t, n]) => n + " " + t).join(", ") + ").",
    "",
    "## Key Metrics",
  ];
  for (const c of meta.columns) {
    const p = c.profile;
    if ((c.type === "integer" || c.type === "float") && "min" in p)
      lines.push("- **" + c.name + "**: " + fmt(p.min) + " to " + fmt(p.max) + ", average " + fmt(p.mean));
    else if (c.type === "datetime" && "min" in p) lines.push("- **" + c.name + "**: covers " + p.min + " to " + p.max);
    else if ("distinct_count" in p) lines.push("- **" + c.name + "**: " + p.distinct_count.toLocaleString() + " distinct values");
  }
  lines.push("", "## Data Quality Notes");
  const gaps = meta.columns.filter((c) => c.profile.null_count > 0);
  if (!gaps.length) lines.push("- No missing values detected.");
  gaps.forEach((c) =>
    lines.push("- **" + c.name + "** has " + c.profile.null_count.toLocaleString() + " missing values (" +
      ((c.profile.null_count / meta.row_count) * 100).toFixed(1) + "% of rows).")
  );
  lines.push(
    "",
    "## Recommendations",
    "- Use the Dashboard tab for breakdowns by the low-cardinality text columns.",
    "- Run a Forecast on any date + numeric pair to check the trend direction.",
    gaps.length ? "- Decide how to treat the missing values above before reporting totals." : "- Data is complete; totals can be reported as-is."
  );
  return lines.join("\n");
}

async function generateReport(entry) {
  const { meta } = entry;
  if (!hasKey()) return { dataset_id: meta.dataset_id, markdown: offlineReport(meta) };
  const prompt =
    "Dataset: " + meta.filename + ", " + meta.row_count + " rows.\n\n" +
    "Schema and statistics:\n" + schemaForPrompt(meta) + "\n\n" +
    "Sample rows (JSON):\n" + JSON.stringify(meta.preview.slice(0, 10));
  const markdown = await callGemini(() => generateText(REPORT_SYSTEM, prompt));
  return { dataset_id: meta.dataset_id, markdown };
}

// ---- forecast (port of routers/forecast.py) ----------------------------------------
const FORECAST_SYSTEM =
  "You are a business analyst. Given a historical time series summary and a computed linear " +
  "forecast, write a short (3-5 sentence) plain-English commentary: describe the trend " +
  "direction and rate, call out any caution about relying on a simple linear projection, and " +
  "give one practical suggestion. Do not invent numbers beyond what's given.";

const DAY_MS = 86400000;
// pandas resample labels: "D" = day, "W" = week ending Sunday, "MS" = month start
function bucketOf(ms, g) {
  const d = new Date(ms);
  const [y, m, day] = [d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()];
  if (g === "day") return Date.UTC(y, m, day);
  if (g === "month") return Date.UTC(y, m, 1);
  return Date.UTC(y, m, day + ((7 - d.getUTCDay()) % 7));
}
function nextBucket(ms, g) {
  if (g === "day") return ms + DAY_MS;
  if (g === "week") return ms + 7 * DAY_MS;
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}
const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);

async function runForecast(entry, req) {
  const { date_column, value_column, periods = 12, granularity = "month" } = req;
  if (!["day", "week", "month"].includes(granularity))
    throw new HttpError(400, "granularity must be one of ['day', 'week', 'month']");
  if (periods < 1 || periods > 60) throw new HttpError(400, "periods must be between 1 and 60");

  const sql =
    "SELECT strftime('%Y-%m-%d', " + date_column + ") as day, SUM(" + value_column + ") as value FROM data " +
    "WHERE " + date_column + " IS NOT NULL AND " + value_column + " IS NOT NULL GROUP BY day ORDER BY day";
  let result;
  try {
    result = runQuery(entry, sql);
  } catch (e) {
    if (e instanceof UnsafeSQLError) throw new HttpError(400, e.message);
    throw new HttpError(400, "Could not aggregate '" + date_column + "'/'" + value_column + "': " + e.message +
      ". Make sure you picked a date column and a numeric column.");
  }
  const points = result.rows.filter((r) => r[0] && r[1] !== null);
  if (points.length < 3) throw new HttpError(400, "Not enough data points (need at least 3) to forecast");

  const sums = new Map();
  for (const [day, value] of points) {
    const b = bucketOf(Date.parse(day + "T00:00:00Z"), granularity);
    sums.set(b, (sums.get(b) || 0) + Number(value));
  }
  const keys = [...sums.keys()].sort((a, b) => a - b);
  const series = [];
  for (let b = keys[0]; b <= keys[keys.length - 1]; b = nextBucket(b, granularity)) series.push([b, sums.get(b) || 0]);
  if (series.length < 3) throw new HttpError(400, "Not enough periods after aggregation to forecast");

  // np.polyfit(x, y, 1)
  const n = series.length;
  const xs = series.map((_, i) => i);
  const ys = series.map(([, v]) => v);
  const xm = (n - 1) / 2;
  const ym = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  xs.forEach((x, i) => {
    num += (x - xm) * (ys[i] - ym);
    den += (x - xm) ** 2;
  });
  const slope = num / den;
  const intercept = ym - slope * xm;
  const residualStd = Math.sqrt(ys.reduce((s, y, i) => s + (y - (slope * i + intercept)) ** 2, 0) / n);

  const historical = series.map(([b, v]) => ({ period: isoDay(b), value: round(v, 4) }));
  const forecast = [];
  let b = series[n - 1][0];
  for (let i = 0; i < periods; i++) {
    b = nextBucket(b, granularity);
    const v = slope * (n + i) + intercept;
    forecast.push({ period: isoDay(b), value: round(v, 4), low: round(v - 1.28 * residualStd, 4), high: round(v + 1.28 * residualStd, 4) });
  }

  const trend = slope > 0 ? "increasing" : slope < 0 ? "decreasing" : "flat";
  let commentary;
  if (hasKey()) {
    const prompt =
      "Historical series (" + granularity + "ly, " + n + " points) of " + value_column + ": " +
      "starts at " + pyNum(historical[0].value) + ", ends at " + pyNum(historical[n - 1].value) + ". " +
      "Linear trend slope per period: " + pyNum(round(slope, 4)) + " (" + trend + "). " +
      "Forecasted next " + periods + " period(s): from " + pyNum(forecast[0].value) + " to " + pyNum(forecast[periods - 1].value) + ".";
    try {
      commentary = await generateText(FORECAST_SYSTEM, prompt, 0.3);
    } catch (e) {
      commentary = "AI commentary unavailable (" + e.message + ")";
    }
  } else {
    commentary =
      "Offline commentary: " + value_column + " is " + trend + " by about " +
      Math.abs(slope).toLocaleString(undefined, { maximumFractionDigits: 2 }) + " per " + granularity +
      " across " + n + " periods. A straight-line fit ignores seasonality and one-off spikes, so treat the shaded band " +
      "as a rough range rather than a promise. Add a Gemini API key in the demo panel for AI-written commentary.";
  }

  return {
    date_column,
    value_column,
    granularity,
    historical,
    forecast,
    trend_direction: trend,
    slope_per_period: round(slope, 6),
    commentary,
  };
}

// ---- sample dataset so the demo is useful before anything is uploaded -----------------
function sampleSalesCsv() {
  let seed = 20240501;
  const rand = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pick = (items, weights) => {
    let r = rand() * weights.reduce((a, b) => a + b, 0);
    for (let i = 0; i < items.length; i++) if ((r -= weights[i]) < 0) return items[i];
    return items[items.length - 1];
  };
  const prices = { Electronics: [120, 900], Furniture: [80, 650], "Office Supplies": [4, 60], Software: [30, 400], Accessories: [10, 120] };
  const start = Date.UTC(2024, 0, 1);
  const days = 731;
  const orders = [];
  while (orders.length < 2400) {
    const day = Math.floor(rand() * days);
    const month = new Date(start + day * DAY_MS).getUTCMonth();
    const seasonal = month >= 10 ? 1.3 : month === 6 || month === 7 ? 0.85 : 1;
    if (rand() > ((0.6 + 0.4 * (day / days)) * seasonal) / 1.3) continue; // growth + Q4 peak
    const category = pick(Object.keys(prices), [3, 2, 4, 2, 3]);
    const segment = pick(["Consumer", "Small Business", "Enterprise"], [5, 3, 2]);
    const [lo, hi] = prices[category];
    const unitPrice = round(lo + (hi - lo) * rand(), 2);
    let units = 1 + Math.floor(rand() * (category === "Office Supplies" ? 30 : 6));
    if (segment === "Enterprise") units *= 3;
    const discount = pick([0, 5, 10, 15, 20], [5, 3, 2, 1, 1]);
    orders.push({
      day,
      region: pick(["North", "South", "East", "West"], [3, 2, 3, 2]),
      category,
      channel: pick(["Online", "Retail", "Partner"], [5, 3, 2]),
      segment,
      units,
      unitPrice,
      discount: rand() < 0.03 ? "" : discount, // a few blanks for the data-quality checks
      revenue: round(units * unitPrice * (1 - discount / 100), 2),
    });
  }
  orders.sort((a, b) => a.day - b.day);
  const header = "Order ID,Order Date,Region,Product Category,Sales Channel,Customer Segment,Units,Unit Price,Discount %,Revenue";
  return [header]
    .concat(orders.map((o, i) => ["SO-" + (10001 + i), isoDay(start + o.day * DAY_MS), o.region, o.category, o.channel,
      o.segment, o.units, o.unitPrice, o.discount, o.revenue].join(",")))
    .join("\n");
}

// ---- routing -----------------------------------------------------------------------
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

const listing = () =>
  [...registry.values()]
    .map(({ meta }) => {
      const { preview, ...rest } = meta;
      return rest;
    })
    .sort((a, b) => b.uploaded_at.localeCompare(a.uploaded_at));

let seeded = null;
const ready = () => (seeded ??= ingestCsv(sampleSalesCsv(), "sample_sales.csv"));

async function route(url, init = {}) {
  await ready();
  const u = new URL(url, window.location.href);
  const path = u.pathname.slice(u.pathname.indexOf("/api/"));
  const method = (init.method || "GET").toUpperCase();
  const body = () => JSON.parse(init.body || "{}");

  if (path === "/api/health")
    return json({ status: "ok", gemini_configured: true, gemini_model: hasKey() ? GEMINI_MODEL : "offline mode",
      dataset_count: registry.size });

  if (path === "/api/datasets/upload" && method === "POST") {
    const file = init.body?.get?.("file");
    if (!file || !file.name.toLowerCase().endsWith(".csv")) throw new HttpError(400, "Please upload a .csv file");
    return json(await ingestCsv(await file.text(), file.name));
  }
  if (path === "/api/datasets" && method === "GET") return json(listing());

  const m = path.match(/^\/api\/datasets\/([^/]+)(?:\/([a-z-]+))?$/);
  if (m) {
    const [, id, action] = m;
    const entry = registry.get(id);
    if (!entry) throw new HttpError(404, "Dataset not found. Upload a CSV first.");
    if (!action && method === "GET") return json(entry.meta);
    if (!action && method === "DELETE") {
      entry.db.close();
      registry.delete(id);
      return json({ deleted: id });
    }
    if (action === "query" && method === "POST") return json(await runNlQuery(entry, String(body().question || "")));
    if (action === "dashboard" && method === "POST") return json(await generateDashboard(entry));
    if (action === "report" && method === "POST") return json(await generateReport(entry));
    if (action === "forecastable-columns") {
      const cols = entry.meta.columns;
      return json({
        date_columns: cols.filter((c) => c.type === "datetime").map((c) => c.name),
        numeric_columns: cols.filter((c) => c.type === "integer" || c.type === "float").map((c) => c.name),
      });
    }
    if (action === "forecast" && method === "POST") return json(await runForecast(entry, body()));
  }
  return json({ detail: "Not Found" }, 404);
}

export function install() {
  const realFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    if (!url.includes("/api/")) return realFetch(input, init);
    return route(url, init).catch((e) =>
      json({ detail: e instanceof HttpError ? e.message : "Unexpected error: " + e.message }, e.status || 500)
    );
  };
  mountDemoPanel({
    repoUrl: REPO_URL,
    note:
      "No server here: CSVs load into SQLite compiled to WebAssembly in your browser, and the FastAPI routes " +
      "are ported to JS. A sample sales dataset is preloaded; upload your own CSV anytime.",
    offlineNote: "Offline mode uses heuristic dashboards and templated reports; the SQL still runs on your data.",
  });
}
