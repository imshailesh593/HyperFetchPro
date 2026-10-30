const on = document.getElementById('on');
const s = document.getElementById('s');
chrome.storage.sync.get({ enabled: true }).then((v) => (on.checked = v.enabled));
on.onchange = () => chrome.storage.sync.set({ enabled: on.checked });
document.getElementById('opts').onclick = () => chrome.runtime.openOptionsPage();
chrome.runtime.sendMessage('ping', (r) => {
  const ok = r && r.connected;
  s.textContent = ok ? 'connected' : r && r.error === 'app-not-running' ? 'not running' : 'not reachable';
  s.className = ok ? 'ok' : 'bad';
  if (ok) chrome.action.setBadgeText({ text: '' });
});

const video = document.getElementById('video');
const msg = document.getElementById('msg');
video.onclick = async () => {
  video.disabled = true;
  msg.textContent = 'Sending…';
  const r = await chrome.runtime.sendMessage({ type: 'video-page-active' });
  msg.textContent = r && r.ok ? 'Sent. Choose the quality in HyperFetch Pro.' : r && r.error === 'app-not-running' ? 'Start HyperFetch Pro first.' : 'Could not send this page.';
  video.disabled = false;
};
