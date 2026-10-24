import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { PLAYLIST_LIMIT, FILE_PREFIX, PLAN_PREFIX, PROGRESS_TEMPLATE, ProgressTracker, parsePlan, parseProgress } from './info.js';

export interface Launch {
  binary: string;
  /** Arguments placed before ours (used by tests to run a script through node). */
  prefix?: string[];
  ffmpeg?: string | null;
}

export interface MediaJob {
  url: string;
  dir: string;
  /** File name without extension; yt-dlp adds the real one. */
  stem: string;
  format: string;
  headers?: Record<string, string>;
}

const assertWeb = (url: string) => {
  if (!/^https?:\/\//i.test(url)) throw new Error('Only http and https links are supported');
};

/** Kills the whole process tree; yt-dlp.exe is a launcher that spawns the real worker. */
function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
  else child.kill('SIGTERM');
}

/** A watch link (with `v=`) or a youtu.be link means one video, even if it also names a playlist. */
function wantsSingleVideo(url: string): boolean {
  try {
    const u = new URL(url);
    return u.searchParams.has('v') || u.hostname === 'youtu.be';
  } catch {
    return false;
  }
}

export function infoArgs(url: string, headers?: Record<string, string>): string[] {
  assertWeb(url);
  // Playlists are listed flat (titles and links only) so reading them is fast.
  const scope = wantsSingleVideo(url) ? ['--no-playlist'] : ['--flat-playlist', '--playlist-end', String(PLAYLIST_LIMIT)];
  return ['-J', ...scope, '--no-warnings', ...headerArgs(headers), '--', url];
}

function headerArgs(headers?: Record<string, string>): string[] {
  return Object.entries(headers ?? {}).flatMap(([k, v]) => ['--add-header', `${k}:${v}`]);
}

export function runJson(launch: Launch, url: string, headers?: Record<string, string>, timeoutMs = 60_000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const args = [...(launch.prefix ?? []), ...infoArgs(url, headers)];
    const child = spawn(launch.binary, args, { windowsHide: true });
    let out = '';
    let err = '';
    const timer = setTimeout(() => (killTree(child), reject(new Error('Timed out reading video information'))), timeoutMs);
    child.stdout.setEncoding('utf8').on('data', (d: string) => (out += d));
    child.stderr.setEncoding('utf8').on('data', (d: string) => (err += d));
    child.on('error', (e) => (clearTimeout(timer), reject(e)));
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(lastError(err) || `yt-dlp exited with code ${code}`));
      try {
        resolve(JSON.parse(out));
      } catch {
        reject(new Error('Could not read video information'));
      }
    });
  });
}

function lastError(stderr: string): string {
  const lines = stderr.split('\n').map((l) => l.trim()).filter(Boolean);
  return (lines.reverse().find((l) => l.startsWith('ERROR:')) ?? lines[0] ?? '').replace(/^ERROR:\s*/, '');
}

/**
 * Runs one yt-dlp download. Shaped like the HTTP engine so the queue treats both the same:
 * start() resolves 'completed' | 'paused', pause() stops it, and 'progress' events are emitted.
 * Pausing keeps yt-dlp's partial files; the next start() continues from them.
 */
export class MediaDownloader extends EventEmitter {
  private child: ChildProcess | null = null;
  private pauseRequested = false;

  constructor(
    private readonly launch: Launch,
    private readonly job: MediaJob,
  ) {
    super();
    assertWeb(job.url);
  }

  pause(): void {
    this.pauseRequested = true;
    if (this.child) killTree(this.child);
  }

  start(): Promise<'completed' | 'paused'> {
    if (this.pauseRequested) return Promise.resolve('paused');
    const { job, launch } = this;
    const args = [
      ...(launch.prefix ?? []),
      '--no-playlist', '--newline', '--no-colors', '--no-warnings', '--no-simulate', '--progress', '--continue',
      '-f', job.format,
      '-o', path.join(job.dir, `${job.stem}.%(ext)s`),
      '--progress-template', PROGRESS_TEMPLATE,
      '--print', `before_dl:${PLAN_PREFIX}%(requested_formats)j`,
      '--print', `after_move:${FILE_PREFIX}%(filepath)s`,
      ...(launch.ffmpeg ? ['--ffmpeg-location', launch.ffmpeg, '--merge-output-format', 'mp4'] : []),
      ...headerArgs(job.headers),
      '--', job.url,
    ];

    return new Promise((resolve, reject) => {
      const child = spawn(launch.binary, args, { windowsHide: true });
      this.child = child;
      let file: string | null = null;
      const tracker = new ProgressTracker();
      let err = '';
      let buf = '';
      child.stdout.setEncoding('utf8').on('data', (d: string) => {
        buf += d;
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          const p = parseProgress(line);
          if (p) this.emit('progress', { ...tracker.update(p), segments: [] });
          else if (line.startsWith(PLAN_PREFIX)) tracker.plan = parsePlan(line);
          else if (line.startsWith(FILE_PREFIX)) file = line.slice(FILE_PREFIX.length);
        }
      });
      child.stderr.setEncoding('utf8').on('data', (d: string) => (err += d));
      child.on('error', reject);
      child.on('close', (code) => {
        this.child = null;
        if (this.pauseRequested) return resolve('paused');
        if (code !== 0) return reject(new Error(lastError(err) || `yt-dlp exited with code ${code}`));
        if (file) this.emit('filename', path.basename(file));
        resolve('completed');
      });
    });
  }
}
