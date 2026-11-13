// Builds the Firefox version of the extension from apps/extension: same scripts, Firefox-style manifest.
// Output: <out>/ (default dist/firefox-extension) and <out>.xpi next to it.
//   node scripts/build-firefox-extension.mjs [outDir]
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'apps', 'extension');
const out = path.resolve(process.argv[2] ?? path.join(root, 'dist', 'firefox-extension'));

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const f of ['background.js', 'content.js', 'popup.html', 'popup.js', 'options.html', 'options.js', 'icons']) {
  cpSync(path.join(src, f), path.join(out, f), { recursive: true });
}

const m = JSON.parse(readFileSync(path.join(src, 'manifest.json'), 'utf8'));
delete m.key; // Chrome's fixed-ID key
delete m.minimum_chrome_version;
m.background = { scripts: ['background.js'] }; // Firefox runs MV3 background code as an event page, not a service worker
m.options_ui = { page: m.options_page, open_in_tab: true };
delete m.options_page;
m.browser_specific_settings = {
  gecko: {
    id: readFileSync(path.join(src, 'firefox-id.txt'), 'utf8').trim(),
    strict_min_version: '140.0',
    // Cookies and page addresses go only to the HyperFetch Pro app on this computer, never to a server.
    data_collection_permissions: { required: ['none'] },
  },
};
writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(m, null, 2) + '\n');

// .xpi = a zip with manifest.json at the top level (tar.exe ships with Windows 10+ and writes zip with -a).
const xpi = out + '.xpi';
rmSync(xpi, { force: true });
const entries = readdirSync(out);
if (process.platform === 'win32') {
  // bsdtar writes a zip with --format zip (-a would not recognise the .xpi extension)
  execFileSync(path.join(process.env.SystemRoot ?? 'C:/Windows', 'System32', 'tar.exe'), ['--format', 'zip', '-c', '-f', xpi, '-C', out, ...entries]);
} else {
  execFileSync('zip', ['-qr', xpi, ...entries], { cwd: out });
}
console.log('Firefox extension: ' + out + '\n' + xpi);
