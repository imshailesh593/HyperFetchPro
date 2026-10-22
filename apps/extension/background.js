const HOST = 'com.downloadmanager.host';

const DEFAULTS = {
  enabled: true,
  // Taken over when the file extension matches (like IDM's "file types" list).
  extensions:
    'zip rar 7z gz tar bz2 xz iso exe msi dmg pkg deb apk mp3 flac wav aac m4a mp4 mkv avi mov wmv webm m4v pdf doc docx xls xlsx ppt pptx',
  // Hosts never taken over; * matches anything, e.g. *.example.com
  excludedHosts: '',
  minSizeBytes: 0,
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

async function setBadge(kind) {
  await chrome.action.setBadgeText({ text: kind === 'ok' ? '' : kind === 'off' ? 'OFF' : '!' });
  await chrome.action.setBadgeBackgroundColor({ color: '#c0392b' });
}

chrome.downloads.onCreated.addListener((item) => {
  hand(item).catch(() => {});
});

// Right-click any link or media element: "Download with Download Manager".
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus?.create?.({ id: 'dm-link', title: 'Download with Download Manager', contexts: ['link', 'video', 'audio'] });
});
chrome.contextMenus?.onClicked.addListener(async (info) => {
  const url = info.linkUrl || info.srcUrl;
  if (url) await hand({ id: -1, url, referrer: info.pageUrl }, true);
});

chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  if (msg === 'ping') {
    send({}, 'ping').then((r) => respond({ connected: r.ok === true, error: r.error }));
    return true;
  }
});
