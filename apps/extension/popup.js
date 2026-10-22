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
