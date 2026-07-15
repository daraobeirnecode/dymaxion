"""Dymaxion voice-memo transcription — faster-whisper behind FastAPI.

POST /transcribe  (multipart file) -> {"text": ..., "language": ..., "duration_seconds": ...}
GET  /health      -> {"status": "ok", "model": ...}
"""

import os
import tempfile

from fastapi import FastAPI, File, HTTPException, UploadFile
from faster_whisper import WhisperModel

MODEL_NAME = os.environ.get("WHISPER_MODEL", "small")

app = FastAPI(title="dymaxion-whisper")
_model: WhisperModel | None = None


def model() -> WhisperModel:
    global _model
    if _model is None:
        # int8 keeps CPU + memory modest on the Mac Mini / WSL2
        _model = WhisperModel(MODEL_NAME, device="cpu", compute_type="int8")
    return _model


@app.get("/health")
def health() -> dict:
    return {"status": "ok", "model": MODEL_NAME, "loaded": _model is not None}


@app.post("/transcribe")
async def transcribe(file: UploadFile = File(...)) -> dict:
    if file.size is not None and file.size > 50 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="audio file too large (50 MB max)")
    suffix = os.path.splitext(file.filename or "audio.oga")[1] or ".oga"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(await file.read())
        tmp_path = tmp.name
    try:
        segments, info = model().transcribe(tmp_path, vad_filter=True)
        text = " ".join(segment.text.strip() for segment in segments).strip()
        return {
            "text": text,
            "language": info.language,
            "duration_seconds": round(info.duration, 1),
        }
    finally:
        os.unlink(tmp_path)
