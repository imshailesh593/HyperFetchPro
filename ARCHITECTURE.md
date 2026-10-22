# Download Manager — System Architecture

Desktop download manager with a **native UI** (Windows first, macOS second). No backend: everything runs on the user's machine.

## 1. Goals / non-goals

- Fast segmented downloads with pause/resume that survives crashes.
- Queues + scheduler, categories, browser capture, video/site grabbing via yt-dlp.
- Windows and macOS from one codebase.
- Non-goals: kernel network drivers, DRM circumvention, iOS, any server component.

## 2. Stack

| Layer | Choice | Why |
|---|---|---|
| Windows UI | **WinUI 3** (C#, .NET 9, Windows App SDK, unpackaged) | Native Windows 11 controls; design from `windows_11_fluent_download_manager.html` |
| macOS UI | **SwiftUI** (planned) | Native; needs a Mac with Xcode to build and test |
| Core ("host") | TypeScript on Node, no UI imports | Engine, store, scheduler are shared by every UI; tested headless |
| UI ↔ core | Newline-delimited JSON over the host's stdio | No ports, no auth surface, works the same on both platforms |
| Storage | SQLite via Node's built-in `node:sqlite` | No native module to compile. Segment state is a `<file>.part.json` beside the download (engine-owned) |
| Media | `yt-dlp` + `ffmpeg` sidecar binaries | Extractors for YouTube/Instagram/1000+ sites |
| Browser capture | WebExtension (MV3) + native messaging host | No driver needed |
| Packaging | Windows: self-contained exe + bundled `node.exe` + `host.mjs`; macOS: signed + notarized app | |

The earlier plan (Electron + web UI) was dropped: the UI must be native. The core was written UI-free, so nothing in it changed.

## 3. Process model

```
 Browser extension ──native messaging──▶ Native messaging host (planned)
                                              │ forwards to the running app
                                              ▼
 ┌───────────────────────── Native app (WinUI 3 / SwiftUI) ─────────────────────────┐
 │  Views + view-models · tray · file pickers · clipboard · Explorer/Finder         │
 │            │  CoreClient: JSON lines over stdin/stdout                           │
 └────────────┼─────────────────────────────────────────────────────────────────────┘
              ▼
 ┌──────────────────────── Core host (Node child process) ──────────────────────────┐
 │  Api (request handler) ─▶ DownloadManager + Scheduler ─▶ Downloader (per file)   │
 │                              Store (SQLite)        Media host ─▶ yt-dlp / ffmpeg │
 └───────────────────────────────────────────────────────────────────────────────────┘
```

Protocol: requests `{"id":1,"method":"download.add","params":{...}}`, replies `{"id":1,"result":...}` or `{"id":1,"error":"..."}`, events `{"event":"download.progress","data":{...}}`.
Methods: `state.snapshot`, `download.add|start|pause|remove`, `downloads.pauseAll|resumeAll`, `queue.start|stop|update`, `settings.set`.
Events: `download.changed|progress|removed`, `queue.changed|finished`, `host.ready`.
The host shuts down (pausing every download) when the app closes its stdin.

Rules:
- The UI never touches the network or the database; it only speaks the protocol above.
- The core never imports UI code, so it runs under plain Node and in tests.
- Sidecar binaries live in app resources and are launched with absolute paths only.

## 4. Layout

```
packages/
  engine/      segmented HTTP(S) downloader, retry, speed limiter        (done)
  store/       SQLite schema, migrations, repositories                    (done)
  scheduler/   DownloadManager + Scheduler: queues, schedules, sync       (done)
  media/       yt-dlp/ffmpeg: discovery, verified install, formats, runner (done, no UI yet)
apps/
  core-host/   stdio JSON host that wraps the packages above              (done)
  windows/DownloadManager/   WinUI 3 app                                  (first version done)
  macos/       SwiftUI app                                                (planned)
  native-host/ browser native-messaging host                              (done)
  extension/   Chrome/Edge/Brave MV3 extension (Firefox later)             (first version done)
```

## 5. Download engine

**Probe:** HEAD (fall back to GET `Range: bytes=0-0`) → size, `Accept-Ranges`, ETag/Last-Modified, filename (Content-Disposition), final URL after redirects.

**Segmentation (IDM-style dynamic halving):**
1. Start with one segment covering `[0, size)`.
2. When a connection is free (below `maxConnections`), pick the segment with the most remaining bytes and split it in half; the new connection takes the upper half.
3. When a connection reaches the start of the next segment it stops and takes a new job (connection reuse via keep-alive agent).
4. Splits smaller than `minSplitSize` (default 256 KiB) are not made.
5. No range support or unknown size → single stream, no resume beyond restart.

**Writing:** preallocate the target `.part` file, write each segment at its offset (positional writes), so no merge step is needed.

**State:** segment table `(download_id, start, end, written)` flushed every ~2 s and on pause. On resume, validate ETag/Last-Modified (unless "ignore modification time" is set) and `.part` size, then continue each segment from `start + written`.

**Resilience:** per-segment retry with backoff; 429/503 honour `Retry-After`; mid-stream disconnect resumes from last written byte; checksum optional when server provides one.

**Throttling:** one token-bucket shared across a download, plus a global one. Download quotas (e.g. 40 MB/h) enforced by the scheduler.

**Auth/network:** Basic/Digest auth, cookies and headers passed from the extension, proxy settings (system or manual), custom User-Agent and Referer.

## 6. Queue and scheduler

- Entities: `queue` (main download, main sync, custom), `download`, `schedule`.
- A queue runs up to *N* downloads concurrently; failed items go to the back and retry every 30 s.
- Schedules: start time, stop time, days, "exit/shutdown when done".
- Sync queues: conditional request (ETag / Last-Modified); re-download only if changed.
- Scheduler is a single timer loop in the main process; all state in SQLite so it survives restarts.

## 7. Media (yt-dlp) subsystem

- `media` runs `yt-dlp -J <url>` to list formats; UI shows a quality picker.
- Direct progressive formats go through our own engine; DASH/HLS and merges go through yt-dlp + ffmpeg, with progress parsed from its output.
- Sidecar updater downloads new yt-dlp releases from GitHub Releases, verifies the published checksum, and swaps atomically. This is the only recurring network dependency.
- Cookies: passed from the browser extension, or yt-dlp `--cookies-from-browser`, for private Instagram content.
- Out of scope: DRM-protected streams.

## 8. Browser capture

- Extension watches `chrome.downloads`/`webRequest` for matches against the file-type list and site exclusion list, plus a page "Download this video" button.
- It cancels the browser download and sends `{url, headers, cookies, referrer, filename}` to the native host, which forwards it over the local socket to the app.
- If the app is not running, the host launches it. Alt-click bypasses capture.
- Distribute the extension outside the Chrome Web Store (policy bans YouTube downloaders); Firefox/Edge add-on stores to be checked separately.

## 9. Data model (SQLite)

```
downloads(id, url, final_url, path, filename, size, status, category_id,
          queue_id, etag, last_modified, headers_json, created_at, completed_at, error)
segments(download_id, idx, start, end, written)
queues(id, name, kind, max_parallel, start_at, stop_at, days, after_action)
categories(id, name, extensions, save_dir)
settings(key, value)
site_logins(host_pattern, username, secret_ref)   -- secret in OS keychain
```

Secrets go in the OS credential store (Windows Credential Manager / macOS Keychain), not SQLite.

## 10. UI (Windows, as built)

Custom title bar (engine status, connection mode, search with Ctrl+K), command ribbon (Add URL with Insert, Resume/Pause all, Start/Stop queue, live speed graph and total speed), sidebar (transfer filters, categories with counts, speed limit slider, drive free-space meter), download list (icon, name, domain, category, progress, a 32-cell strip showing which parts of the file are done, size, speed, ETA, row actions, context menu), connection-details drawer (live segment ranges, source URL, ETag, errors), Add dialog (clipboard autodetect, category, folder, auth/cookie headers) and a status bar.

Mock-up items deliberately not carried over because the engine has no such feature: magnet/P2P swarm, QUIC/HTTP3 and congestion-control readouts, DirectStorage IOPS, TLS cipher display, on-the-fly SHA-256, fixed "32 streams" (replaced by a real 8/32 connection toggle). "Stream Sniffer" is present but disabled until the browser extension exists.

## 11. Platform notes

| Concern | Windows | macOS |
|---|---|---|
| Installer | NSIS, code-signed | dmg, signed + notarized (Apple Developer account) |
| Native messaging registration | Registry key per browser | JSON manifest in browser support dirs |
| IPC | Named pipe | Unix domain socket |
| Auto-start | Registry Run key | Login item |
| Sidecars | `yt-dlp.exe`, `ffmpeg.exe` | `yt-dlp_macos`, universal ffmpeg (arm64 + x64) |

## 12. Security

- Context isolation on, no Node in renderer, strict CSP.
- Validate every IPC and native-host message against a schema.
- Native host accepts only the extension's ID and talks to the app over a per-user socket with an auth token.
- Sanitize filenames (no traversal, reserved names), confirm before overwriting.
- Run sidecars with argument arrays, never shell strings.

## 13. Roadmap

1. **Engine** (done): probe, segmentation, resume, retry, speed limit, tests against a local range-capable server.
2. **Store + queue/scheduler** (done): `@dm/store` (SQLite), `@dm/scheduler` (`DownloadManager` + `Scheduler`: queues, schedules, retry-to-back, sync queues, categories, unique filenames).
   Not yet: periodic sync repeat interval, global (cross-download) speed limit, download quotas.
3. **Electron shell + UI** (list, Add URL, progress, options).
4. **Browser extension + native host**.
5. **Media (yt-dlp/ffmpeg)**.
6. **Extras:** site logins, proxy, FTP, antivirus hook, CLI, import/export.
7. **macOS build**, signing, auto-update.
8. **Site Grabber** (optional).
9. **Android app** later, reusing the same queue/scheduler rules.

## Browser capture (as built)

`extension` (MV3) sees `downloads.onCreated`, applies the file-type / excluded-host rules, **pauses** the browser download, sends `{url, referrer, cookies, userAgent}` via `chrome.runtime.sendNativeMessage` to `native-host`, and only cancels the browser's copy once the app confirms. If the app isn't running or refuses, the browser download is resumed, so nothing is lost. Right-click "Download with Download Manager" bypasses the rules.
`native-host` (length-prefixed JSON on stdio) relays to the core over a per-user named pipe (Windows) or Unix socket (macOS). Every request needs the token in `<dataDir>/ipc.token` (created at core start, removed at exit). Install with `scripts/install-native-host.ps1` (HKCU keys for Chrome, Edge, Brave; extension ID is pinned by the key in `manifest.json`).
Not done: Firefox (needs a different manifest + gecko ID), video/stream detection, the Alt-key bypass, macOS manifest locations.

## Media downloads (as built)

`packages/media` finds `yt-dlp` and `ffmpeg` (env override, then `<dataDir>/bin`, then PATH), reads video info with `yt-dlp -J --no-playlist`, and `simplify()` turns it into a short quality list: with ffmpeg, "best" plus one merged entry per height; without it, only formats that already contain audio and video, plus best audio. Real-world finding: YouTube now serves separate video and audio streams, so without ffmpeg many videos have no usable single-file format.

A media download is an ordinary download row with `kind='media'` and the chosen yt-dlp format selector in `format`. `DownloadManager` builds a `MediaDownloader` instead of the HTTP engine; it has the same shape (`start()` -> completed|paused, `pause()`, `progress` events), so queues, retries, pause/resume and the UI work unchanged. yt-dlp is started with an argument array, the link placed after `--`, progress via `--progress-template`, and the final path via `--print after_move:`; pausing kills the process tree (`taskkill /T` on Windows because `yt-dlp.exe` is a launcher) and yt-dlp's partial files are continued on resume.

Installers download only from `github.com/yt-dlp` (yt-dlp and yt-dlp/FFmpeg-Builds), verify the published SHA-256, and swap the file in atomically. ffmpeg is extracted from the release zip with the Windows built-in `tar`.
