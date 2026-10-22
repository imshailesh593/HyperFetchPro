import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const BASE = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download';

export function ytDlpAsset(platform = process.platform): string {
  return platform === 'win32' ? 'yt-dlp.exe' : platform === 'darwin' ? 'yt-dlp_macos' : 'yt-dlp_linux';
}

const exe = (name: string) => (process.platform === 'win32' ? `${name}.exe` : name);

/** Looks next to the app's data (`<dataDir>/bin`), then on PATH. An env var overrides both. */
export function findTool(name: 'yt-dlp' | 'ffmpeg', dataDir: string): string | null {
  const override = process.env[name === 'yt-dlp' ? 'DM_YTDLP' : 'DM_FFMPEG'];
  if (override && existsSync(override)) return override;
  const local = path.join(dataDir, 'bin', name === 'yt-dlp' ? ytDlpAsset() : exe('ffmpeg'));
  if (existsSync(local)) return local;
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    const p = path.join(dir, exe(name));
    if (dir && existsSync(p)) return p;
  }
  return null;
}

export async function toolVersion(binary: string): Promise<string | null> {
  try {
    const { stdout } = await run(binary, ['--version'], { timeout: 20_000, windowsHide: true });
    return stdout.trim().split('\n')[0] || null;
  } catch {
    return null;
  }
}

/**
 * Installs the latest yt-dlp into `<dataDir>/bin`. The download is checked against the
 * SHA2-256SUMS file published with the release and swapped in atomically, so a bad or
 * interrupted download never replaces a working copy. Only github.com/yt-dlp URLs are used.
 */
export async function installYtDlp(dataDir: string, fetchFn: typeof fetch = fetch): Promise<{ path: string; sha256: string }> {
  const asset = ytDlpAsset();
  const sums = await fetchFn(`${BASE}/SHA2-256SUMS`);
  if (!sums.ok) throw new Error(`Could not fetch checksums (HTTP ${sums.status})`);
  const expected = (await sums.text())
    .split('\n')
    .map((l) => l.trim().split(/\s+/))
    .find(([, name]) => name === asset)?.[0];
  if (!expected) throw new Error(`No checksum published for ${asset}`);

  const res = await fetchFn(`${BASE}/${asset}`);
  if (!res.ok) throw new Error(`Could not download ${asset} (HTTP ${res.status})`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== expected.toLowerCase()) throw new Error('Checksum mismatch; the download was discarded');

  const dir = path.join(dataDir, 'bin');
  mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, asset);
  const tmp = `${dest}.new`;
  writeFileSync(tmp, bytes);
  if (process.platform !== 'win32') chmodSync(tmp, 0o755);
  try {
    renameSync(tmp, dest);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw new Error(`Could not replace yt-dlp (is a download using it?): ${(e as Error).message}`);
  }
  return { path: dest, sha256: actual };
}

const FFMPEG_BASE = 'https://github.com/yt-dlp/FFmpeg-Builds/releases/latest/download';

/**
 * Installs ffmpeg (needed to merge video and audio streams) from yt-dlp's own FFmpeg-Builds
 * releases, verified against the published checksums. Windows only for now; on macOS install
 * ffmpeg separately (for example with Homebrew) and it will be found on PATH.
 */
export async function installFfmpeg(dataDir: string, fetchFn: typeof fetch = fetch): Promise<{ path: string; sha256: string }> {
  if (process.platform !== 'win32') throw new Error('Automatic ffmpeg install is Windows-only; install ffmpeg yourself (for example: brew install ffmpeg).');
  const asset = process.arch === 'arm64' ? 'ffmpeg-master-latest-winarm64-gpl.zip' : 'ffmpeg-master-latest-win64-gpl.zip';
  const sums = await fetchFn(`${FFMPEG_BASE}/checksums.sha256`);
  if (!sums.ok) throw new Error(`Could not fetch ffmpeg checksums (HTTP ${sums.status})`);
  const expected = (await sums.text())
    .split('\n')
    .map((l) => l.trim().split(/\s+/))
    .find(([, name]) => name?.replace(/^\*/, '') === asset)?.[0];
  if (!expected) throw new Error(`No checksum published for ${asset}`);

  const res = await fetchFn(`${FFMPEG_BASE}/${asset}`);
  if (!res.ok) throw new Error(`Could not download ffmpeg (HTTP ${res.status})`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== expected.toLowerCase()) throw new Error('ffmpeg checksum mismatch; the download was discarded');

  const work = mkdtempSync(path.join(tmpdir(), 'dm-ffmpeg-'));
  try {
    const zip = path.join(work, asset);
    writeFileSync(zip, bytes);
    // bsdtar ships with Windows 10+ and reads zip files; only the one binary is extracted.
    const member = (await run('tar', ['-tf', zip], { maxBuffer: 64 * 1024 * 1024, windowsHide: true })).stdout
      .split(/\r?\n/)
      .find((l) => /(^|\/)bin\/ffmpeg\.exe$/.test(l));
    if (!member) throw new Error('ffmpeg.exe was not found in the archive');
    await run('tar', ['-xf', zip, '-C', work, member], { windowsHide: true });

    const dir = path.join(dataDir, 'bin');
    mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, 'ffmpeg.exe');
    const tmp = `${dest}.new`;
    copyFileSync(path.join(work, member), tmp);
    renameSync(tmp, dest);
    return { path: dest, sha256: actual };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
