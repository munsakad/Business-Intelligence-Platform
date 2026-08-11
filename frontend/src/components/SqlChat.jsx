import { useState } from "react";
import { api } from "../api";
import { downloadCsv } from "../utils/export";
import "./SqlChat.css";

const EXAMPLES = [
  "What are the top 5 rows by value?",
  "Show totals grouped by category",
  "How many rows have missing data?",
];

export default function SqlChat({ dataset }) {
  const [question, setQuestion] = useState("");
  const [history, setHistory] = useState([]); // {question, result, error}
  const [loading, setLoading] = useState(false);

  const ask = async (q) => {
    const text = (q ?? question).trim();
    if (!text || loading) return;
    setLoading(true);
    setQuestion("");
    try {
      const result = await api.runQuery(dataset.dataset_id, text);
      setHistory((h) => [...h, { question: text, result }]);
    } catch (e) {
      setHistory((h) => [...h, { question: text, error: e.message }]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="panel-tab">
      <div className="panel-tab-head">
        <div>
          <h2>SQL Console</h2>
          <p className="panel-tab-sub">
            Ask a question in plain English. Gemini writes a SQLite query, runs it read-only
            against your data, and shows the SQL alongside the results.
          </p>
        </div>
      </div>

      {history.length === 0 && (
        <div className="sql-examples">
          {EXAMPLES.map((ex) => (
            <button key={ex} className="chip-btn" onClick={() => ask(ex)}>
              {ex}
            </button>
          ))}
        </div>
      )}

      <div className="sql-history">
        {history.map((h, i) => (
          <div className="sql-turn" key={i}>
            <div className="sql-question">
              <span className="sql-question-mark mono">?</span> {h.question}
            </div>
            {h.error && <div className="banner banner-error">{h.error}</div>}
            {h.result && (
              <>
                <pre className="sql-code mono">{h.result.sql}</pre>
                {h.result.explanation && (
                  <div className="sql-explanation">{h.result.explanation}</div>
                )}
                <div className="sql-result-scroll">
                  <table>
                    <thead>
                      <tr>
                        {h.result.columns.map((c) => (
                          <th key={c} className="mono">
                            {c}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {h.result.rows.map((row, ri) => (
                        <tr key={ri}>
                          {row.map((v, ci) => (
                            <td key={ci} className="mono">
                              {String(v)}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="sql-result-foot">
                  <span className="sql-row-count mono">{h.result.row_count} row(s)</span>
                  {h.result.rows.length > 0 && (
                    <button
                      className="link-btn"
                      onClick={() =>
                        downloadCsv("query-result.csv", h.result.columns, h.result.rows)
                      }
                    >
                      Export CSV
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
        ))}
        {loading && <div className="sql-loading mono">Writing SQL and running it…</div>}
      </div>

      <form
        className="sql-input-row"
        onSubmit={(e) => {
          e.preventDefault();
          ask();
        }}
      >
        <input
          className="sql-input"
          placeholder="Ask a question about this data…"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
        />
        <button className="btn btn-primary" type="submit" disabled={loading || !question.trim()}>
          Ask
        </button>
      </form>
    </div>
  );
}
