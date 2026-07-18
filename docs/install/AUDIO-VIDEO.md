# Audio and video processing setup

Phase 3.5 of the DevNeural daemon adds local transcription for audio
and video uploads to the reference corpus. The implementation is in
the daemon (`07-daemon/src/reference/audio.ts` and `video.ts`); this
doc covers the two external binaries the daemon shells out to and how
to install them on Windows.

If neither binary is installed, audio and video uploads still land on
disk. They are recorded with status `queued` and a warning notification
fires on the dashboard. Once the binaries are installed and env vars
set, the same files can be re-processed.

## Why these tools

- **whisper.cpp**, not `whisper-node` or the OpenAI Whisper API.
  - No Python or Torch dependency. One C++ binary plus a model file.
  - Runs offline, on CPU, on the same machine as the daemon. No data
    leaves `OTLCDEV`.
  - Fast on modern CPUs with the `base.en` model. Larger models
    available if accuracy matters more than speed.
- **ffmpeg**, not a JS demuxer.
  - The reference implementation. Handles every container format we
    care about (mp4, mov, mkv, webm, avi, wmv).
  - One install via winget. Already on most dev machines.

No cloud APIs. No per-file cost. This is a one-time setup.

## 1. Install ffmpeg

```powershell
winget install Gyan.FFmpeg
```

After install, open a fresh PowerShell window and confirm:

```powershell
ffmpeg -version
```

If `ffmpeg` is not on PATH, set the env var so the daemon can find it:

```powershell
[Environment]::SetEnvironmentVariable('DEVNEURAL_FFMPEG_BIN', 'C:\path\to\ffmpeg.exe', 'User')
```

## 2. Get whisper.cpp

