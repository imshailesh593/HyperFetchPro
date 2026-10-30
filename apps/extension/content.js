// Shows a small "Download" button over videos on web pages. It only talks to the extension's background script,
// which sends the page address (never the video's contents) to the HyperFetch Pro app on this computer.
(() => {
  if (window.__hfpVideoButton) return;
  window.__hfpVideoButton = true;

  const MIN_W = 220;
  const MIN_H = 120;
  let enabled = true;
  let host = null;
  let button = null;
  let label = null;
  let current = null;
  let overButton = false;
  let hideTimer = 0;
  let flashTimer = 0;

  const refresh = (v) => (enabled = v.enabled !== false && v.showVideoButton !== false);
  chrome.storage.sync.get({ enabled: true, showVideoButton: true }).then(refresh).catch(() => {});
  chrome.storage.onChanged.addListener((changes) => {
    chrome.storage.sync.get({ enabled: true, showVideoButton: true }).then((v) => {
      refresh(v);
      if (!enabled) hide();
    });
  });

  function build() {
    host = document.createElement('div');
    host.setAttribute('data-hfp', '');
    host.style.cssText = 'all:initial;position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none;';
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `
      <style>
        button{all:initial;position:fixed;display:none;align-items:center;gap:6px;box-sizing:border-box;
          padding:6px 11px 6px 8px;border-radius:999px;cursor:pointer;pointer-events:auto;
          font:600 12px/1 system-ui,Segoe UI,sans-serif;color:#fff;background:rgba(15,17,26,.88);
          border:1px solid rgba(0,242,254,.55);box-shadow:0 2px 10px rgba(0,0,0,.45);user-select:none}
        button:hover{background:rgba(37,99,235,.95);border-color:#fff}
        svg{width:14px;height:14px;fill:none;stroke:#00f2fe;stroke-width:2.4;stroke-linecap:round;stroke-linejoin:round}
        button:hover svg{stroke:#fff}
      </style>
      <button type="button" part="b" aria-label="Download this video with HyperFetch Pro">
        <svg viewBox="0 0 24 24"><path d="M12 4v11M7 11l5 5 5-5M5 20h14"/></svg><span>Download</span>
      </button>`;
    button = root.querySelector('button');
    label = root.querySelector('span');
    button.addEventListener('mouseenter', () => ((overButton = true), clearTimeout(hideTimer)));
    button.addEventListener('mouseleave', () => ((overButton = false), scheduleHide()));
    button.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      await send();
    });
    (document.body || document.documentElement).appendChild(host);
  }

  async function send() {
    say('Sending…');
    let res;
    try {
      res = await chrome.runtime.sendMessage({ type: 'video-page' });
    } catch {
      res = { ok: false, error: 'extension-reloaded' };
    }
    if (res && res.ok) say('Sent to HyperFetch Pro');
    else if (res && res.error === 'app-not-running') say('Start HyperFetch Pro first');
    else say('Could not send');
  }

  function say(text) {
    label.textContent = text;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => label && (label.textContent = 'Download'), 2600);
  }

  function videoAt(x, y) {
    for (const el of document.elementsFromPoint(x, y)) if (el instanceof HTMLVideoElement) return el;
    return null;
  }

  function big(v) {
    const r = v.getBoundingClientRect();
    return r.width >= MIN_W && r.height >= MIN_H;
  }

  function place(v) {
    const r = v.getBoundingClientRect();
    const left = Math.max(6, Math.min(r.left + 10, window.innerWidth - 150));
    const top = Math.max(6, Math.min(r.top + 10, window.innerHeight - 40));
    button.style.left = left + 'px';
    button.style.top = top + 'px';
  }

  function show(v) {
    if (!host) build();
    current = v;
    place(v);
    button.style.display = 'inline-flex';
    clearTimeout(hideTimer);
  }

  function hide() {
    if (button) button.style.display = 'none';
    current = null;
  }

  function scheduleHide() {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => !overButton && hide(), 1400);
  }

  let last = 0;
  document.addEventListener(
    'mousemove',
    (e) => {
      if (!enabled) return;
      const now = Date.now();
      if (now - last < 80) return;
      last = now;
      const v = videoAt(e.clientX, e.clientY);
      if (v && big(v)) show(v);
      else if (!overButton && current) scheduleHide();
    },
    { passive: true, capture: true },
  );
  const follow = () => current && (big(current) && document.contains(current) ? place(current) : hide());
  window.addEventListener('scroll', follow, { passive: true, capture: true });
  window.addEventListener('resize', follow, { passive: true });
})();
