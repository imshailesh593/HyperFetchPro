# Core protocol

The core (`apps/core-host`, bundled to `dist/host.mjs`) is a Node process that owns the engine, the scheduler and the database. A UI starts it as a child process and speaks **newline-delimited JSON** over its stdin/stdout. stdout carries only protocol lines; diagnostics go to stderr. When the UI closes the core's stdin, the core pauses every download, closes the database and exits.

```
→ {"id":1,"method":"download.add","params":{"url":"https://example.com/a.zip"}}
← {"id":1,"result":{ ...download row... }}
← {"id":1,"error":"Only http, https and ftp links are supported"}
← {"event":"download.progress","data":{ ... }}      (unsolicited)
```

`id` is a number chosen by the caller. Replies can arrive in any order. On start the core emits `{"event":"host.ready","data":{"pid":…,"dataDir":"…"}}`.

## Types

**Download row**

| Field | Type | Notes |
|---|---|---|
| `id` | number | |
| `url`, `finalUrl` | string, string\|null | `finalUrl` after redirects |
| `dir`, `filename` | string | destination is `dir` + `filename` |
| `size` | number\|null | bytes, null if unknown |
| `downloaded` | number | bytes (persisted about once a second) |
| `status` | `queued` `running` `paused` `completed` `failed` | |
| `categoryId`, `queueId` | number\|null | |
| `headers` | object | extra request headers (cookies, referer, …) |
| `error` | string\|null | last failure |
| `attempts`, `retryAt`, `queueOrder` | number | scheduler bookkeeping |
| `etag`, `lastModified` | string\|null | resume validators |
| `kind` | `http` \| `media` | media = yt-dlp |
| `format` | string\|null | yt-dlp format selector (media only) |
| `createdAt`, `completedAt` | epoch ms, epoch ms\|null | |

**Queue**: `id, name, kind ('download'|'sync'), maxParallel, startTime ('HH:MM'|null), stopTime, days (bitmask, bit0 = Sunday, 127 = every day), afterAction ('none'|'exit'|'shutdown'), running`.
**Category**: `id, name, extensions[], saveDir|null`.
**Segment**: `start, end (null if unknown), written` in bytes.

## Methods

| Method | Params | Result |
|---|---|---|
| `ping` | – | `{pong:true}` |
| `state.snapshot` | – | `{downloads[], queues[], categories[], settings:{defaultDir, speedLimit, maxConnections}}` |
| `download.add` | `url` (http/https/ftp), optional `dir`, `filename`, `headers`, `categoryId`, `queueId`, `startNow` | download row. `startNow:true` starts at once; otherwise it is queued in the main queue |
| `download.start` | `id` | `{}` |
| `download.pause` | `id` | `{}` |
| `download.remove` | `id`, optional `deleteFiles` | `{}` (stops it first; `deleteFiles` removes the file and partial data) |
| `downloads.pauseAll` / `downloads.resumeAll` | – | `{}` (resume starts paused, failed and queued rows) |
| `queue.start` / `queue.stop` | `id` | `{}` |
| `queue.update` | `id` plus any of `name, kind, maxParallel, startTime, stopTime, days, afterAction` | updated queue |
| `settings.set` | any of `speedLimit` (bytes/s, 0 = unlimited), `maxConnections` (1–32), `defaultDir` | `{}` |
| `media.status` | – | `{ytDlp:{path,version}\|null, ffmpeg:path\|null}` |
| `media.install` | – | installs yt-dlp; `{path, sha256}` |
| `media.installFfmpeg` | – | installs ffmpeg (Windows); `{path, sha256}` |
| `media.info` | `url` (http/https), optional `headers` | `{title, uploader, duration, thumbnail, webpageUrl, canMerge, formats[]}` where a format is `{id, label, ext, height, size, kind}` |
| `media.add` | `url`, `title`, `format` (a format `id`), optional `ext`, `dir`, `headers`, `startNow` | download row with `kind:'media'` |

Errors are plain strings: `Missing string parameter: url`, `Unknown method: x`, `Video downloads are not available`, and so on.

## Events

| Event | Data |
|---|---|
| `download.changed` | `{download: row}` on any state change |
| `download.progress` | `{id, downloaded, size, speed, segments[]}` about four times a second per running download |
| `download.removed` | `{id}` |
| `queue.changed` | `{queueId, running}` |
| `queue.finished` | `{queueId, afterAction}`: the UI decides whether to exit or shut down |
| `capture.added` | `{id}`: a browser download was handed over |
| `host.ready` | `{pid, dataDir}` |

## Local IPC (for the browser host)

Besides stdio, the core listens on a per-user endpoint: named pipe `\\.\pipe\DownloadManager.<username>` on Windows, `<dataDir>/dm.sock` (mode 0600) on macOS/Linux. Requests are one JSON line: `{"token":"…","method":"ping"|"capture","params":{…}}`; replies `{"ok":true,"result":…}` or `{"ok":false,"error":"…"}`. The token is generated on each start and written to `<dataDir>/ipc.token` (user-only), removed on exit. `capture` params: `url`, optional `filename`, `referrer`, `userAgent`, `cookie`.
