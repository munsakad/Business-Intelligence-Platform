const BASE_URL = import.meta.env.VITE_API_BASE_URL || "http://localhost:8000";

async function request(path, options = {}) {
  const res = await fetch(`${BASE_URL}${path}`, options);
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.json();
      detail = body.detail || JSON.stringify(body);
    } catch (_) {
      /* ignore */
    }
    throw new Error(detail);
  }
  return res.json();
}

export const api = {
  health() {
    return request("/api/health");
  },
  uploadCsv(file) {
    const form = new FormData();
    form.append("file", file);
    return request("/api/datasets/upload", { method: "POST", body: form });
  },
  listDatasets() {
    return request("/api/datasets");
  },
  getDataset(id) {
    return request(`/api/datasets/${id}`);
  },
  deleteDataset(id) {
    return request(`/api/datasets/${id}`, { method: "DELETE" });
  },
  runQuery(id, question) {
    return request(`/api/datasets/${id}/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question }),
    });
  },
  generateDashboard(id) {
    return request(`/api/datasets/${id}/dashboard`, { method: "POST" });
  },
  generateReport(id) {
    return request(`/api/datasets/${id}/report`, { method: "POST" });
  },
  forecastableColumns(id) {
    return request(`/api/datasets/${id}/forecastable-columns`);
  },
  runForecast(id, payload) {
    return request(`/api/datasets/${id}/forecast`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  },
};
