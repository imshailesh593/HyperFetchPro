const HOST = 'com.downloadmanager.host';

const DEFAULTS = {
  enabled: true,
  // Taken over when the file extension matches (like IDM's "file types" list).
  extensions:
    'zip rar 7z gz tar bz2 xz iso exe msi dmg pkg deb apk mp3 flac wav aac m4a mp4 mkv avi mov wmv webm m4v pdf doc docx xls xlsx ppt pptx',
  // Hosts never taken over; * matches anything, e.g. *.example.com
  excludedHosts: '',
  minSizeBytes: 0,
  // The small download button shown over videos on web pages.
  showVideoButton: true,
};

let nextId = 1;

async function settings() {
  return { ...DEFAULTS, ...(await chrome.storage.sync.get(DEFAULTS)) };
}

function hostMatches(host, patterns) {
  return patterns
    .split(/[\s,]+/)
    .filter(Boolean)
    .some((p) => new RegExp('^' + p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$', 'i').test(host));
}

function extensionOf(item) {
  const name = (item.filename || '').split(/[\\/]/).pop() || new URL(item.finalUrl || item.url).pathname.split('/').pop() || '';
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
}

function send(params, method = 'capture') {
  return new Promise((resolve) => {
    chrome.runtime.sendNativeMessage(HOST, { id: nextId++, method, params }, (res) => {
      if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
      else resolve(res || { ok: false, error: 'no-reply' });
    });
  });
}

async function cookieHeader(url) {
  try {
    const cookies = await chrome.cookies.getAll({ url });
    return cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  } catch {
    return '';
  }
}

async function hand(item, force = false) {
  const url = item.finalUrl || item.url;
  if (!/^https?:/i.test(url)) return false;
  const s = await settings();
  if (!force) {
    if (!s.enabled) return false;
    if (!s.extensions.split(/\s+/).includes(extensionOf(item))) return false;
    if (hostMatches(new URL(url).hostname, s.excludedHosts)) return false;
    if (s.minSizeBytes > 0 && item.fileSize > 0 && item.fileSize < s.minSizeBytes) return false;
  }
  // A small or fast download can finish before we get here. The browser already has the file, and
  // handing it over would only make a duplicate, so leave it alone.
  if (item.id >= 0 && (await isComplete(item.id))) return false;
  // Hold the browser download until the app has accepted it, so a failure never loses a download.
  await chrome.downloads.pause(item.id).catch(() => {});
  const res = await send({
    url,
    referrer: item.referrer || undefined,
    cookie: await cookieHeader(url),
    userAgent: navigator.userAgent,
  });
  if (res.ok) {
    await chrome.downloads.cancel(item.id).catch(() => {});
    await chrome.downloads.erase({ id: item.id }).catch(() => {});
    return true;
  }
  await chrome.downloads.resume(item.id).catch(() => {});
  await setBadge(res.error === 'app-not-running' ? 'off' : 'err');
  return false;
}

/**
 * Asks the app to offer the video on a web page (YouTube, Instagram, ...). The app opens its Add dialog with the
 * page link and the browser's cookies for that site, so logged-in content works, and the user picks the quality there.
 * Cookies are sent only to the app on this computer, and only when the user clicked a download button.
 */
async function sendVideoPage(url, referrer) {
  if (!/^https?:/i.test(url || '')) return { ok: false, error: 'not-a-web-page' };
  const res = await send({ url, referrer: referrer || undefined, cookie: await cookieHeader(url), userAgent: navigator.userAgent }, 'media');
  await setBadge(res.ok ? 'ok' : res.error === 'app-not-running' ? 'off' : 'err');
  return res;
}

async function isComplete(id) {
  const [cur] = await chrome.downloads.search({ id }).catch(() => []);
  return !!cur && cur.state === 'complete';
}

async function setBadge(kind) {
  await chrome.action.setBadgeText({ text: kind === 'ok' ? '' : kind === 'off' ? 'OFF' : '!' });
  await chrome.action.setBadgeBackgroundColor({ color: '#c0392b' });
}

chrome.downloads.onCreated.addListener((item) => {
  hand(item).catch(() => {});
});

// Right-click menus: a link or media file goes straight to the app; "from this page" lets the app find the video.
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'dm-link', title: 'Download with HyperFetch Pro', contexts: ['link', 'video', 'audio'] });
    chrome.contextMenus.create({ id: 'dm-page', title: 'Download video from this page with HyperFetch Pro', contexts: ['page'] });
  });
});
chrome.contextMenus.onClicked.addListener(async (info) => {
  if (info.menuItemId === 'dm-page') return void (await sendVideoPage(info.pageUrl));
  const url = info.linkUrl || info.srcUrl;
  // A player that streams from a blob: address has no file to fetch; let the app work from the page instead.
  if (url && /^https?:/i.test(url)) await hand({ id: -1, url, referrer: info.pageUrl }, true);
  else if (info.pageUrl) await sendVideoPage(info.pageUrl);
});

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (msg === 'ping') {
    send({}, 'ping').then((r) => respond({ connected: r.ok === true, error: r.error }));
    return true;
  }
  // From the button over a video: use the address of the frame that sent it, not anything the page could claim.
  if (msg && msg.type === 'video-page' && sender.url) {
    sendVideoPage(sender.url, sender.tab && sender.tab.url).then(respond);
    return true;
  }
  // From the toolbar popup: the page in the active tab.
  if (msg && msg.type === 'video-page-active') {
    chrome.tabs
      .query({ active: true, currentWindow: true })
      .then(([tab]) => (tab && tab.url ? sendVideoPage(tab.url) : { ok: false, error: 'no-page' }))
      .then(respond);
    return true;
  }
});
