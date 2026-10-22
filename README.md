# HyperFetch Pro

A fast, resumable download manager for Windows (macOS planned) with a **native UI**, a shared TypeScript download core, browser integration, and video/audio downloading from YouTube, Instagram and 1000+ other sites through yt-dlp.

Everything runs on your own computer. There is no server, no account and no telemetry.

> Working name in the code and window title is "Download Manager"; "HyperFetch Pro" is the product name used in this documentation.

## Status

| Area | State |
|---|---|
| Segmented download engine (pause, resume, retry, speed limit) | Done, tested |
| Queues, scheduler (start/stop times, retry), categories, SQLite store | Done, tested |
| Core host (stdio JSON API) | Done, tested |
| Windows app (WinUI 3) | Working: list, Add dialog, drawer, filters, speed limit |
| Browser extension + native-messaging host (Chrome, Edge, Brave) | Built, host chain tested end to end; extension not yet tried inside a real browser |
| Video downloads (yt-dlp + ffmpeg) | Working end to end, including the Add-dialog flow (Find video, quality picker, one-click tool install): both tools install with checksum verification and a real public video downloaded and merged to a playable mp4. Only one site tried so far |
| Options screen (folder, connections, speed limit, video tools install/update) | Done, verified through the real UI |
| Scheduler and category-editor screens | Not built (the core supports them) |
| Installer / packaging, auto-update | Not built |
| macOS app (SwiftUI) | Not started (needs a Mac and Xcode) |
| Firefox, Android | Not started |

Details and known gaps: [docs/ROADMAP.md](docs/ROADMAP.md).

## Features

- **Faster downloads.** Each file is split into segments fetched over several connections (8 by default, 32 with the Turbo switch). When a connection frees up it splits the largest remaining piece in half, so all connections stay busy to the end.
- **Resume anywhere.** Progress is saved every two seconds. Pause, quit, crash or lose power and it continues from where it stopped, after checking the server's ETag / Last-Modified.
- **Queues and scheduling.** A main download queue, a main sync queue and your own queues, each with parallel-download limits and start/stop times by day. Failed items go to the back and are retried.
- **Categories.** Files are sorted into folders by type (Compressed, Documents, Music, Programs, Video, or your own).
- **Browser capture.** An extension takes over downloads by file type, forwards cookies and referrer, and falls back to the browser if the app is not running.
- **Video and audio from the web:** paste a link, press *Find video*, pick a quality; separate video/audio streams are merged to mp4; same queue and pause/resume behaviour as any download.
- **Speed limit** shared across all running downloads.
- **Native Windows 11 look** following the supplied design: acrylic window, live speed graph, 32-cell progress strip, connection-details drawer.

## Quick start (Windows)

Requirements: Node.js 22+ (24 recommended), .NET 9 SDK, Windows 10 SDK 10.0.19041+.

```powershell
npm install
npm test                                    # engine, store, scheduler, media, core-host
npm run build --workspace @dm/core-host     # builds apps/core-host/dist/host.mjs

cd apps\windows\DownloadManager
dotnet build -c Debug -p:Platform=x64
.\bin\x64\Debug\net9.0-windows10.0.19041.0\win-x64\DownloadManager.exe
```

The app starts the core itself (`node.exe` from PATH, or set `DM_NODE`). Browser integration setup is in [docs/BROWSER-INTEGRATION.md](docs/BROWSER-INTEGRATION.md).

## Documentation

| Document | Contents |
|---|---|
| [docs/USER-GUIDE.md](docs/USER-GUIDE.md) | Using the app: adding downloads, queues, categories, speed limit, browser capture, video downloads, data locations, troubleshooting |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Design: processes, engine algorithm, scheduler, data model, security, platform notes |
| [docs/PROTOCOL.md](docs/PROTOCOL.md) | The core's JSON protocol: every method and event (for building another UI) |
| [docs/BROWSER-INTEGRATION.md](docs/BROWSER-INTEGRATION.md) | Extension and native-messaging host: how they work, install, rules, security |
| [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) | Repo layout, building, testing, build quirks, how to add things |
| [docs/ROADMAP.md](docs/ROADMAP.md) | What is done, what is missing, planned order |

## Repository layout

```
packages/engine      segmented HTTP(S) downloader
packages/store       SQLite schema and repositories (node:sqlite)
packages/scheduler   DownloadManager + Scheduler (queues, schedules, retry, sync)
packages/media       yt-dlp / ffmpeg: discovery, install, format list, runner
apps/core-host       stdio JSON host + local IPC server for the browser
apps/native-host     browser native-messaging host
apps/extension       Chrome/Edge/Brave MV3 extension
apps/windows/DownloadManager   WinUI 3 app
scripts              install-native-host.ps1
```

## Responsible use

Downloading from sites such as YouTube or Instagram can conflict with their terms of service. Use this software only for content you own or are permitted to save. DRM-protected streams are out of scope and not supported. Because such sites change often, yt-dlp must be kept current (the app installs and updates it from its official GitHub releases, verified by checksum). Browser stores restrict downloader extensions, so the extension is installed unpacked.

## License

No license has been chosen yet. Until one is added, all rights are reserved by the author.
