# Piper Read Aloud

Read selected web page text aloud using **local** [Piper](https://github.com/OHF-Voice/piper1-gpl) TTS in Docker, plus a Chrome extension. Piper is **GPL-3.0**—keep license obligations in mind if you redistribute builds.

---

## Quick setup

**You need:** [Docker Desktop](https://www.docker.com/products/docker-desktop/) (with Compose), **Python 3.10+** on your PATH, and **Chrome**, **Edge**, or **Brave** (version that supports extensions + offscreen documents).

All commands below assume you opened a terminal in the **repo root** (`readAloud`).

### 1. Download a voice into `voices\`

Easiest on Windows (uses Docker so you don’t fight Python wheels):

**PowerShell:**

```powershell
docker run --rm -v "$(Resolve-Path .\voices):/voices" -w /voices python:3.12-slim-bookworm bash -c "pip install -q piper-tts && python -m piper.download_voices --data-dir /voices en_US-lessac-medium"
```

**Command Prompt:**

```bat
docker run --rm -v "%CD%\voices:/voices" -w /voices python:3.12-slim-bookworm bash -c "pip install -q piper-tts && python -m piper.download_voices --data-dir /voices en_US-lessac-medium"
```

You should end up with `voices\en_US-lessac-medium.onnx` and `voices\en_US-lessac-medium.onnx.json`.

### 2. Start the TTS API

```bash
docker compose up --build -d
```

Check it responds (browser or curl):

- Open: http://127.0.0.1:8765/health  
  You want JSON with `"status":"ok"`.

### 3. Install the Chrome extension (unpacked)

1. Open `chrome://extensions` (or `edge://extensions` / `brave://extensions`).
2. Turn on **Developer mode**.
3. **Load unpacked** → choose this repo’s **`extension`** folder.
4. Copy the **Extension ID** (32 letters under the extension name—you’ll need it in step 4).

### 4. Register the native bridge (Windows)

The extension cannot call `localhost` directly; Chrome launches a small **native host** that forwards requests to Docker. This script installs that host and registers it with your browser(s).

In **PowerShell** from the repo root (replace with **your** ID from step 3):

```powershell
.\scripts\install-native-host-windows.ps1 -ExtensionId YOUR_EXTENSION_ID_HERE
```

If scripts are blocked, run once:

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned -Force
```

**Fully quit** the browser (all windows), then open it again.

### 5. Use it

1. Leave Docker running (`docker compose up` already started the API).
2. On a normal webpage, **select some text** (or on **Chrome’s PDF viewer**, select text then **Ctrl+C** — extensions usually cannot read the PDF selection directly).
3. Click the extension icon → **Read selection or clipboard**.

---

## How it works (details)

### Pieces

| Piece | Role |
|--------|------|
| **`docker compose`** | Runs **FastAPI** + **Piper** on port **8765**. Text in → streaming **NDJSON** (metadata + small **PCM audio chunks**) out. Voice files live in **`voices/`**, mounted into the container. |
| **`extension/`** | Reads selection via **`chrome.scripting`** (all frames + main/isolated worlds); if empty (common on **built-in PDF**), uses **clipboard** after you **Ctrl+C**. Talks to the native host and plays audio in an **offscreen** document. |
| **`native-host/bridge.py`** | **Chrome Native Messaging** program: Chrome starts it when the extension connects; it reads JSON messages from stdin and POSTs to `http://127.0.0.1:8765/v1/synthesize_stream`, then forwards each NDJSON line back to the extension as separate messages. |

Data flow in one sentence: **Extension → Native Messaging → bridge.py → Docker API → Piper → audio chunks → extension → speakers.**

### Why the PowerShell installer exists

Chrome only runs native programs that are **registered**:

1. A JSON **manifest** (`com.piper.reader.json`) lists the **launcher** (`bridge.bat`), and **`allowed_origins`**—only those extension IDs may connect.
2. Windows **registry** tells Chrome **where that JSON file is** (per browser: Chrome, Edge, Brave each have their own key).

**Reloading the extension** does **not** register the host. If you skip step 4, you typically see **“Specified native messaging host not found”** or **“forbidden”**.

The installer copies `bridge.py` to `%LOCALAPPDATA%\PiperReadAloudNativeHost\`, writes `bridge.bat` + the JSON manifest, and sets those registry keys (by default for **Chrome, Edge, and Brave**).

### Voices and configuration

- Default voice name is **`en_US-lessac-medium`** (see `docker-compose.yaml` / `PIPER_DEFAULT_VOICE`).
- To use another voice, put its `.onnx` + `.onnx.json` in **`voices/`** and align the env voice name with the file basename.

### API endpoints (for debugging)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/` | Tiny JSON pointer (not a web UI). |
| GET | `/health` | “Is the server up?” |
| POST | `/v1/synthesize_stream` | Body: `{"text":"..."}` → streamed NDJSON (`meta`, many `pcm`, then `done`). |

Example POST (PowerShell can use `curl.exe` the same way as cmd):

```bash
curl.exe -N -X POST "http://127.0.0.1:8765/v1/synthesize_stream" -H "Content-Type: application/json" -d "{\"text\":\"Hello. Second sentence.\"}"
```

### Alternative: download voices without Docker

If `piper-tts` installs cleanly on your machine:

```bash
pip install piper-tts
python -m piper.download_voices --data-dir voices en_US-lessac-medium
```

With uv: `uv pip install piper-tts`, then `uv run python -m piper.download_voices --data-dir voices en_US-lessac-medium`.

Do **not** run `uv add Streaming`—that is an unrelated PyPI package.

### Installer options (advanced)

```powershell
.\scripts\install-native-host-windows.ps1 `
  -ExtensionId YOUR_EXTENSION_ID_HERE `
  -PythonExe "C:\Path\To\python.exe" `
  -ApiUrl "http://127.0.0.1:8765/v1/synthesize_stream" `
  -Browsers Chrome
```

`-Browsers` can be `Chrome`, `Edge`, `Brave`, or `All` (default registers all three).

---

## Troubleshooting

| Problem | What to try |
|--------|----------------|
| **Native messaging host not found** | Run step 4 with the correct **Extension ID**; use `-Browsers All` or match the browser you actually use; **restart** the browser completely. |
| **Forbidden** / host blocked | Extension ID changed after reload path change—re-run the installer with the new ID. |
| **Cannot reach API** / bridge errors | Confirm Docker is up: http://127.0.0.1:8765/health ; fix `-ApiUrl` in installer if you changed the port. |
| **No text selected** | Highlight text first; **PDF:** Chrome blocks selection APIs → select text, **Ctrl+C**, then click Read (**clipboardRead** permission). |
| Voice / ONNX errors | Confirm both `.onnx` and `.onnx.json` exist under **`voices/`**. |

**Logs:** `docker compose logs -f piper-api` — To debug the bridge, run `%LOCALAPPDATA%\PiperReadAloudNativeHost\bridge.bat` from a terminal (Chrome normally launches it for you).

---

## Reference

### Repo layout

| Path | Contents |
|------|-----------|
| [`docker/Dockerfile`](docker/Dockerfile) | API container image |
| [`docker-compose.yaml`](docker-compose.yaml) | Port **8765**, `./voices` mount |
| [`server/app/main.py`](server/app/main.py) | FastAPI app |
| [`native-host/bridge.py`](native-host/bridge.py) | Native Messaging ↔ HTTP |
| [`extension/`](extension/) | Unpacked extension |

### Environment variables

| Variable | Default | Meaning |
|---------|---------|---------|
| `PIPER_VOICES_DIR` | `/voices` | Model directory inside container |
| `PIPER_DEFAULT_VOICE` | `en_US-lessac-medium` | Default voice basename |
| `PIPER_BYTES_PER_PCM_CHUNK` | `8192` | PCM bytes per streamed chunk |
| `PIPER_API_URL` | `http://127.0.0.1:8765/v1/synthesize_stream` | Bridge target URL (set in `bridge.bat` by installer) |

Manual manifest template: [`native-host/com.piper.reader.json.template`](native-host/com.piper.reader.json.template).
