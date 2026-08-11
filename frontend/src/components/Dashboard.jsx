import { useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { api } from "../api";
import { downloadCsv } from "../utils/export";
import "./Dashboard.css";

const PIE_COLORS = ["#e8a33d", "#5b8def", "#4fbf85", "#a685e2", "#e8615f", "#6fb7d1"];

function KpiWidget({ widget }) {
  const value = widget.data?.[0]?.[widget.y_field];
  const display =
    typeof value === "number"
      ? value.toLocaleString(undefined, { maximumFractionDigits: 2 })
      : value ?? "\u2014";
  return (
    <div className="widget widget-kpi">
      <div className="widget-title mono">{widget.title}</div>
      <div className="widget-kpi-value mono">{display}</div>
      <div className="widget-desc">{widget.description}</div>
    </div>
  );
}

function ChartWidget({ widget }) {
  const data = widget.data || [];
  return (
    <div className="widget widget-chart">
      <div className="widget-title mono">{widget.title}</div>
      <div className="widget-chart-body">
        <ResponsiveContainer width="100%" height={200}>
          {widget.type === "bar" ? (
            <BarChart data={data} margin={{ top: 4, right: 8, left: -18, bottom: 0 }}>
              <CartesianGrid stroke="#1e2a32" vertical={false} />
              <XAxis
                dataKey={widget.x_field}
                tick={{ fill: "#8a9aa5", fontSize: 10 }}
                tickLine={false}
                axisLine={{ stroke: "#22303a" }}
              />
              <YAxis tick={{ fill: "#8a9aa5", fontSize: 10 }} tickLine={false} axisLine={false} />
              <Tooltip contentStyle={tooltipStyle} labelStyle={{ color: "#8a9aa5" }} />
              <Bar dataKey={widget.y_field} fill="#5b8def" radius={[3, 3, 0, 0]} />
            </BarChart>
          ) : widget.type === "line" ? (
            <LineChart data={data} margin={{ top: 4, right: 8, left: -18, bottom: 0 }}>
              <CartesianGrid stroke="#1e2a32" vertical={false} />
              <XAxis
                dataKey={widget.x_field}
                tick={{ fill: "#8a9aa5", fontSize: 10 }}
                tickLine={false}
                axisLine={{ stroke: "#22303a" }}
              />
              <YAxis tick={{ fill: "#8a9aa5", fontSize: 10 }} tickLine={false} axisLine={false} />
              <Tooltip contentStyle={tooltipStyle} labelStyle={{ color: "#8a9aa5" }} />
              <Line
                type="monotone"
                dataKey={widget.y_field}
                stroke="#e8a33d"
                strokeWidth={2}
                dot={false}
              />
            </LineChart>
          ) : (
            <PieChart margin={{ top: 4, right: 4, left: 4, bottom: 4 }}>
              <Tooltip contentStyle={tooltipStyle} labelStyle={{ color: "#8a9aa5" }} />
              <Pie
                data={data}
                dataKey={widget.y_field}
                nameKey={widget.x_field}
                outerRadius={72}
                strokeWidth={1}
                stroke="#0b1014"
              >
                {data.map((_, i) => (
                  <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                ))}
              </Pie>
            </PieChart>
          )}
        </ResponsiveContainer>
      </div>
      <div className="widget-desc">{widget.description}</div>
    </div>
  );
}

function TableWidget({ widget }) {
  const rows = widget.data || [];
  const cols = rows.length ? Object.keys(rows[0]) : [];
  return (
    <div className="widget widget-table">
      <div className="widget-title-row">
        <div className="widget-title mono">{widget.title}</div>
        {rows.length > 0 && (
          <button
            className="link-btn"
            onClick={() =>
              downloadCsv(`${widget.title || "table"}.csv`, cols, rows)
            }
          >
            Export CSV
          </button>
        )}
      </div>
      <div className="widget-table-scroll">
        <table>
          <thead>
            <tr>
              {cols.map((c) => (
                <th key={c} className="mono">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, 25).map((r, i) => (
              <tr key={i}>
                {cols.map((c) => (
                  <td key={c} className="mono">
                    {String(r[c])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="widget-desc">{widget.description}</div>
    </div>
  );
}

const tooltipStyle = {
  background: "#12191e",
  border: "1px solid #22303a",
  borderRadius: 4,
  fontSize: 12,
};

export default function Dashboard({ dataset }) {
  const [dash, setDash] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const generate = async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await api.generateDashboard(dataset.dataset_id);
      setDash(result);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="panel-tab">
      <div className="panel-tab-head">
        <div>
          <h2>Dashboard</h2>
          <p className="panel-tab-sub">
            Gemini proposes KPIs and charts from your schema, then each one runs as a real SQL
            query against your data.
          </p>
        </div>
        <button className="btn btn-primary" onClick={generate} disabled={loading}>
          {loading ? "Generating\u2026" : dash ? "Regenerate" : "Generate dashboard"}
        </button>
      </div>

      {error && <div className="banner banner-error">{error}</div>}

      {!dash && !loading && !error && (
        <div className="empty-state">
          <div className="empty-glyph mono">[ ]</div>
          <p>No dashboard yet. Generate one to see AI-picked KPIs and charts.</p>
        </div>
      )}

      {dash && (
        <div className="widget-grid">
          {dash.widgets.map((w, i) =>
            w.error ? (
              <div className="widget widget-error" key={i}>
                <div className="widget-title mono">{w.title}</div>
                <div className="widget-error-text">Query failed: {w.error}</div>
              </div>
            ) : w.type === "kpi" ? (
              <KpiWidget widget={w} key={i} />
            ) : w.type === "table" ? (
              <TableWidget widget={w} key={i} />
            ) : (
              <ChartWidget widget={w} key={i} />
            )
          )}
        </div>
      )}
    </div>
  );
}
