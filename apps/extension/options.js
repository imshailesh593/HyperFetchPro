const d = { extensions: '', excludedHosts: '', minSizeBytes: 0 };
const $ = (id) => document.getElementById(id);
chrome.storage.sync.get(d).then((v) => {
  $('ext').value = v.extensions || '';
  $('hosts').value = v.excludedHosts;
  $('min').value = v.minSizeBytes;
});
$('save').onclick = async () => {
  await chrome.storage.sync.set({ extensions: $('ext').value.trim(), excludedHosts: $('hosts').value.trim(), minSizeBytes: Number($('min').value) || 0 });
  $('msg').textContent = 'Saved';
  setTimeout(() => ($('msg').textContent = ''), 1500);
};
