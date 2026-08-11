from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from . import config, database
from .routers import dashboard, forecast, query, report, upload

app = FastAPI(title="BI Platform API", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=config.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(upload.router)
app.include_router(query.router)
app.include_router(dashboard.router)
app.include_router(report.router)
app.include_router(forecast.router)


@app.get("/api/health")
async def health():
    return {
        "status": "ok",
        "gemini_configured": bool(config.GEMINI_API_KEY),
        "gemini_model": config.GEMINI_MODEL,
        "dataset_count": len(database.list_datasets()),
    }
