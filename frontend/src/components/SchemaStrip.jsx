import "./SchemaStrip.css";

const TYPE_COLOR = {
  integer: "blue",
  float: "blue",
  text: "amber",
  datetime: "green",
  boolean: "purple",
};

export default function SchemaStrip({ dataset, compact = false }) {
  if (!dataset) return null;
  return (
    <div className={`schema-strip ${compact ? "is-compact" : ""}`}>
      {!compact && (
        <div className="schema-strip-head">
          <span className="schema-strip-name mono">{dataset.filename}</span>
          <span className="schema-strip-count mono">
            {dataset.row_count.toLocaleString()} rows &middot; {dataset.columns.length} cols
          </span>
        </div>
      )}
      <div className="schema-strip-chips">
        {dataset.columns.map((col) => (
          <span
            key={col.name}
            className={`schema-chip color-${TYPE_COLOR[col.type] || "amber"}`}
            title={`${col.name}: ${col.type}`}
          >
            <span className="schema-chip-name mono">{col.name}</span>
            <span className="schema-chip-type mono">{col.type}</span>
          </span>
        ))}
      </div>
    </div>
  );
}
