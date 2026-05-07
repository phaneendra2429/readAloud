#!/usr/bin/env python3
"""Chrome Native Messaging host: forwards streaming Piper NDJSON to the extension."""

from __future__ import annotations

import json
import os
import struct
import sys
import urllib.error
import urllib.request
from typing import Optional


API_URL = os.environ.get(
    "PIPER_API_URL", "http://127.0.0.1:8765/v1/synthesize_stream"
)


def read_message() -> Optional[dict]:
    raw_length = sys.stdin.buffer.read(4)
    if len(raw_length) == 0:
        return None
    if len(raw_length) != 4:
        raise ValueError("Failed to read message length")
    (length,) = struct.unpack("<I", raw_length)
    payload = sys.stdin.buffer.read(length)
    if len(payload) != length:
        raise ValueError("Truncated native message body")
    return json.loads(payload.decode("utf-8"))


def write_message(obj: dict) -> None:
    data = json.dumps(obj, separators=(",", ":")).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(data)))
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()


def ndjson_line_to_native(line_obj: dict) -> Optional[dict]:
    kind = line_obj.get("kind")
    if kind == "meta":
        return {
            "type": "meta",
            "sample_rate": line_obj["sample_rate"],
            "channels": line_obj.get("channels", 1),
            "sample_width": line_obj.get("sample_width", 2),
            "voice": line_obj.get("voice"),
            "timings": line_obj.get("timings"),
        }
    if kind == "pcm":
        return {"type": "pcm", "b64": line_obj["b64"]}
    if kind == "done":
        return {"type": "done"}
    if kind == "error":
        return {"type": "error", "message": line_obj.get("message", "unknown error")}
    return None


def stream_synthesize(msg: dict) -> None:
    text = msg.get("text")
    if not text or not isinstance(text, str):
        write_message({"type": "error", "message": "Missing or invalid 'text'"})
        return

    body_obj = {
        "text": text,
        "voice": msg.get("voice"),
        "length_scale": float(msg.get("length_scale", 1.0)),
    }
    body = json.dumps(body_obj, separators=(",", ":")).encode("utf-8")

    req = urllib.request.Request(
        API_URL,
        data=body,
        headers={"Content-Type": "application/json", "Accept": "application/x-ndjson"},
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=600) as resp:
            buf = b""
            while True:
                data = resp.read(8192)
                if not data:
                    break
                buf += data
                while b"\n" in buf:
                    line, buf = buf.split(b"\n", 1)
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        obj = json.loads(line.decode("utf-8"))
                    except json.JSONDecodeError as exc:
                        write_message(
                            {"type": "error", "message": f"Invalid NDJSON from API: {exc}"}
                        )
                        return
                    native = ndjson_line_to_native(obj)
                    if native is None:
                        continue
                    write_message(native)
                    if native["type"] in ("done", "error"):
                        return
            # trailing fragment without newline
            if buf.strip():
                try:
                    obj = json.loads(buf.strip().decode("utf-8"))
                    native = ndjson_line_to_native(obj)
                    if native:
                        write_message(native)
                except json.JSONDecodeError:
                    write_message(
                        {"type": "error", "message": "Incomplete NDJSON stream from API"}
                    )
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:2000]
        write_message(
            {"type": "error", "message": f"HTTP {exc.code}: {detail or exc.reason}"}
        )
    except urllib.error.URLError as exc:
        write_message(
            {
                "type": "error",
                "message": f"Cannot reach Piper API at {API_URL}: {exc.reason}",
            }
        )
    except Exception as exc:  # pragma: no cover
        write_message({"type": "error", "message": str(exc)})


def main() -> None:
    try:
        while True:
            msg = read_message()
            if msg is None:
                break
            mtype = msg.get("type")
            if mtype == "synthesize":
                stream_synthesize(msg)
            elif mtype == "cancel":
                write_message({"type": "error", "message": "cancel not implemented"})
            else:
                write_message(
                    {"type": "error", "message": f"Unknown message type: {mtype}"}
                )
    except (BrokenPipeError, OSError):
        pass


if __name__ == "__main__":
    main()
