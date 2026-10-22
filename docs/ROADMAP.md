# Roadmap and known gaps

## Done

- Segmented engine: probing (HEAD, ranged-GET fallback), dynamic halving of the largest segment, preallocated `.part` file with positional writes, state saved every ~2 s, validator check on resume, retry with backoff and `Retry-After`, per-download shared speed throttle, filename sanitising.
- Store, queues, categories, retry-to-back scheduling, start/stop times by day, sync queues (skip unchanged files), unique file names, global speed limit split across running downloads.
- Core host, local IPC, native-messaging host, MV3 extension (verified in a real Edge browser: capture, cookie forwarding, no duplicate left behind).
- Options dialog (folder, connections, speed limit, video-tool status/install/update), verified through the real UI.
- Scheduler and category editor dialogs, verified through the real UI (queue created with 3 parallel downloads and a 02:00–06:00 schedule; category created and persisted).
- Packaging: self-contained build with bundled Node, per-user `Setup.exe` (Inno Setup) and zip; installing, running without Node on PATH, browser registration and uninstalling were verified.
- WinUI 3 app with the supplied design, including the video flow in the Add dialog (verified by driving the real UI: link from clipboard, Find video, download to a finished mp4).
- Media backend: format list, runner with pause/resume, checksum-verified yt-dlp installer (verified against the real release and a real public video), ffmpeg installer. Both were run against the real releases, and a real public video was downloaded, merged and checked with ffmpeg (19 s, video + audio, mp4).

## Next (suggested order)

1. **Video polish:** progress that spans video + audio, playlists, yt-dlp update button / auto-update, more sites tested (Instagram, private content).
2. **More options:** proxy settings, file types and sites to skip for browser capture inside the app, auto-update of yt-dlp.
3. **Release polish:** code signing, app icon and version info, auto-update (the app and yt-dlp), MSIX or winget package.
4. **Quotas** (for example 40 MB/hour) and **periodic sync repeat** interval.
5. **macOS app** (SwiftUI) over the same protocol; native-messaging manifests for macOS browsers; signing/notarization.
6. **Firefox** extension; stream/video sniffing in the extension; Alt-key bypass.
7. **Site Grabber** (crawler with filters), FTP downloading in the engine, proxy support, site logins stored in the OS credential store, antivirus hook, CLI.
8. **Android** (separate Kotlin app with on-device yt-dlp).

## Known limitations

- Not yet tried against real internet servers beyond the yt-dlp/GitHub requests; engine tests use local servers.
- The extension was verified in Edge only (see BROWSER-INTEGRATION.md); Chrome, Brave and Firefox are untried, and only a direct file link was tested (no referrer, no login-protected site).
- Only one site/video was tried for real (a short public YouTube clip). Instagram, private content and playlists are untested.
- Media progress is reported per stream, so video+audio downloads show progress restarting between streams.
- Proxy, FTP, checksums, and per-site connection limits are not implemented.
- Speed limit is divided evenly between running downloads (not by need).
- The installer is unsigned (SmartScreen warning) and the app has no custom icon yet.
- Segment state lives in a `.part.json` beside each download rather than in the database.
- Windows only; ffmpeg auto-install is Windows only.
- No license chosen yet.

## Out of scope

Kernel network drivers (as IDM uses), DRM circumvention, iOS, any server component.
