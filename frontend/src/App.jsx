import { useEffect, useState } from "react";
import FileUpload from "./components/FileUpload.jsx";
import SchemaStrip from "./components/SchemaStrip.jsx";
import DatasetSwitcher from "./components/DatasetSwitcher.jsx";
import Dashboard from "./components/Dashboard.jsx";
import SqlChat from "./components/SqlChat.jsx";
import Reports from "./components/Reports.jsx";
import Forecast from "./components/Forecast.jsx";
import { api } from "./api";
import "./App.css";

const TABS = [
  { id: "dashboard", label: "Dashboard", glyph: "\u2317" },
  { id: "sql", label: "SQL Console", glyph: ">_" },
  { id: "report", label: "Report", glyph: "\u2261" },
  { id: "forecast", label: "Forecast", glyph: "\u2197" },
];

export default function App() {
  const [dataset, setDataset] = useState(null);
  const [tab, setTab] = useState("dashboard");
  const [health, setHealth] = useState(null);
  const [datasetVersion, setDatasetVersion] = useState(0);

  useEffect(() => {
    api
      .health()
      .then(setHealth)
      .catch(() => setHealth({ status: "unreachable" }));
  }, []);

  const selectDataset = (meta) => {
    setDataset(meta);
    setTab("dashboard");
    if (meta) setDatasetVersion((v) => v + 1);
  };

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark mono">&gt;_</span>
          <span className="brand-name">Cortex</span>
        </div>
        <div className="brand-tagline">CSV in, intelligence out.</div>

        <div className="sidebar-section">
          <FileUpload onUploaded={selectDataset} />
          <DatasetSwitcher
            activeId={dataset?.dataset_id}
            onSelect={selectDataset}
            refreshToken={datasetVersion}
          />
        </div>

        {dataset && (
          <div className="sidebar-section">
            <SchemaStrip dataset={dataset} />
          </div>
        )}

        {dataset && (
          <nav className="tab-nav">
            {TABS.map((t) => (
              <button
                key={t.id}
                className={`tab-nav-item ${tab === t.id ? "is-active" : ""}`}
                onClick={() => setTab(t.id)}
              >
                <span className="tab-nav-glyph mono">{t.glyph}</span>
                {t.label}
              </button>
            ))}
          </nav>
        )}

        <div className="sidebar-foot">
          <span
            className={`status-dot ${
              health?.gemini_configured ? "status-ok" : "status-warn"
            }`}
          />
          <span className="mono">
            {health === null
              ? "checking\u2026"
              : health.status === "unreachable"
              ? "backend unreachable"
              : health.gemini_configured
              ? `Gemini \u00b7 ${health.gemini_model}`
              : "Gemini key missing"}
          </span>
        </div>
      </aside>

      <main className="main">
        {health?.status === "unreachable" && (
          <div className="banner banner-error">
            Can&rsquo;t reach the backend API. Make sure it&rsquo;s running (see README:
            &ldquo;Backend setup&rdquo;) and that <code>VITE_API_BASE_URL</code> points at it.
          </div>
        )}
        {health && health.status !== "unreachable" && !health.gemini_configured && (
          <div className="banner banner-warn">
            <strong>Setup needed:</strong> no Gemini API key is configured on the backend, so
            AI-generated dashboards, SQL, reports, and forecast commentary will fail. Add
            <code> GEMINI_API_KEY</code> to <code>backend/.env</code> and restart the backend.
          </div>
        )}

        {!dataset ? (
          <div className="landing">
            <div className="landing-glyph mono">&gt;_</div>
            <h1>Turn a CSV into a live BI workspace</h1>
            <p>
              Upload a dataset on the left. Cortex profiles it, then Gemini can generate a
              dashboard, answer questions in SQL, write a report, or forecast a trend &mdash;
              all grounded in queries run against your actual data.
            </p>
          </div>
        ) : (
          <>
            {tab === "dashboard" && <Dashboard dataset={dataset} />}
            {tab === "sql" && <SqlChat dataset={dataset} />}
            {tab === "report" && <Reports dataset={dataset} />}
            {tab === "forecast" && <Forecast dataset={dataset} />}
          </>
        )}
      </main>
    </div>
  );
}