Two paths. Pick one. Both end up at `C:\dev\whisper.cpp\` so the
daemon's fallback probe list finds them.

### 2a. Prebuilt binary (no Visual Studio required)

```powershell
mkdir C:\dev\whisper.cpp -Force
cd C:\dev\whisper.cpp
curl -L -o whisper-bin.zip https://github.com/ggerganov/whisper.cpp/releases/latest/download/whisper-bin-x64.zip
Expand-Archive -Path whisper-bin.zip -DestinationPath . -Force
```

Result: `C:\dev\whisper.cpp\Release\whisper-cli.exe` (and a number of
sibling executables). CPU-only inference, which is fine for `base.en`
on any modern machine.

> **Heads-up:** older releases shipped a `main.exe` that did the
> transcription. Recent builds replaced `main.exe` with a deprecation
> stub that prints a warning and exits without doing any work. Always
> point `DEVNEURAL_WHISPER_BIN` (if you set it at all) at
> `whisper-cli.exe`, never `main.exe`.

### 2b. Build from source (CUDA, fine-tuned, custom flags)

Requires Visual Studio Build Tools + CMake (`winget install
Microsoft.VisualStudio.2022.BuildTools` + `winget install
Kitware.CMake`). Skip unless you need GPU acceleration or a custom
build.

```powershell
cd C:\dev
git clone https://github.com/ggerganov/whisper.cpp
cd whisper.cpp
cmake -B build
cmake --build build --config Release
```

Result: `build\bin\Release\whisper-cli.exe` (modern CMake build). The
daemon's fallback list still mentions `main.exe` for compatibility with
ancient builds, but on any current source checkout `whisper-cli.exe` is
the only binary that actually transcribes; `main.exe` if present is a
deprecation stub.

## 3. Download a model

`base.en` is the recommended default. It is fast, English-only,
roughly 140MB, and accurate enough for technical content.

```powershell
cd C:\dev\whisper.cpp\models
curl -L -o ggml-base.en.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin
```

Larger options if you need more accuracy: `small.en` (470MB),
`medium.en` (1.5GB). The trade-off is transcription speed.

## 4. Tell the daemon where to look

The daemon will probe a list of fallback paths under `C:/dev/whisper.cpp/`.
If you installed elsewhere, set these in your shell profile or via a
`.env` file the daemon reads:

| Variable | Default | Purpose |
|---|---|---|
| `DEVNEURAL_WHISPER_BIN` | probes `C:/dev/whisper.cpp/...` then PATH | Full path to `whisper-cli.exe`. Never set this to `main.exe`; in current builds it is a deprecation stub that exits without transcribing. |
| `DEVNEURAL_WHISPER_MODEL` | `base.en` | Model name (without the `ggml-` prefix and `.bin` extension) |
| `DEVNEURAL_WHISPER_MODEL_PATH` | derived from model name | Full path to a `.bin` model file (overrides `DEVNEURAL_WHISPER_MODEL`) |
| `DEVNEURAL_FFMPEG_BIN` | `ffmpeg` (PATH) | Full path to `ffmpeg.exe` |

Example PowerShell:

```powershell
[Environment]::SetEnvironmentVariable('DEVNEURAL_WHISPER_BIN', 'C:\dev\whisper.cpp\Release\whisper-cli.exe', 'User')
# (or for source-build path: 'C:\dev\whisper.cpp\build\bin\Release\whisper-cli.exe')
[Environment]::SetEnvironmentVariable('DEVNEURAL_WHISPER_MODEL_PATH', 'C:\dev\whisper.cpp\models\ggml-base.en.bin', 'User')
[Environment]::SetEnvironmentVariable('DEVNEURAL_WHISPER_MODEL', 'base.en', 'User')
```

## 5. Verify

Restart the daemon so it picks up the new env vars. Upload a small
mp3 to the dashboard:

```powershell
curl.exe -X POST -F "file=@C:\path\to\sample.mp3" http://localhost:3747/upload
```

Watch the daemon log for a line like:

```
[reference] sample.mp3: 4 chunks embedded, 1842 chars
```

For video, drop a short mp4 onto the dashboard upload zone. The daemon
demuxes the audio track via ffmpeg, transcribes it via whisper, and
chunks the result the same way as a PDF.

## Troubleshooting

- **"whisper.cpp binary not found"**: env var unset and the daemon's
  fallback paths were not present. Either install whisper.cpp at
  `C:/dev/whisper.cpp/` or set `DEVNEURAL_WHISPER_BIN`.
- **"whisper model file not found"**: the binary was found but no
  `ggml-<model>.bin` lives in `C:/dev/whisper.cpp/models/`. Download
  the model (see step 3) or set `DEVNEURAL_WHISPER_MODEL_PATH` to a
  full path.
- **"ffmpeg binary not on PATH"**: you installed via winget but the
  PATH update only applies to new shells. Restart the daemon from a
  fresh PowerShell window.
- **Whisper exits non-zero with no transcript**: check the daemon log
  for the last 500 chars of stderr. Common cause: the audio file is
  zero bytes or in an unsupported format. The daemon hands ffmpeg's
  16kHz mono WAV to whisper, so format issues usually mean ffmpeg
  itself failed. Check the upload's status in the dashboard.
- **Slow transcription**: switch to a smaller model (`tiny.en`) or
  build whisper.cpp with GPU support. CUDA on NVIDIA: rebuild with
  `cmake -B build -DGGML_CUDA=1`. The daemon does not care which
  build it calls; the binary handles GPU dispatch internally.
- **Re-process a queued upload**: any audio or video upload that hit
  the daemon before the binaries were installed has status `queued`.
  Re-uploading the same file works; a re-process endpoint is on the
  Phase 3.6 list.

## Brainstorm session audio retention (Wave 2 day 2)

Per spec section 11 day 2 step 11, a brainstorm or meeting voice
session writes a single canonical audio bundle at
`<DATA_ROOT>/brainstorms/<id>/audio/`:

- `<id>.wav` — concatenated PCM with a standard RIFF header.
- `<id>.cues.json` — per-turn `[{ turn_index, start_ms, end_ms }]`
  offsets so the dashboard player can jump to any utterance.

The daemon serves these via `GET /brainstorms/:id/audio` (Range
support; iOS Safari requires it for the seek bar) and
`GET /brainstorms/:id/cues`. Cache-Control is `no-store`; the
service worker is configured to skip caching audio so multi-hour
sessions do not displace the dashboard's static assets.

### Sensitivity and ACL

`<DATA_ROOT>/brainstorms/<id>/audio/` inherits the data root
permissions. On a multi-user host, lock the folder to the daemon
owner only:

```powershell
icacls "$env:DEVNEURAL_DATA_ROOT\brainstorms" /inheritance:r /grant:r "$env:USERNAME:(OI)(CI)F" /T
```

### Meeting consent gate (BF-17)

Meeting-kind sessions only retain audio after the user posts to
`POST /meetings/:id/consent-ack` (Wave 2 day 5). Until consent is
acknowledged, transcription still runs but PCM frames are dropped
on session-end (`audio-bundle.discard()` instead of `finalize()`).
Brainstorm-kind sessions retain audio by default; that is governed
by `DEVNEURAL_AUDIO_MAX_AGE_DAYS=0` (forever). Meeting audio defaults
to `DEVNEURAL_MEETING_AUDIO_MAX_AGE_DAYS=30`.
