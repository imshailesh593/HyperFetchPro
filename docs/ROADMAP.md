# Roadmap and known gaps

## Done

- Segmented engine: probing (HEAD, ranged-GET fallback), dynamic halving of the largest segment, preallocated `.part` file with positional writes, state saved every ~2 s, validator check on resume, retry with backoff and `Retry-After`, per-download shared speed throttle, filename sanitising.
- Store, queues, categories, retry-to-back scheduling, start/stop times by day, sync queues (skip unchanged files), unique file names, global speed limit split across running downloads.
- Core host, local IPC, native-messaging host, MV3 extension.
- Options dialog (folder, connections, speed limit, video-tool status/install/update), verified through the real UI.
- WinUI 3 app with the supplied design, including the video flow in the Add dialog (verified by driving the real UI: link from clipboard, Find video, download to a finished mp4).
- Media backend: format list, runner with pause/resume, checksum-verified yt-dlp installer (verified against the real release and a real public video), ffmpeg installer. Both were run against the real releases, and a real public video was downloaded, merged and checked with ffmpeg (19 s, video + audio, mp4).

## Next (suggested order)

1. **Video polish:** progress that spans video + audio, playlists, yt-dlp update button / auto-update, more sites tested (Instagram, private content).
2. **More options:** proxy settings, file types and sites to skip for browser capture inside the app, auto-update of yt-dlp.
3. **Scheduler screen** and category editor: expose what the core already supports.
4. **Packaging:** bundle Node, installer, native-host registration, auto-update (the app and yt-dlp).
5. **Quotas** (for example 40 MB/hour) and **periodic sync repeat** interval.
6. **macOS app** (SwiftUI) over the same protocol; native-messaging manifests for macOS browsers; signing/notarization.
7. **Firefox** extension; stream/video sniffing in the extension; Alt-key bypass.
8. **Site Grabber** (crawler with filters), FTP downloading in the engine, proxy support, site logins stored in the OS credential store, antivirus hook, CLI.
9. **Android** (separate Kotlin app with on-device yt-dlp).

## Known limitations

- Not yet tried against real internet servers beyond the yt-dlp/GitHub requests; engine tests use local servers.
- The extension has not been loaded in a real browser; the native-host and core chain was tested with scripted messages.
- Only one site/video was tried for real (a short public YouTube clip). Instagram, private content and playlists are untested.
- Media progress is reported per stream, so video+audio downloads show progress restarting between streams.
- Proxy, FTP, checksums, and per-site connection limits are not implemented.
- Speed limit is divided evenly between running downloads (not by need).
- The app needs Node.js on the machine until packaging is done.
- Segment state lives in a `.part.json` beside each download rather than in the database.
- Windows only; ffmpeg auto-install is Windows only.
- No license chosen yet.

## Out of scope

Kernel network drivers (as IDM uses), DRM circumvention, iOS, any server component.
