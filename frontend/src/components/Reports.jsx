import { useState } from "react";
import ReactMarkdown from "react-markdown";
import { api } from "../api";
import { downloadText } from "../utils/export";
import "./Reports.css";

export default function Reports({ dataset }) {
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const generate = async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await api.generateReport(dataset.dataset_id);
      setReport(result);
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
          <h2>Report</h2>
          <p className="panel-tab-sub">
            A written summary grounded in the computed statistics for this dataset &mdash;
            executive summary, key metrics, trends, data quality, and recommendations.
          </p>
        </div>
        <div className="panel-tab-actions">
          {report && (
            <button
              className="btn btn-ghost"
              onClick={() =>
                downloadText(
                  `${(dataset.filename || "report").replace(/\.csv$/i, "")}-report.md`,
                  report.markdown,
                  "text/markdown;charset=utf-8;"
                )
              }
            >
              Download .md
            </button>
          )}
          <button className="btn btn-primary" onClick={generate} disabled={loading}>
            {loading ? "Writing\u2026" : report ? "Regenerate" : "Generate report"}
          </button>
        </div>
      </div>

      {error && <div className="banner banner-error">{error}</div>}

      {!report && !loading && !error && (
        <div className="empty-state">
          <div className="empty-glyph mono">[ ]</div>
          <p>No report yet. Generate one for an executive-style writeup of this dataset.</p>
        </div>
      )}

      {report && (
        <div className="report-body">
          <ReactMarkdown>{report.markdown}</ReactMarkdown>
        </div>
      )}
    </div>
  );
}
