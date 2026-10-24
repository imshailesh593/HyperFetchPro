# User guide

This guide describes what works today in the Windows app. Features marked *(planned)* are not in the UI yet.

## Installing

Run `HyperFetchPro-Setup-<version>.exe`. It installs for your user account (no administrator needed), adds a Start-menu shortcut, and by default sets up browser integration for Chrome, Edge and Brave. Nothing else needs to be installed; the app brings its own engine. Because the installer is not code-signed, Windows SmartScreen may ask you to confirm (*More info*, then *Run anyway*).

To finish browser setup, load the extension once: open `chrome://extensions` (or `edge://extensions`), turn on *Developer mode*, choose *Load unpacked*, and pick the `integration\extension` folder inside the install folder (the final installer page can open it for you).

Uninstall from *Settings > Apps*. This removes the program and the browser registration but keeps your download list and settings (`%APPDATA%\DownloadManager`); delete that folder as well if you want a clean slate.

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

## Options

Open with the **Options** button or `Ctrl+,`.

- **Default download folder:** must be a full path. Files go into a category subfolder inside it unless you choose a folder when adding.
- **Connections per download:** 1 to 32 (default 8). Applies to downloads started afterwards.
- **Speed limit:** in MB/s across all downloads; 0 means unlimited. Also adjustable from the sidebar slider.
- **Video tools:** shows the installed yt-dlp version and whether ffmpeg is present, with **Install** (or **Check for update**) for yt-dlp and **Install ffmpeg**. *Check for update* installs a newer official release only if there is one and tells you what it did.
- **Keep yt-dlp up to date automatically** (on by default): shortly after the app starts and then every few hours, the app checks at most once a day whether a newer yt-dlp exists and installs it, but never while a video is downloading. You get a notice when it updates. If the computer is offline the check is simply retried later. Untick it to update only by hand.
- **Download limit:** a maximum amount (MB) per period (hours), for connections with a fair-use cap, for example 40 MB per 1 hour. When the amount is used up, running downloads pause and new ones wait; the status bar says *Download limit reached. Resumes at HH:MM*, and everything continues by itself when the period ends. The period starts at the first byte downloaded and the used amount survives restarts. The limit can be exceeded by about 1 to 2 MB (data already in flight when downloads stop). Videos downloaded through yt-dlp are counted from progress reports and can overshoot more. 0 turns the limit off.
- **Data:** where the database, tools and crash log live.

Save applies everything at once and is remembered. Proxy settings and the browser file-type lists (set in the extension's own options) are not in this dialog yet.

## Connections and Turbo

The Turbo button switches between **8** connections per download (default) and **32**. More connections can be faster on high-latency or per-connection-limited links, but some servers limit or block many connections from one client. It applies to downloads started afterwards.

## Speed limit

The sidebar slider sets a **total** limit in MB/s from 10 to 199. At the far right it is **Unlimited**. The limit is shared evenly by running downloads and takes effect about half a second after you stop moving the slider. It is remembered.

## Queues and the Scheduler

- Downloads added with **Add to queue** go to the **Main download queue**.
- **Start queue** / **Stop queue** in the ribbon run or stop the main queue. Stopping pauses what is running; the next start resumes it.
- Failed downloads move to the back of the queue and are retried after 30 seconds, up to 20 attempts, then stay *Failed* with the error shown. Finished downloads leave a download queue but stay in the list.
- A **synchronization queue** keeps its files and, each run, downloads again only those that changed on the server.

Open **Scheduler** in the ribbon to manage queues. Pick a queue on the left, or create a **New queue** (download or synchronization). For each queue you can set:

- **Name** and **files downloaded at the same time** (1 to 10).
- **Start at** and **Stop at** (24-hour times) and the **days** they apply to. The app must be running at that time. A schedule fires once per minute match; stopping by hand inside that minute is not undone.
- **When the queue finishes:** do nothing, or exit the application. (A shut-down option exists in the core but is not offered in the UI.)
- **Apply** saves; **Start now** and **Stop** control the queue immediately.

- **Repeat every N minutes** (synchronization queues): after a check finishes, the queue runs again after N minutes until its stop time (or the end of the day). Stopping the queue ends the repetition.

Deleting a custom queue keeps its downloads in the list, just unqueued. The two main queues cannot be deleted.

When the download limit (see Options) is reached, queue items that were running go back to *Queued* and the queue resumes them in order after the period ends.

## Categories

Default categories: Compressed, Documents, Music, Programs, Video. A download goes to `<default folder>\<category name>` unless you pick a folder, or the category has its own folder.

Click the pencil next to **CATEGORIES** in the sidebar to edit them: change the name, the file types (extensions separated by spaces) and an optional save folder (a full path; blank = a folder named after the category), add a **New category**, or delete one. If two categories list the same type, the newer one wins. Deleting a category does not touch files; its downloads just lose the label. Existing downloads are not moved when you change a folder.

## Browser capture

See [BROWSER-INTEGRATION.md](BROWSER-INTEGRATION.md). In short: install the extension and native host once; then downloads of the configured file types in Chrome, Edge or Brave are handed to the app with your login cookies. If the app is not running, the browser keeps the download, so nothing is lost.

## Video and audio from websites

Works for YouTube, Instagram and the other sites yt-dlp supports.

1. Press **Add URL** and paste the page link of the video.
2. Press **Find video** in the *Video or audio from a website* box. The title, length and uploader appear with a **Quality** list (*Best available*, one entry per height, *Audio only*). Sizes are shown when the site reports them.
3. Choose a quality, then **Download now** or **Add to queue**. It appears in the list like any download (queues, pause, resume and retry behave the same) and is saved as `.mp4` in the Video category folder.

**First use:** if the tools are missing the box offers **Install video tools**. This downloads yt-dlp (from `github.com/yt-dlp`) and ffmpeg (about 130 MB, from yt-dlp's FFmpeg-Builds releases) into `<data folder>in`, checking each against its published SHA-256 before use. ffmpeg is needed because most sites serve video and audio separately and they must be merged; without it only single-file qualities are listed and many YouTube videos have none. On macOS install ffmpeg yourself (for example `brew install ffmpeg`).

Notes: private Instagram posts and stories need your login cookies (paste a `Cookie` header under *Authentication and cookies*). **Playlists, channels and multi-item posts:** paste the playlist or channel link and press **Find video**. A checklist of the videos appears (all ticked; use **All** / **None**), with a quality list that applies to every selected video. **Add to queue** puts them in the main queue; **Download now** also starts the queue, so they download one after another (raise *files downloaded at the same time* in the Scheduler to run several together). Up to 500 videos are listed, and private or deleted ones are skipped. A video link that also names a playlist (`watch?v=...&list=...`) is treated as that one video; paste the plain playlist link to get the list. The progress bar covers the whole video (video and audio streams together). yt-dlp must be kept current because sites change; the app does this for you by default (see Options), or use *Check for update*.

## Where data is stored

| Item | Location |
|---|---|
| Download list, queues, categories, settings | `%APPDATA%\DownloadManager\downloads.db` |
| Partial downloads | `<final file>.part` and `<final file>.part.json` beside the destination |
| yt-dlp / ffmpeg | `%APPDATA%\DownloadManager\bin` |
| Crash log | `%LOCALAPPDATA%\DownloadManager\crash.log` |
| Browser host files | `%LOCALAPPDATA%\DownloadManager\native-host` |

Default download folder: `Downloads` in your user profile; change it in Options.

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
