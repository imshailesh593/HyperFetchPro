import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import { probe } from './probe.js';
import { Throttle } from './throttle.js';
import type {
  DownloadOptions,
  DownloadState,
  DownloadStatus,
  ProbeResult,
  ProgressInfo,
  Segment,
} from './types.js';

class FatalError extends Error {}

const DEFAULTS = {
  maxConnections: 8,
  minSplitSize: 256 * 1024,
  maxRetries: 5,
  stateFlushMs: 2000,
};

/**
 * Segmented HTTP(S) downloader. When a connection is free it splits the segment with
 * the most bytes left in half and gives the upper half to the new connection, so all
 * connections stay busy to the end. Positions are persisted so a download resumes after
 * a pause or crash.
 *
 * Events: 'progress' (ProgressInfo), 'status' (DownloadStatus), 'probe' (ProbeResult).
 */
export class Downloader extends EventEmitter {
  status: DownloadStatus = 'idle';

  private readonly opts: Required<Omit<DownloadOptions, 'headers' | 'speedLimit' | 'onBytes'>> &
    Pick<DownloadOptions, 'headers' | 'onBytes'>;
  private readonly throttle: Throttle;
  private segments: Segment[] = [];
  private active = new Set<Segment>();
  private info!: ProbeResult;
  private splittable = true;
  private controller = new AbortController();
  private handle: fs.FileHandle | null = null;
  private downloaded = 0;
  private samples: Array<[number, number]> = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private fatal: Error | null = null;
  private wake: (() => void) | null = null;

  constructor(options: DownloadOptions) {
    super();
    this.opts = {
      ...DEFAULTS,
      ignoreModificationTime: false,
      ...options,
      headers: options.headers,
    };
    this.throttle = new Throttle(options.speedLimit ?? 0);
  }

  get partPath(): string {
    return `${this.opts.dest}.part`;
  }
  get statePath(): string {
    return `${this.opts.dest}.part.json`;
  }

  setSpeedLimit(bytesPerSecond: number): void {
    this.throttle.setRate(bytesPerSecond);
  }

