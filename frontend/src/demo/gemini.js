// Browser-side Gemini client for the static GitHub Pages build.
// The deployed site never ships an API key: a visitor can paste their own,
// which is kept in this browser's localStorage and sent only to Google's
// Generative Language API. Mirrors the backend's generate_json/generate_text.

const KEY_STORAGE = "demo.geminiApiKey";
export const GEMINI_MODEL = "gemini-3.8-flash";
const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models/";

// captured before any demo fetch interception is installed
const realFetch = window.fetch.bind(window);

export class GeminiNotConfigured extends Error {}

export function getKey() {
  try {
    return localStorage.getItem(KEY_STORAGE) || "";
  } catch {
    return "";
  }
}

export function setKey(key) {
  try {
    if (key) localStorage.setItem(KEY_STORAGE, key.trim());
    else localStorage.removeItem(KEY_STORAGE);
  } catch {
    /* storage unavailable (private mode); key just won't persist */
  }
}

export const hasKey = () => Boolean(getKey());

// Gemini's responseSchema uses upper-case OpenAPI type names
function toGeminiSchema(schema) {
  if (Array.isArray(schema)) return schema.map(toGeminiSchema);
  if (!schema || typeof schema !== "object") return schema;
  const out = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === "type" && typeof v === "string") out[k] = v.toUpperCase();
    else if (k === "properties")
      out[k] = Object.fromEntries(Object.entries(v).map(([p, s]) => [p, toGeminiSchema(s)]));
    else if (k === "items") out[k] = toGeminiSchema(v);
    else out[k] = v;
  }
  return out;
}

async function generate(systemInstruction, prompt, generationConfig) {
  const key = getKey();
  if (!key) {
    throw new GeminiNotConfigured(
      "No Gemini API key set. Add yours in the demo panel (bottom-right); it stays in this browser."
    );
  }
  const res = await realFetch(ENDPOINT + GEMINI_MODEL + ":generateContent", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemInstruction }] },
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error("Gemini request failed: " + (data?.error?.message || "HTTP " + res.status));
  const text = (data?.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("");
  if (!text) throw new Error("Gemini returned an empty response");
  return text;
}

export async function generateJson(systemInstruction, prompt, responseSchema, temperature = 0.2) {
  const text = await generate(systemInstruction, prompt, {
    temperature,
    responseMimeType: "application/json",
    responseSchema: toGeminiSchema(responseSchema),
  });
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error("Model did not return valid JSON: " + e.message);
  }
}

export function generateText(systemInstruction, prompt, temperature = 0.4) {
  return generate(systemInstruction, prompt, { temperature });
}
