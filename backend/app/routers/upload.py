from fastapi import APIRouter, File, HTTPException, UploadFile

from .. import database

router = APIRouter(prefix="/api/datasets", tags=["datasets"])


@router.post("/upload")
async def upload_csv(file: UploadFile = File(...)):
    if not file.filename.lower().endswith(".csv"):
        raise HTTPException(400, "Please upload a .csv file")
    content = await file.read()
    try:
        meta = database.ingest_csv(content, file.filename)
    except ValueError as e:
        raise HTTPException(400, str(e))
    except Exception as e:
        raise HTTPException(500, f"Failed to parse CSV: {e}")
    return meta


@router.get("")
async def list_datasets():
    return database.list_datasets()


@router.get("/{dataset_id}")
async def get_dataset(dataset_id: str):
    try:
        return database.get_dataset(dataset_id)
    except database.DatasetNotFound:
        raise HTTPException(404, "Dataset not found. Upload a CSV first.")


@router.delete("/{dataset_id}")
async def delete_dataset(dataset_id: str):
    try:
        database.delete_dataset(dataset_id)
    except database.DatasetNotFound:
        raise HTTPException(404, "Dataset not found.")
    return {"deleted": dataset_id}
