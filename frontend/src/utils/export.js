function triggerDownload(filename, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function csvEscape(value) {
  if (value === null || value === undefined) return "";
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Download tabular data (array-of-arrays or array-of-objects rows) as a CSV file. */
export function downloadCsv(filename, columns, rows) {
  const lines = [columns.map(csvEscape).join(",")];
  for (const row of rows) {
    const values = Array.isArray(row) ? row : columns.map((c) => row[c]);
    lines.push(values.map(csvEscape).join(","));
  }
  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
  triggerDownload(filename, blob);
}

/** Download plain text (e.g. markdown) as a file. */
export function downloadText(filename, text, mime = "text/plain;charset=utf-8;") {
  triggerDownload(filename, new Blob([text], { type: mime }));
}
