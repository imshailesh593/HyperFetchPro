# User guide

This guide describes what works today in the Windows app. Features marked *(planned)* are not in the UI yet.

## Main window

- **Title bar:** engine status, the connection mode button, and search (`Ctrl+K`). Search matches file names and links.
- **Ribbon:** **Add URL** (`Insert`), **Resume all**, **Pause all**, **Start queue**, **Stop queue**, the speed graph for the last minute, and the total speed. *Stream Sniffer* is shown disabled until browser media detection exists.
- **Sidebar:** filters (All, Downloading, Completed, Paused/queued), categories with counts, the **speed limit** slider and the free space of the drive that holds your download folder.
- **List:** one row per download with icon, name, domain, category, status, percent, size, speed and ETA. The 32-cell strip shows which parts of the file are finished. Bright cells are complete, purple are partly done.
- **Status bar:** total active connections, the per-download connection limit, current disk write rate.

## Adding a download

1. Press **Add URL** or `Insert`. If your clipboard holds an http, https or ftp link it is filled in for you.
2. Optional: pick a **category** (automatic by file type by default) and a **folder** (blank = the category folder inside your default folder).
3. Optional, under *Authentication and cookies*: an `Authorization` header (for example `Bearer abc123`) and a `Cookie` header for sites that need a login.
4. **Download now** starts immediately. **Add to queue** puts it in the main queue to run when you press **Start queue**.

File names come from the server (`Content-Disposition`) or the link. If a file with that name already exists, or is already in the list, the new one is named `name (1).ext`.

## Controls

| Action | How |
|---|---|
| Pause / resume one | Row buttons, or right-click menu |
| Pause / resume everything | **Pause all** / **Resume all** |
| Connection details | The activity button on the row, or right-click → *Show connection details*. Shows live segment ranges, source URL, redirect target, ETag, errors |
| Open the file | Double-click a completed row |
| Show in Explorer | Folder button on a completed row |
| Copy link / curl command | Right-click menu |
| Remove | Right-click → *Remove from list* (keeps files) or *Remove and delete files* (asks first) |

Pausing keeps all partial data. Resuming checks that the file on the server is unchanged; if it changed, the download restarts from zero rather than producing a corrupt file. Servers that do not support byte ranges download over one connection and cannot resume mid-file.

## Connections and Turbo

The Turbo button switches between **8** connections per download (default) and **32**. More connections can be faster on high-latency or per-connection-limited links, but some servers limit or block many connections from one client. It applies to downloads started afterwards.

## Speed limit

The sidebar slider sets a **total** limit in MB/s from 10 to 199. At the far right it is **Unlimited**. The limit is shared evenly by running downloads and takes effect about half a second after you stop moving the slider. It is remembered.

## Queues

- Downloads added with **Add to queue** go to the **Main download queue**, which runs one download at a time by default.
- **Start queue** runs it; **Stop queue** pauses what is running (it resumes on the next start).
- Failed downloads are moved to the back of the queue and retried after 30 seconds, up to 20 attempts, then stay *Failed* with the error shown.
- Finished downloads leave the download queue and remain in the list.
- The **synchronization queue** re-checks its files each run and downloads again only if the server's version changed.
- Start and stop times, days of week, extra queues and parallel limits exist in the core; the Scheduler screen for them is *(planned)*.

## Categories

Default categories: Compressed, Documents, Music, Programs, Video. A download goes to `<default folder>\<category name>` unless you pick a folder. Editing categories and extensions is *(planned)* in the UI.

## Browser capture

See [BROWSER-INTEGRATION.md](BROWSER-INTEGRATION.md). In short: install the extension and native host once; then downloads of the configured file types in Chrome, Edge or Brave are handed to the app with your login cookies. If the app is not running, the browser keeps the download, so nothing is lost.

## Video and audio from websites

Works for YouTube, Instagram and the other sites yt-dlp supports.

1. Press **Add URL** and paste the page link of the video.
2. Press **Find video** in the *Video or audio from a website* box. The title, length and uploader appear with a **Quality** list (*Best available*, one entry per height, *Audio only*). Sizes are shown when the site reports them.
3. Choose a quality, then **Download now** or **Add to queue**. It appears in the list like any download (queues, pause, resume and retry behave the same) and is saved as `.mp4` in the Video category folder.

**First use:** if the tools are missing the box offers **Install video tools**. This downloads yt-dlp (from `github.com/yt-dlp`) and ffmpeg (about 130 MB, from yt-dlp's FFmpeg-Builds releases) into `<data folder>in`, checking each against its published SHA-256 before use. ffmpeg is needed because most sites serve video and audio separately and they must be merged; without it only single-file qualities are listed and many YouTube videos have none. On macOS install ffmpeg yourself (for example `brew install ffmpeg`).

Notes: private Instagram posts and stories need your login cookies (paste a `Cookie` header under *Authentication and cookies*). Playlists are not supported yet; a link downloads one video. Progress for merged videos restarts between the video and audio streams. yt-dlp must be kept current because sites change; update support is *(planned)*.

## Where data is stored

| Item | Location |
|---|---|
| Download list, queues, categories, settings | `%APPDATA%\DownloadManager\downloads.db` |
| Partial downloads | `<final file>.part` and `<final file>.part.json` beside the destination |
| yt-dlp / ffmpeg | `%APPDATA%\DownloadManager\bin` |
| Crash log | `%LOCALAPPDATA%\DownloadManager\crash.log` |
| Browser host files | `%LOCALAPPDATA%\DownloadManager\native-host` |

Default download folder: `Downloads` in your user profile (change with the `defaultDir` setting; a settings screen is *(planned)*).

Environment variables: `DM_DATA_DIR` (data folder), `DM_NODE` (node.exe path), `DM_CORE_HOST` (path to `host.mjs`), `DM_YTDLP`, `DM_FFMPEG` (tool paths).

## Troubleshooting

| Symptom | Likely cause and fix |
|---|---|
| Status shows "Engine unavailable" | `host.mjs` not found or Node not installed. Run `npm run build --workspace @dm/core-host`; make sure `node` is on PATH or set `DM_NODE` |
| App closes at start | See `%LOCALAPPDATA%\DownloadManager\crash.log` |
| Download restarts instead of resuming | The server changed the file, or does not support ranges |
| "Server ignored the Range request" | The server advertises ranges but does not honour them; set connections to 8 or try again |
| HTTP 403/401 | The site needs cookies or a header. Use the Add dialog's authentication fields, or capture through the extension |
| Extension shows OFF / "not running" | Start the app first; run `scripts\install-native-host.ps1` if you have not |
| "yt-dlp is not installed" | Install it through `media.install` (UI planned) or put `yt-dlp.exe` in `<data folder>\bin` |
| Video "Requested format is not available" | ffmpeg is missing, so no single-file format exists |
