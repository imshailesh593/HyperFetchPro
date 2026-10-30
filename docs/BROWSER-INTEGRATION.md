# Browser integration

Supported: Chrome, Edge and Brave on Windows (Manifest V3). Firefox and macOS paths are not done yet.

## How it works

```
Browser ── downloads.onCreated ──▶ extension (background.js)
   pause the browser's download            │ chrome.runtime.sendNativeMessage
                                           ▼
                              native host (apps/native-host)   ← launched by the browser,
                                           │ named pipe + token     stdio, 4-byte length framing
                                           ▼
                                 core host in the running app
```

1. The extension sees a new browser download and checks the rules (enabled, file extension in the list, host not excluded, minimum size).
2. If it matches, it **pauses** the browser's download, collects the cookies for that URL, and sends `{url, referrer, cookie, userAgent}` to the native host.
3. The native host reads the token from `%APPDATA%\DownloadManager\ipc.token` and forwards the request to the app over its per-user named pipe.
4. Only when the app answers *ok* does the extension cancel and erase the browser's copy. If the app is not running or refuses, the browser download is **resumed**, and the toolbar badge shows `OFF` or `!`.

Right-click any link, video or audio element and choose **Download with Download Manager** to send it regardless of the rules.

## Videos on web pages

For video sites (YouTube, Instagram, members-only sites and anything else yt-dlp understands) the extension can send the **page** to the app instead of a file:

- **Download button over videos.** Move the pointer over a video on a web page and a small *Download* pill appears in its top-left corner (only for videos at least 220 x 120 pixels). Click it.
- **Toolbar popup:** *Download video from this page* sends the page in the active tab.
- **Right-click** the page, a video or a player: *Download video from this page with HyperFetch Pro* (on a link or a video file the normal *Download with HyperFetch Pro* is used).

The app comes to the front with the **Add dialog already open**: the page link is filled in, the video is looked up, and you choose the quality (or tick videos if the page is a playlist). Along with the link, the extension sends the browser's **cookies for that site**, including HttpOnly ones such as login sessions, so videos behind a login work. The app turns them into a private temporary cookie file for yt-dlp, uses it only for that lookup or download, and deletes it afterwards. Cookies are sent only to the app on this computer and only when you click one of these buttons.

The button can be switched off in the extension's options (*Show a download button over videos on web pages*), and the toolbar popup's *Take over downloads* switch turns off both file capture and the button. The button sits in a closed shadow root, so the page's own scripts cannot see or click it.

## Install

**With the installer:** leave *browser integration* ticked, then load `<install folder>\integration\extension` as an unpacked extension (step 3 below). Everything else is done for you.

**From source:**

1. Build the host bundles:
   ```powershell
   npm install
   npm run build --workspace @dm/native-host
   npm run build --workspace @dm/core-host
   ```
2. Register the native host (current user only, no admin; writes registry keys for Chrome, Edge and Brave and files under `%LOCALAPPDATA%\DownloadManager\native-host`):
   ```powershell
   .\scripts\install-native-host.ps1
   ```
   Remove with `.\scripts\install-native-host.ps1 -Uninstall`.
3. In the browser open `chrome://extensions` (or `edge://extensions`), enable **Developer mode**, choose **Load unpacked**, and select `apps\extension`.
4. Start the app. The extension popup should show **connected**.

The extension ID is fixed at `jlffphjfmognkklojjfjgmfggcfpbhjb` by the `key` in `manifest.json` (also stored in `apps/extension/extension-id.txt`); the native-host manifest allows only that origin.

## Settings (extension options page)

- File types to take over (space-separated extensions). Default covers archives, installers, disk images, audio, video, documents.
- Excluded sites, with `*` wildcards (for example `*.example.com`).
- Minimum size in bytes (0 = none). Applies only when the browser reports a size.
- A master on/off switch is in the toolbar popup.

## Security

- The native host is launched only for the allowed extension origin.
- The app endpoint is a per-user pipe or socket, and every request needs a random token that only the current user can read. Other users and web pages cannot reach it.
- The core accepts only `http`, `https` (and `ftp` for plain downloads) links.
- The extension holds broad permissions (`downloads`, `cookies`, `nativeMessaging`, all-sites access) because capturing logged-in downloads needs them. Review the code in `apps/extension` before loading it.

## What was verified

In Microsoft Edge 155 (throwaway profile, extension loaded unpacked, native host registered, local server): opening a direct file link made Edge start its own download; the extension paused it, the app accepted it and downloaded the whole file over 8 connections (60 MB, byte-for-byte correct), the request carried Edge's `Cookie` and `User-Agent`, and Edge left no partial or duplicate file in its Downloads folder. Chrome and Brave use the same extension API but were not tried.

**Fast downloads:** the extension can only react after the browser has created the download. If a small or fast file has already finished by then, the extension leaves the browser's copy alone instead of creating a duplicate. For larger files the pause happens mid-download and the app takes over.

### Verified for the video button

In Edge 155 with a throwaway profile and a test site that sets an `HttpOnly` login cookie and refuses the page and the video without it: the button was absent before hovering and appeared over the video after the pointer moved onto it; clicking it brought the app to the front with the Add dialog open, the link filled in, the video found ("Using your browser's login for this site") and, after *Download now*, the full 475,990-byte video downloaded. The site's log shows the login cookie on every request the app made. Not tried: real YouTube or Instagram pages in a browser (Instagram needs a real login, which I did not use), Chrome, Brave.

## Limitations

- Not distributed through browser stores (their policies restrict downloader extensions); installed unpacked.
- No Alt-key bypass, no automatic detection of streams (the button appears over any large `<video>`, and the app then finds out whether yt-dlp can use the page), no Firefox, no macOS manifest registration.
- Videos inside a closed shadow DOM or a cross-origin player the browser does not expose are not detected by the button; use the popup or the right-click entry on those pages.
- Chrome 137+ may ignore `--load-extension` for branded builds; load the extension from `chrome://extensions` instead (what the install steps describe).
- If a site hands out single-use or short-lived links, the app downloads with the browser's cookies and referrer but may still be refused.
