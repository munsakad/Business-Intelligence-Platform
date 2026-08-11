import { useEffect, useState } from "react";
import { api } from "../api";
import "./DatasetSwitcher.css";

/** Sidebar list of previously uploaded datasets, backed by the persisted catalog
 *  on the backend, so a dataset survives a page reload or backend restart. */
export default function DatasetSwitcher({ activeId, onSelect, refreshToken }) {
  const [datasets, setDatasets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    api
      .listDatasets()
      .then((list) => {
        if (!cancelled) setDatasets(list);
      })
      .catch((e) => {
        if (!cancelled) setError(e.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [refreshToken]);

  if (loading) return null;
  if (error) return <div className="dataset-switcher-error mono">{error}</div>;
  if (datasets.length === 0) return null;

  const select = async (id) => {
    if (id === activeId) return;
    setBusyId(id);
    try {
      const meta = await api.getDataset(id);
      onSelect(meta);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (e, id) => {
    e.stopPropagation();
    if (!window.confirm("Remove this dataset? This cannot be undone.")) return;
    setBusyId(id);
    try {
      await api.deleteDataset(id);
      setDatasets((ds) => ds.filter((d) => d.dataset_id !== id));
      if (id === activeId) onSelect(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="dataset-switcher">
      <div className="dataset-switcher-label mono">Recent datasets</div>
      <ul className="dataset-switcher-list">
        {datasets.map((d) => (
          <li
            key={d.dataset_id}
            className={`dataset-switcher-item ${d.dataset_id === activeId ? "is-active" : ""}`}
            onClick={() => select(d.dataset_id)}
          >
            <div className="dataset-switcher-item-main">
              <span className="dataset-switcher-name">{d.filename}</span>
              <span className="dataset-switcher-meta mono">
                {d.row_count.toLocaleString()} rows
              </span>
            </div>
            <button
              className="dataset-switcher-remove"
              title="Remove dataset"
              disabled={busyId === d.dataset_id}
              onClick={(e) => remove(e, d.dataset_id)}
            >
              &times;
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
