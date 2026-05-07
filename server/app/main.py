"""FastAPI Piper TTS streaming API (NDJSON over HTTP)."""

from __future__ import annotations

import base64
import json
import logging
import os
from pathlib import Path
from typing import Iterator, Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from piper import PiperVoice, SynthesisConfig

_LOGGER = logging.getLogger(__name__)

VOICES_DIR = Path(os.environ.get("PIPER_VOICES_DIR", "/voices")).resolve()
DEFAULT_VOICE_NAME = os.environ.get("PIPER_DEFAULT_VOICE", "en_US-lessac-medium").strip()
MAX_TEXT_CHARS = int(os.environ.get("PIPER_MAX_TEXT_CHARS", "50000"))

# Split sentence PCM into NDJSON lines so native messaging stays under Chrome limits (~1 MiB message).
BYTES_PER_PCM_CHUNK = int(os.environ.get("PIPER_BYTES_PER_PCM_CHUNK", "8192"))

_voice_cache: dict[str, PiperVoice] = {}

app = FastAPI(title="Piper Read-Aloud", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


class SynthesizeRequest(BaseModel):
    text: str = Field(..., min_length=1)
    voice: Optional[str] = None
    length_scale: float = Field(default=1.0, gt=0.0, le=5.0)


def _voice_onnx_path(name: str) -> Path:
    return VOICES_DIR / f"{name}.onnx"


def load_voice(name: str) -> PiperVoice:
    if name not in _voice_cache:
        onnx = _voice_onnx_path(name)
        if not onnx.is_file():
            raise HTTPException(
                status_code=404,
                detail=f"Voice model not found: {onnx} (download into {VOICES_DIR})",
            )
        _LOGGER.info("Loading Piper voice: %s", onnx)
        _voice_cache[name] = PiperVoice.load(onnx)
    return _voice_cache[name]


@app.on_event("startup")
async def startup() -> None:
    logging.basicConfig(level=logging.INFO)
    VOICES_DIR.mkdir(parents=True, exist_ok=True)
    try:
        load_voice(DEFAULT_VOICE_NAME)
        _LOGGER.info("Default voice ready: %s", DEFAULT_VOICE_NAME)
    except HTTPException as e:
        _LOGGER.warning("Default voice not loaded at startup: %s", e.detail)


@app.get("/")
async def root() -> dict:
    """Avoid bare ``Not Found`` when opening the server URL in a browser."""
    return {
        "service": "piper-read-aloud",
        "docs": "POST /v1/synthesize_stream (NDJSON stream)",
        "health": "/health",
    }


@app.get("/health")
async def health() -> dict:
    return {"status": "ok", "voices_dir": str(VOICES_DIR), "default_voice": DEFAULT_VOICE_NAME}


def _encode_ndjson_line(obj: dict) -> bytes:
    return json.dumps(obj, separators=(",", ":")).encode("utf-8") + b"\n"


def _stream_synthesize(req: SynthesizeRequest) -> Iterator[bytes]:
    text = req.text
    if len(text) > MAX_TEXT_CHARS:
        yield _encode_ndjson_line(
            {"kind": "error", "message": f"Text exceeds max length ({MAX_TEXT_CHARS})"}
        )
        return

    voice_name = (req.voice or DEFAULT_VOICE_NAME).strip()
    try:
        voice = load_voice(voice_name)
    except HTTPException as e:
        yield _encode_ndjson_line({"kind": "error", "message": str(e.detail)})
        return

    syn_config = SynthesisConfig(length_scale=req.length_scale)

    sample_rate = voice.config.sample_rate

    yield _encode_ndjson_line(
        {
            "kind": "meta",
            "sample_rate": sample_rate,
            "channels": 1,
            "sample_width": 2,
            "voice": voice_name,
            "timings": None,
        }
    )

    try:
        for chunk in voice.synthesize(text, syn_config=syn_config):
            pcm = chunk.audio_int16_bytes
            for i in range(0, len(pcm), BYTES_PER_PCM_CHUNK):
                piece = pcm[i : i + BYTES_PER_PCM_CHUNK]
                b64 = base64.b64encode(piece).decode("ascii")
                yield _encode_ndjson_line({"kind": "pcm", "b64": b64})
        yield _encode_ndjson_line({"kind": "done"})
    except Exception as exc:  # pragma: no cover
        _LOGGER.exception("Synthesis failed")
        yield _encode_ndjson_line({"kind": "error", "message": str(exc)})


@app.post("/v1/synthesize_stream")
def synthesize_stream(req: SynthesizeRequest):
    return StreamingResponse(
        _stream_synthesize(req),
        media_type="application/x-ndjson",
        headers={"Cache-Control": "no-store"},
    )
