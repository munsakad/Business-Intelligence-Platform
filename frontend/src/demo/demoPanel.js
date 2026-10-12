// Floating panel shown only in the static GitHub Pages build. It explains
// what is running in place of the backend and, for Gemini-powered features,
// lets a visitor paste their own API key (kept in this browser only).
import { GEMINI_MODEL, getKey, setKey } from "./gemini.js";

const COLLAPSE_KEY = "demo.panelCollapsed";

const CSS = `
.demo-panel{position:fixed;right:14px;bottom:14px;z-index:2147483000;width:min(360px,calc(100vw - 28px));
  font:12.5px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;color:#d6dde4;background:#12181e;
  border:1px solid #2a3540;border-radius:8px;box-shadow:0 8px 28px rgba(0,0,0,.45)}
.demo-panel *{box-sizing:border-box}
.demo-panel header{display:flex;align-items:center;gap:8px;padding:9px 12px;cursor:pointer;user-select:none}
.demo-panel header b{color:#fff;font-weight:600}
.demo-panel .dot{width:8px;height:8px;border-radius:50%;background:#e8a33d;flex:none}
.demo-panel .dot.on{background:#3ecf8e}
.demo-panel .chev{margin-left:auto;color:#8a99a8;font-size:11px}
.demo-panel .body{padding:0 12px 12px;display:grid;gap:8px}
.demo-panel.collapsed .body{display:none}
.demo-panel p{margin:0;color:#aab6c2}
.demo-panel a{color:#6ea2ff}
.demo-panel form{display:flex;gap:6px}
.demo-panel input{flex:1;min-width:0;padding:6px 8px;border-radius:5px;border:1px solid #2f3b47;
  background:#0b1015;color:#e6edf3;font:inherit}
.demo-panel button{padding:6px 10px;border-radius:5px;border:1px solid #2f3b47;background:#1c2630;
  color:#e6edf3;font:inherit;cursor:pointer}
.demo-panel button.primary{background:#2f6fde;border-color:#2f6fde}
.demo-panel small{color:#7d8a96}
`;

function storedCollapsed() {
  try {
    return localStorage.getItem(COLLAPSE_KEY) === "1";
  } catch {
    return false;
  }
}

export function mountDemoPanel({ repoUrl, note, gemini = true, offlineNote = "" }) {
  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.appendChild(style);

  const key = gemini ? getKey() : "";
  const el = document.createElement("aside");
  el.className = "demo-panel" + (storedCollapsed() ? " collapsed" : "");
  el.setAttribute("aria-label", "About this demo");

  const status = !gemini ? "static build" : key ? "Gemini: your key" : "Gemini: offline mode";
  const geminiBlock = !gemini
    ? ""
    : key
      ? "<p>Live AI is on, using <code>" + GEMINI_MODEL + "</code> with your key (stored only in this browser).</p>" +
        '<div><button type="button" data-clear>Remove key</button></div>'
      : "<p>" + offlineNote + " Add a Gemini API key to turn on live AI. It is stored only in this browser and sent " +
        'straight to Google. <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">Get a free key</a></p>' +
        '<form><input type="password" placeholder="Paste Gemini API key" autocomplete="off" aria-label="Gemini API key" required>' +
        '<button class="primary">Save</button></form>';

  el.innerHTML =
    '<header role="button" tabindex="0" aria-expanded="true"><span class="dot' + (key || !gemini ? " on" : "") + '"></span>' +
    "<span><b>Live demo</b> &middot; " + status + '</span><span class="chev">&#9660;</span></header>' +
    '<div class="body"><p>' + note + "</p>" + geminiBlock +
    '<small><a href="' + repoUrl + '" target="_blank" rel="noopener">Source on GitHub</a></small></div>';

  const header = el.querySelector("header");
  const sync = () => {
    const collapsed = el.classList.contains("collapsed");
    header.setAttribute("aria-expanded", String(!collapsed));
    el.querySelector(".chev").innerHTML = collapsed ? "&#9650;" : "&#9660;";
  };
  const toggle = () => {
    el.classList.toggle("collapsed");
    try {
      localStorage.setItem(COLLAPSE_KEY, el.classList.contains("collapsed") ? "1" : "0");
    } catch {
      /* ignore */
    }
    sync();
  };
  header.addEventListener("click", toggle);
  header.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      toggle();
    }
  });
  sync();

  el.querySelector("form")?.addEventListener("submit", (e) => {
    e.preventDefault();
    setKey(e.target.querySelector("input").value);
    window.location.reload();
  });
  el.querySelector("[data-clear]")?.addEventListener("click", () => {
    setKey("");
    window.location.reload();
  });

  document.body.appendChild(el);
}
