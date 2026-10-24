// Stand-in for yt-dlp: behaviour is chosen by the URL path (/ok, /slow, /fail) or -J.
import fs from 'node:fs';
const a = process.argv.slice(2);
const url = a[a.length - 1];
const kind = new URL(url).pathname.slice(1);
if (a.includes('-J') && kind === 'playlist') {
  if (!a.includes('--flat-playlist')) { console.error('ERROR: would process every video'); process.exit(1); }
  console.log(JSON.stringify({ _type: 'playlist', title: 'My list', uploader: 'Me', entries: [
    { id: 'a1', title: 'First', url: 'https://site/ok', ie_key: 'Generic', duration: 30 },
    { id: 'b2', title: 'Second', url: 'https://site/two', duration: 60 },
    { id: 'c3', title: '[Private video]', url: 'https://site/hidden' },
    { id: 'd4', title: 'Fourth', ie_key: 'Youtube' },
    null,
  ] }));
  process.exit(0);
}
if (a.includes('-J')) {
  if (kind === 'fail') { console.error('ERROR: [generic] Unsupported URL: ' + url); process.exit(1); }
  console.log(JSON.stringify({ title: 'My: Clip?', uploader: 'Me', duration: 12, webpage_url: url, formats: [
    { format_id: '18', ext: 'mp4', height: 360, vcodec: 'avc1', acodec: 'mp4a', filesize: 1000, protocol: 'https' },
    { format_id: '22', ext: 'mp4', height: 720, vcodec: 'avc1', acodec: 'mp4a', filesize: 5000, protocol: 'https' },
    { format_id: '137', ext: 'mp4', height: 1080, vcodec: 'avc1', acodec: 'none', filesize: 9000, protocol: 'https' },
    { format_id: '140', ext: 'm4a', vcodec: 'none', acodec: 'mp4a', filesize: 700, protocol: 'https' },
    { format_id: 'hls', ext: 'mp4', height: 480, vcodec: 'avc1', acodec: 'mp4a', protocol: 'm3u8_native' },
  ] }));
  process.exit(0);
}
const o = a[a.indexOf('-o') + 1];
const out = o.replace('%(ext)s', 'mp4');
// Like the real yt-dlp: --print makes it quiet, so progress only appears with --progress.
const showProgress = a.includes('--progress');
if (kind === 'fail') { console.error('ERROR: Video unavailable'); process.exit(1); }
if (kind === 'two') {
  // video stream (1000 bytes) then audio stream (500 bytes), like a merged download
  console.log('DMPLAN:' + JSON.stringify([{ filesize: 1000 }, { filesize_approx: 500 }]));
  for (const [id, total] of [['137', 1000], ['140', 500]]) {
    for (let d = total / 5; d <= total; d += total / 5) if (showProgress) console.log(`DMPROG:${d}|${total}|NA|100|${id}`);
  }
  fs.writeFileSync(out, 'video-bytes');
  console.log('DMFILE:' + out);
  process.exit(0);
}
const steps = kind === 'slow' ? 100 : 3;
for (let i = 1; i <= steps; i++) {
  if (showProgress) console.log(`DMPROG:${i * 100}|${steps * 100}|NA|2048.5`);
  await new Promise((r) => setTimeout(r, kind === 'slow' ? 50 : 5));
}
fs.writeFileSync(out, 'video-bytes');
console.log('DMFILE:' + out);
