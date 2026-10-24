# Roadmap and known gaps

## Done

- Segmented engine: probing (HEAD, ranged-GET fallback), dynamic halving of the largest segment, preallocated `.part` file with positional writes, state saved every ~2 s, validator check on resume, retry with backoff and `Retry-After`, per-download shared speed throttle, filename sanitising.
- Store, queues, categories, retry-to-back scheduling, start/stop times by day, sync queues (skip unchanged files), unique file names, global speed limit split across running downloads.
- Core host, local IPC, native-messaging host, MV3 extension (verified in a real Edge browser: capture, cookie forwarding, no duplicate left behind).
- Options dialog (folder, connections, speed limit, video-tool status/install/update), verified through the real UI.
- Scheduler and category editor dialogs, verified through the real UI (queue created with 3 parallel downloads and a 02:00–06:00 schedule; category created and persisted).
- Download limit (quota) with exact per-chunk counting in the engine, automatic resume after the period, persistence across restarts, queue-aware holding; sync queue repeat interval.
- Branding: product name HyperFetch Pro in the window, installer and extension, generated app icon (exe, taskbar, installer, title bar, extension toolbar) and version info; verified in the built app and installer.
- Packaging: self-contained build with bundled Node, per-user `Setup.exe` (Inno Setup) and zip; installing, running without Node on PATH, browser registration and uninstalling were verified.
- WinUI 3 app with the supplied design, including the video flow in the Add dialog (verified by driving the real UI: link from clipboard, Find video, download to a finished mp4).
- Playlists and channels: listed flat (fast), a checklist in the Add dialog, one quality for all selected videos, added to the main queue (verified with the real yt-dlp and in the real UI on a one-video channel; multi-video behaviour covered by tests with a fake yt-dlp).
- Video progress is one continuous figure across the video and audio streams (checked against the real yt-dlp: 18 updates, total matched the sum of both streams).
- Media backend: format list, runner with pause/resume, checksum-verified yt-dlp installer (verified against the real release and a real public video), ffmpeg installer. Both were run against the real releases, and a real public video was downloaded, merged and checked with ffmpeg (19 s, video + audio, mp4).

## Next (suggested order)

1. **Video polish:** yt-dlp auto-update, more sites tested (Instagram, private content), a download-all button for long playlists with per-video quality.
2. **More options:** proxy settings, file types and sites to skip for browser capture inside the app, auto-update of yt-dlp.
3. **Release polish:** code signing, auto-update (the app and yt-dlp), MSIX or winget package.
4. **macOS app** (SwiftUI) over the same protocol; native-messaging manifests for macOS browsers; signing/notarization.
5. **Firefox** extension; stream/video sniffing in the extension; Alt-key bypass.
6. **Site Grabber** (crawler with filters), FTP downloading in the engine, proxy support, site logins stored in the OS credential store, antivirus hook, CLI.
7. **Android** (separate Kotlin app with on-device yt-dlp).

## Known limitations

- Not yet tried against real internet servers beyond the yt-dlp/GitHub requests; engine tests use local servers.
- The extension was verified in Edge only (see BROWSER-INTEGRATION.md); Chrome, Brave and Firefox are untried, and only a direct file link was tested (no referrer, no login-protected site).
- Only one site/video was tried for real (a short public YouTube clip, also as a one-video channel list). Instagram, private content and long playlists are untested; playlist downloads run through the main queue one at a time by default.
- Proxy, FTP, checksums, and per-site connection limits are not implemented.
- The download limit can overshoot by roughly (connections x chunk size) = about 1 to 2 MB; video (yt-dlp) downloads are counted from progress reports and can overshoot more. The period is a fixed window from the first byte, not a rolling one. Only unit tests cover the automatic resume after a period (the shortest period is 6 minutes).
- Speed limit is divided evenly between running downloads (not by need).
- The installer is unsigned (SmartScreen warning). The icon is a simple generated design; a designer's version could replace it.
- Segment state lives in a `.part.json` beside each download rather than in the database.
- Windows only; ffmpeg auto-install is Windows only.
- No license chosen yet.

## Out of scope

Kernel network drivers (as IDM uses), DRM circumvention, iOS, any server component.
