import { useEffect, useState } from "react";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { api } from "../api";
import "./Forecast.css";

export default function Forecast({ dataset }) {
  const [cols, setCols] = useState(null);
  const [dateCol, setDateCol] = useState("");
  const [valueCol, setValueCol] = useState("");
  const [granularity, setGranularity] = useState("month");
  const [periods, setPeriods] = useState(6);
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.forecastableColumns(dataset.dataset_id).then((c) => {
      setCols(c);
      setDateCol(c.date_columns[0] || "");
      setValueCol(c.numeric_columns[0] || "");
    });
  }, [dataset.dataset_id]);

  const run = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const r = await api.runForecast(dataset.dataset_id, {
        date_column: dateCol,
        value_column: valueCol,
        granularity,
        periods: Number(periods),
      });
      setResult(r);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const chartData = result
    ? [
        ...result.historical.map((h) => ({ period: h.period, historical: h.value })),
        {
          period: result.historical[result.historical.length - 1].period,
          historical: result.historical[result.historical.length - 1].value,
          forecast: result.historical[result.historical.length - 1].value,
        },
        ...result.forecast.map((f) => ({
          period: f.period,
          forecast: f.value,
          low: f.low,
          band: Math.max(f.high - f.low, 0),
        })),
      ]
    : [];

  return (
    <div className="panel-tab">
      <div className="panel-tab-head">
        <div>
          <h2>Forecast</h2>
          <p className="panel-tab-sub">
            Pick a date column and a numeric column. A linear trend is fitted to the aggregated
            history and projected forward; Gemini adds a short interpretation.
          </p>
        </div>
      </div>

      {cols && (
        <form className="forecast-form" onSubmit={run}>
          <label>
            <span>Date column</span>
            <select value={dateCol} onChange={(e) => setDateCol(e.target.value)}>
              {cols.date_columns.length === 0 && <option value="">No date columns found</option>}
              {cols.date_columns.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Value column</span>
            <select value={valueCol} onChange={(e) => setValueCol(e.target.value)}>
              {cols.numeric_columns.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Granularity</span>
            <select value={granularity} onChange={(e) => setGranularity(e.target.value)}>
              <option value="day">Day</option>
              <option value="week">Week</option>
              <option value="month">Month</option>
            </select>
          </label>
          <label className="forecast-periods">
            <span>Periods ahead</span>
            <input
              type="number"
              min={1}
              max={60}
              value={periods}
              onChange={(e) => setPeriods(e.target.value)}
            />
          </label>
          <button className="btn btn-primary" type="submit" disabled={loading || !dateCol || !valueCol}>
            {loading ? "Forecasting\u2026" : "Run forecast"}
          </button>
        </form>
      )}

      {error && <div className="banner banner-error">{error}</div>}

      {result && (
        <div className="forecast-result">
          <div className="forecast-chart">
            <ResponsiveContainer width="100%" height={320}>
              <ComposedChart data={chartData} margin={{ top: 8, right: 16, left: -10, bottom: 0 }}>
                <CartesianGrid stroke="#1e2a32" vertical={false} />
                <XAxis
                  dataKey="period"
                  tick={{ fill: "#8a9aa5", fontSize: 10 }}
                  tickLine={false}
                  axisLine={{ stroke: "#22303a" }}
                  minTickGap={24}
                />
                <YAxis tick={{ fill: "#8a9aa5", fontSize: 10 }} tickLine={false} axisLine={false} />
                <Tooltip
                  contentStyle={{
                    background: "#12191e",
                    border: "1px solid #22303a",
                    borderRadius: 4,
                    fontSize: 12,
                  }}
                  labelStyle={{ color: "#8a9aa5" }}
                />
                <Area
                  type="monotone"
                  dataKey="low"
                  stackId="band"
                  stroke="none"
                  fill="transparent"
                />
                <Area
                  type="monotone"
                  dataKey="band"
                  stackId="band"
                  stroke="none"
                  fill="#e8a33d"
                  fillOpacity={0.12}
                />
                <Line
                  type="monotone"
                  dataKey="historical"
                  stroke="#5b8def"
                  strokeWidth={2}
                  dot={false}
                />
                <Line
                  type="monotone"
                  dataKey="forecast"
                  stroke="#e8a33d"
                  strokeWidth={2}
                  strokeDasharray="5 4"
                  dot={false}
                />
              </ComposedChart>
            </ResponsiveContainer>
            <div className="forecast-legend">
              <span>
                <i className="dot dot-blue" /> historical
              </span>
              <span>
                <i className="dot dot-amber" /> forecast (dashed)
              </span>
              <span className="mono">trend: {result.trend_direction}</span>
            </div>
          </div>
          <div className="forecast-commentary">
            <div className="widget-title mono">AI commentary</div>
            <p>{result.commentary}</p>
          </div>
        </div>
      )}
    </div>
  );
}
