import { useCallback, useRef, useState } from "react";
import { api } from "../api";
import "./FileUpload.css";

export default function FileUpload({ onUploaded }) {
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const inputRef = useRef(null);

  const handleFile = useCallback(
    async (file) => {
      if (!file) return;
      if (!file.name.toLowerCase().endsWith(".csv")) {
        setError("Please choose a .csv file");
        return;
      }
      setBusy(true);
      setError(null);
      try {
        const meta = await api.uploadCsv(file);
        onUploaded(meta);
      } catch (e) {
        setError(e.message || "Upload failed");
      } finally {
        setBusy(false);
      }
    },
    [onUploaded]
  );

  return (
    <div
      className={`upload-drop ${dragging ? "is-dragging" : ""} ${busy ? "is-busy" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        handleFile(e.dataTransfer.files?.[0]);
      }}
      onClick={() => inputRef.current?.click()}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") inputRef.current?.click();
      }}
    >
      <input
        ref={inputRef}
        type="file"
        accept=".csv"
        hidden
        onChange={(e) => handleFile(e.target.files?.[0])}
      />
      <div className="upload-glyph mono">.csv</div>
      <div className="upload-label">
        {busy ? "Loading dataset\u2026" : "Drop a CSV or click to upload"}
      </div>
      <div className="upload-sub">Parsed, typed, and loaded into a queryable table</div>
      {error && <div className="upload-error">{error}</div>}
    </div>
  );
}
