import json

from google import genai
from google.genai import types

from . import config

_client: genai.Client | None = None


class GeminiNotConfigured(Exception):
    pass


def _get_client() -> genai.Client:
    global _client
    if not config.GEMINI_API_KEY:
        raise GeminiNotConfigured(
            "GEMINI_API_KEY is not set. Add it to backend/.env (see .env.example)."
        )
    if _client is None:
        _client = genai.Client(api_key=config.GEMINI_API_KEY)
    return _client


def generate_json(system_instruction: str, prompt: str, response_schema: dict) -> dict:
    """Call Gemini asking for a response that matches response_schema (a JSON-schema dict)."""
    client = _get_client()
    response = client.models.generate_content(
        model=config.GEMINI_MODEL,
        contents=prompt,
        config=types.GenerateContentConfig(
            system_instruction=system_instruction,
            response_mime_type="application/json",
            response_schema=response_schema,
            temperature=0.2,
        ),
    )
    text = response.text
    try:
        return json.loads(text)
    except json.JSONDecodeError as e:
        raise ValueError(f"Model did not return valid JSON: {e}\nRaw: {text[:500]}")


def generate_text(system_instruction: str, prompt: str, temperature: float = 0.4) -> str:
    client = _get_client()
    response = client.models.generate_content(
        model=config.GEMINI_MODEL,
        contents=prompt,
        config=types.GenerateContentConfig(
            system_instruction=system_instruction,
            temperature=temperature,
        ),
    )
    return response.text
