// Stand-in for yt-dlp: behaviour is chosen by the URL path (/ok, /slow, /fail) or -J.
import fs from 'node:fs';
const a = process.argv.slice(2);
const url = a[a.length - 1];
const kind = new URL(url).pathname.slice(1);
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
if (kind === 'fail') { console.error('ERROR: Video unavailable'); process.exit(1); }
const steps = kind === 'slow' ? 100 : 3;
for (let i = 1; i <= steps; i++) {
  console.log(`DMPROG:${i * 100}|${steps * 100}|NA|2048.5`);
  await new Promise((r) => setTimeout(r, kind === 'slow' ? 50 : 5));
}
fs.writeFileSync(out, 'video-bytes');
console.log('DMFILE:' + out);