  /** Starts or resumes. Resolves 'completed' or 'paused'; rejects if the download fails. */
  async start(): Promise<'completed' | 'paused'> {
    if (this.status === 'running') throw new Error('Already running');
    this.controller = new AbortController();
    this.fatal = null;
    this.setStatus('running');
    try {
      await this.prepare();
      const outcome = await this.run();
      if (outcome === 'completed') {
        await this.finish();
        this.setStatus('completed');
      } else {
        await this.saveState();
        this.setStatus('paused');
      }
      return outcome;
    } catch (err) {
      await this.saveState().catch(() => undefined);
      if (this.controller.signal.aborted && !this.fatal) {
        // Paused while still probing/setting up: that is a pause, not a failure.
        this.setStatus('paused');
        return 'paused';
      }
      this.setStatus('failed');
      throw err;
    } finally {
      await this.handle?.close().catch(() => undefined);
      this.handle = null;
      if (this.flushTimer) clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }

  pause(): void {
    if (this.status === 'running') this.controller.abort();
  }

  // --- setup ---------------------------------------------------------------

  private async prepare(): Promise<void> {
    this.info = await probe(this.opts.url, this.opts.headers, this.controller.signal);
    this.emit('probe', this.info);
    const { size, acceptRanges } = this.info;
    this.splittable = acceptRanges && size !== null;

    const saved = await this.loadState();
    if (saved && (await this.canResume(saved))) {
      this.segments = saved.segments;
      this.downloaded = this.segments.reduce((n, s) => n + s.written, 0);
      this.handle = await fs.open(this.partPath, 'r+');
    } else {
      this.segments = [{ start: 0, end: size ?? Infinity, written: 0 }];
      this.downloaded = 0;
      this.handle = await fs.open(this.partPath, 'w');
      if (size !== null) await this.handle.truncate(size);
    }
    this.samples = [];
    this.flushTimer = setInterval(() => void this.saveState().catch(() => undefined), this.opts.stateFlushMs);
  }

  private async canResume(saved: DownloadState): Promise<boolean> {
    if (!this.splittable || saved.size !== this.info.size) return false;
    if (!this.opts.ignoreModificationTime) {
      if (saved.etag !== this.info.etag || saved.lastModified !== this.info.lastModified) return false;
    }
    try {
      return (await fs.stat(this.partPath)).size === saved.size;
    } catch {
      return false;
    }
  }

  private async loadState(): Promise<DownloadState | null> {
    try {
      const raw = JSON.parse(await fs.readFile(this.statePath, 'utf8')) as DownloadState;
      if (raw.url !== this.opts.url || !Array.isArray(raw.segments)) return null;
      return raw;
    } catch {
      return null;
    }
  }

  private async saveState(): Promise<void> {
    if (!this.info || !this.splittable) return;
    const state: DownloadState = {
      url: this.opts.url,
      finalUrl: this.info.finalUrl,
      size: this.info.size,
      etag: this.info.etag,
      lastModified: this.info.lastModified,
      segments: this.segments,
    };
    const tmp = `${this.statePath}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(state));
    await fs.rename(tmp, this.statePath);
  }

  // --- scheduling ----------------------------------------------------------

  private async run(): Promise<'completed' | 'paused'> {
    const max = this.splittable ? this.opts.maxConnections : 1;
    const workers = new Set<Promise<void>>();
    const progressTimer = setInterval(() => this.emitProgress(), 250);

    const launch = (seg: Segment): void => {
      this.active.add(seg);
      const p = this.runSegment(seg)
        .catch((err: Error) => {
          if (!this.controller.signal.aborted) {
            this.fatal ??= err;
            this.controller.abort();
          }
        })
        .finally(() => {
          this.active.delete(seg);
          workers.delete(p);
          this.wake?.();
        });
      workers.add(p);
    };

    try {
      for (;;) {
        if (!this.controller.signal.aborted) this.pump(max, launch);
        if (this.active.size === 0) break;
        await new Promise<void>((resolve) => {
          this.wake = resolve;
        });
      }
      await Promise.all(workers);
    } finally {
      clearInterval(progressTimer);
      this.emitProgress();
    }

    if (this.fatal) throw this.fatal;
    return this.segments.every((s) => s.start + s.written >= s.end) ? 'completed' : 'paused';
  }

  private pump(max: number, launch: (s: Segment) => void): void {
    while (this.active.size < max) {
      const idle = this.segments.find((s) => !this.active.has(s) && s.start + s.written < s.end);
      if (idle) {
        launch(idle);
        continue;
      }
      if (!this.splittable) return;

      let target: Segment | null = null;
      let targetLeft = 0;
      for (const s of this.active) {
        const left = s.end - (s.start + s.written);
        if (left >= 2 * this.opts.minSplitSize && left > targetLeft) {
          target = s;
          targetLeft = left;
        }
      }
      if (!target) return;

      const mid = target.start + target.written + Math.floor(targetLeft / 2);
      const upper: Segment = { start: mid, end: target.end, written: 0 };
      target.end = mid;
      this.segments.push(upper);
      this.segments.sort((a, b) => a.start - b.start);
      launch(upper);
    }
  }

  // --- one connection ------------------------------------------------------

  private async runSegment(seg: Segment): Promise<void> {
    let attempt = 0;
    for (;;) {
      if (seg.start + seg.written >= seg.end) return;
      try {
        await this.fetchSegment(seg);
        if (seg.start + seg.written >= seg.end) return;
        throw new Error('Connection closed before segment finished');
      } catch (err) {
        if (this.controller.signal.aborted || err instanceof FatalError) throw err;
        if (++attempt > this.opts.maxRetries) throw err;
        if (!this.splittable) {
          this.downloaded -= seg.written;
          seg.written = 0;
        }
        const retryAfter = (err as { retryAfterMs?: number }).retryAfterMs;
        await sleep(retryAfter ?? Math.min(500 * 2 ** (attempt - 1), 10_000), this.controller.signal);
      }
    }
  }

  private async fetchSegment(seg: Segment): Promise<void> {
    const pos = seg.start + seg.written;
    const headers: Record<string, string> = { ...this.opts.headers };
    if (this.splittable) {
      headers.Range = `bytes=${pos}-${seg.end - 1}`;
    }
    const res = await fetch(this.info.finalUrl, {
      headers,
      redirect: 'follow',
      signal: this.controller.signal,
    });

    if (res.status === 429 || res.status === 503) {
      await res.body?.cancel();
      const secs = Number(res.headers.get('retry-after'));
      throw Object.assign(new Error(`HTTP ${res.status}`), {
        retryAfterMs: Number.isFinite(secs) && secs > 0 ? Math.min(secs, 60) * 1000 : undefined,
      });
    }
    if (res.status >= 400 && res.status < 500) {
      await res.body?.cancel();
      throw new FatalError(`HTTP ${res.status}`);
    }
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    if (this.splittable && res.status !== 206) {
      await res.body.cancel();
      throw new FatalError('Server ignored the Range request');
    }

    const reader = res.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (this.controller.signal.aborted) break; // paused while this chunk was in flight: drop it, it is fetched again on resume
        let chunk = value;
        const room = seg.end - (seg.start + seg.written);
        if (room <= 0) break; // another connection took the rest of this segment
        if (chunk.length > room) chunk = chunk.subarray(0, room);
        await this.throttle.take(chunk.length, this.controller.signal);
        if (this.controller.signal.aborted) break;
        await this.handle!.write(chunk, 0, chunk.length, seg.start + seg.written);
        seg.written += chunk.length;
        this.downloaded += chunk.length;
        this.opts.onBytes?.(chunk.length);
        if (seg.start + seg.written >= seg.end) break;
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }

    if (seg.end === Infinity) seg.end = seg.start + seg.written; // stream ended: size is now known
  }

  // --- completion / reporting ----------------------------------------------

  private async finish(): Promise<void> {
    await this.handle?.sync().catch(() => undefined);
    await this.handle?.close();
    this.handle = null;
    await fs.rename(this.partPath, this.opts.dest);
    await fs.rm(this.statePath, { force: true });
  }

  private emitProgress(): void {
    const now = Date.now();
    this.samples.push([now, this.downloaded]);
    while (this.samples.length > 1 && now - this.samples[0][0] > 3000) this.samples.shift();
    const [t0, b0] = this.samples[0];
    const speed = now > t0 ? ((this.downloaded - b0) / (now - t0)) * 1000 : 0;
    const info: ProgressInfo = {
      downloaded: this.info?.size != null ? Math.min(this.downloaded, this.info.size) : this.downloaded,
      size: this.info?.size ?? null,
      speed,
      segments: this.segments.map((s) => ({ ...s })),
    };
    this.emit('progress', info);
  }

  private setStatus(status: DownloadStatus): void {
    this.status = status;
    this.emit('status', status);
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(done, ms);
    function done(): void {
      clearTimeout(t);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done);
  });
}
