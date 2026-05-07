# Piper Read Aloud (Chrome + Docker)

Local neural text-to-speech using [Piper](https://github.com/OHF-Voice/piper1-gpl) inside Docker, a small **FastAPI** streaming API (**NDJSON** over HTTP), a **Native Messaging** bridge on your PC, and a Manifest **V3** Chrome extension. Playback streams chunk-by-chunk (no single giant WAV buffer).

**Note:** Piper is licensed under **GPL-3.0**. Keep GPL obligations in mind if you redistribute combined binaries.

## Prerequisites

- Docker Desktop (or Docker Engine) with Compose
- Google Chrome, Microsoft Edge, or Brave (Chromium 109+ for `offscreen` documents)
- Python **3.10+** on Windows for the native host (`python` on PATH), or pass `-PythonExe` to the installer script

## 1. Voice models

Put Piper ONNX voices under `./voices` at the repo root (mounted into the container as `/voices`).

**Download voices** (pick one approach):

- **pip / uv in a venv:** install `piper-tts`, then run the downloader (files land in the current directory unless you pass `--data-dir`):

  ```bash
  pip install piper-tts
  python -m piper.download_voices --data-dir voices en_US-lessac-medium
  ```

  With uv: `uv pip install piper-tts` then `uv run python -m piper.download_voices --data-dir voices en_US-lessac-medium`.

  Do **not** run `uv add Streaming` — that installs an unrelated PyPI package named `streaming`, not this project.

- **Docker (works even if Windows wheels fail):** run a one-off container with `./voices` mounted and download inside Linux. From **cmd** in the repo root:

  ```bat
  docker run --rm -v "%CD%\voices:/voices" -w /voices python:3.12-slim-bookworm bash -c "pip install -q piper-tts && python -m piper.download_voices --data-dir /voices en_US-lessac-medium"
  ```

  From **PowerShell**:

  ```powershell
  docker run --rm -v "$(Resolve-Path .\voices):/voices" -w /voices python:3.12-slim-bookworm bash -c "pip install -q piper-tts && python -m piper.download_voices --data-dir /voices en_US-lessac-medium"
  ```

Ensure files exist:

- `voices/en_US-lessac-medium.onnx`
- `voices/en_US-lessac-medium.onnx.json`

Change `PIPER_DEFAULT_VOICE` in `docker-compose.yaml` if you use another voice name (basename without `.onnx`).

## 2. Run the API (Docker)

From this repo root:

```bash
docker compose up --build -d
```

**Opening `http://127.0.0.1:8765/` in a browser** should show a small JSON summary (not `Not Found`). Use **`GET /health`** for a readiness check:

```bash
curl http://127.0.0.1:8765/health
```

Smoke test streaming (incremental NDJSON lines):

```bash
curl -N -X POST "http://127.0.0.1:8765/v1/synthesize_stream" ^
  -H "Content-Type: application/json" ^
  -d "{\"text\":\"Hello from Piper. Second sentence.\"}"
```

You should see a `meta` line, many `pcm` lines, then `done`.

## 3. Install the Native Messaging host (Windows)

Browsers locate the host via **per-browser registry keys**. Each key’s default value must be the **full path** to `com.piper.reader.json`, which points at **`bridge.bat`** (launcher for Python + `bridge.py`).

| Browser | Registry path |
|--------|----------------|
| Google Chrome | `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.piper.reader` |
| Microsoft Edge | `HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.piper.reader` |
| Brave | `HKCU\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\com.piper.reader` |

1. Load the **unpacked** extension in **the same browser you will use** (`chrome://extensions`, `edge://extensions`, or `brave://extensions`) → Developer mode → **Load unpacked** → select the `extension/` folder.
2. Copy the extension ID (32-character string).
3. Run PowerShell **from the repo root**:

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned -Force   # if blocked
.\scripts\install-native-host-windows.ps1 -ExtensionId YOUR_EXTENSION_ID_HERE
```

By default the script registers **Chrome, Edge, and Brave** (`-Browsers All`). To register only one browser:

```powershell
.\scripts\install-native-host-windows.ps1 -ExtensionId YOUR_EXTENSION_ID_HERE -Browsers Edge
```

Optional:

```powershell
.\scripts\install-native-host-windows.ps1 `
  -ExtensionId YOUR_EXTENSION_ID_HERE `
  -PythonExe "C:\Path\To\Python312\python.exe" `
  -ApiUrl "http://127.0.0.1:8765/v1/synthesize_stream" `
  -Browsers All
```

The script copies `native-host/bridge.py` to `%LOCALAPPDATA%\PiperReadAloudNativeHost\`, writes `bridge.bat` + `com.piper.reader.json`, and updates the registry key(s).

**Fully quit and reopen** each browser you registered after installing or changing the native host.

### Verify registration (PowerShell)

```powershell
# Chrome example — use the Edge or Brave path from the table above if needed
Get-ItemProperty "HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.piper.reader"
Test-Path (Get-ItemProperty "HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.piper.reader").'(default)'
```

`(Default)` must be a path to an existing JSON file. Open that JSON and confirm `"allowed_origins"` includes `chrome-extension://YOUR_ID/` (same ID as in `chrome://extensions`).

### Manual template

See `native-host/com.piper.reader.json.template`. Requirements:

- `"path"`: absolute path to a **launcher** (here `bridge.bat`) that runs Python with `bridge.py`.
- `"allowed_origins"`: must include `chrome-extension://<your-extension-id>/`

## 4. Use the extension

1. Ensure Docker is running (`docker compose ps`).
2. Select text on a normal web page.
3. Open the extension popup → **Read selection**.

Audio is decoded in a hidden **offscreen document** (service workers cannot use `AudioContext` reliably).

## Troubleshooting

| Symptom | Likely cause |
|--------|----------------|
| Popup says **Cannot reach Piper API** / HTTP errors | API not running on port **8765**, firewall, or wrong `-ApiUrl` in installer |
| **`Specified native messaging host not found`** | Wrong browser (e.g. Edge used but only Chrome was registered), registry points to a missing JSON path, or browser not restarted — rerun installer with `-Browsers All` or the browser you use; verify registry + `Test-Path` |
| **Access to the specified native messaging host is forbidden** | Extension ID mismatch — reinstall native host with correct `-ExtensionId`; `allowed_origins` must match exactly |
| **`{"detail":"Not Found"}`** at `/` on an **old** image | Rebuild the container (`docker compose up --build -d`); current API defines **`GET /`** |
| **No text selected** | Highlight text before clicking Read |
| Voice missing errors in curl/API | ONNX + `.onnx.json` not present under `./voices` |

### Logs

- API logs: `docker compose logs -f piper-api`
- Bridge: run `bridge.bat` from `%LOCALAPPDATA%\PiperReadAloudNativeHost` in a console (Chrome normally launches it headlessly).

## Project layout

- [`docker/Dockerfile`](docker/Dockerfile) — Piper + FastAPI image  
- [`docker-compose.yaml`](docker-compose.yaml) — publish `8765`, mount `./voices`  
- [`server/app/main.py`](server/app/main.py) — `GET /`, `GET /health`, `POST /v1/synthesize_stream` (NDJSON)  
- [`native-host/bridge.py`](native-host/bridge.py) — stdin/out Native Messaging + streaming HTTP client  
- [`extension/`](extension/) — MV3 extension (`background.js`, `offscreen.js`, popup)

## Environment variables

| Variable | Default | Purpose |
|---------|---------|---------|
| `PIPER_VOICES_DIR` | `/voices` | ONNX directory inside container |
| `PIPER_DEFAULT_VOICE` | `en_US-lessac-medium` | Default basename |
| `PIPER_BYTES_PER_PCM_CHUNK` | `8192` | Raw PCM bytes per NDJSON line |
| `PIPER_API_URL` | `http://127.0.0.1:8765/v1/synthesize_stream` | Override API URL (bridge) |
