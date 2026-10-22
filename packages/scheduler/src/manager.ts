import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Downloader, probe, sanitizeFilename, type DownloadOptions, type ProbeResult, type ProgressInfo } from '@dm/engine';
import type { DownloadRow, Store } from '@dm/store';

export interface DownloaderLike extends EventEmitter {
  start(): Promise<'completed' | 'paused'>;
  pause(): void;
  setSpeedLimit?(bytesPerSecond: number): void;
}

export interface ManagerOptions {
  /** Replaceable in tests. */
  factory?: (opts: DownloadOptions) => DownloaderLike;
  /** Replaceable in tests. */
  probeFn?: typeof probe;
  /** Extra engine options applied to every download (connections, speed limit...). */
  engine?: Partial<DownloadOptions>;
  /** Builds the yt-dlp runner for `kind: 'media'` rows. Throws if yt-dlp is unavailable. */
  mediaFactory?: (row: DownloadRow) => DownloaderLike;
  /** Minimum ms between progress writes to the database. */
  progressWriteMs?: number;
}

export interface AddInput {
  url: string;
  dir?: string;
  filename?: string;
  headers?: Record<string, string>;
  queueId?: number | null;
  categoryId?: number | null;
  /** Start right away instead of waiting for a queue. */
  start?: boolean;
  /** Skip the network probe (filename comes from the URL). */
  probe?: boolean;
}

export interface AddMediaInput {
  url: string;
  title: string;
  /** yt-dlp format selector. */
  format: string;
  ext: string;
  dir?: string;
  headers?: Record<string, string>;
  queueId?: number | null;
  start?: boolean;
}

export type Outcome = 'completed' | 'paused' | 'failed';

function nameFromUrl(url: string): string | null {
  try {
    const last = new URL(url).pathname.split('/').filter(Boolean).pop();
    return last ? decodeURIComponent(last) : null;
  } catch {
    return null;
  }
}

/**
 * Owns the engine instances. Keeps DB rows in sync with what each download is doing.
 * Events: 'changed' (DownloadRow), 'progress' (id, ProgressInfo), 'finished' (id, Outcome).
 */
export class DownloadManager extends EventEmitter {
  private running = new Map<number, DownloaderLike>();
  private lastWrite = new Map<number, number>();
  private globalLimit = 0;
  private engineStarted = new Set<number>();
  private pauseRequested = new Set<number>();
  private readonly factory: NonNullable<ManagerOptions['factory']>;
  private readonly probeFn: typeof probe;
  private readonly mediaFactory: NonNullable<ManagerOptions['mediaFactory']>;

  constructor(
    private readonly store: Store,
    private readonly options: ManagerOptions = {},
  ) {
    super();
    this.factory = options.factory ?? ((o) => new Downloader(o));
    this.probeFn = options.probeFn ?? probe;
    this.mediaFactory =
      options.mediaFactory ??
      (() => {
        throw new Error('Video downloads are not available');
      });
  }

  isRunning(id: number): boolean {
    return this.running.has(id);
  }

  /**
   * Total bytes/second across all downloads (0 = unlimited). It is split evenly between
   * running downloads and re-split whenever one starts or stops.
   */
  setGlobalSpeedLimit(bytesPerSecond: number): void {
    this.globalLimit = Math.max(0, bytesPerSecond);
    this.applyLimits();
  }

  /** Change the connection count used by downloads started from now on. */
  setMaxConnections(n: number): void {
    this.options.engine = { ...this.options.engine, maxConnections: Math.min(32, Math.max(1, Math.floor(n))) };
  }

  private applyLimits(): void {
    const share = this.globalLimit > 0 ? Math.max(1, Math.floor(this.globalLimit / Math.max(1, this.running.size))) : 0;
    for (const d of this.running.values()) d.setSpeedLimit?.(share);
  }

  get defaultDir(): string {
    return this.store.getSetting('defaultDir') ?? path.join(os.homedir(), 'Downloads');
  }

  async add(input: AddInput): Promise<DownloadRow> {
    let info: ProbeResult | null = null;
    if (input.probe !== false) info = await this.probeFn(input.url, input.headers).catch(() => null);

    const base = sanitizeFilename(input.filename ?? info?.filename ?? nameFromUrl(input.url) ?? 'download');
    const category =
      input.categoryId != null
        ? this.store.listCategories().find((c) => c.id === input.categoryId)
        : this.store.categoryForFilename(base);
    const dir = input.dir ?? category?.saveDir ?? (category ? path.join(this.defaultDir, category.name) : this.defaultDir);
    const filename = await this.uniqueName(dir, base);

    const queueId = input.queueId === undefined ? (input.start ? null : 1) : input.queueId;
    const row = this.store.addDownload({
      url: input.url,
      finalUrl: info?.finalUrl ?? null,
      dir,
      filename,
      size: info?.size ?? null,
      etag: info?.etag ?? null,
      lastModified: info?.lastModified ?? null,
      headers: input.headers,
      categoryId: category?.id ?? null,
      queueId,
      status: queueId != null ? 'queued' : 'paused',
    });
    this.emit('changed', row);
    if (input.start) this.start(row.id);
    return row;
  }

  async addMedia(input: AddMediaInput): Promise<DownloadRow> {
    const base = sanitizeFilename(`${input.title}.${input.ext}`);
    const category = this.store.categoryForFilename(base);
    const dir = input.dir ?? category?.saveDir ?? (category ? path.join(this.defaultDir, category.name) : this.defaultDir);
    const filename = await this.uniqueName(dir, base);
    const queueId = input.queueId === undefined ? (input.start ? null : 1) : input.queueId;
    const row = this.store.addDownload({
      url: input.url,
      dir,
      filename,
      headers: input.headers,
      categoryId: category?.id ?? null,
      queueId,
      status: queueId != null ? 'queued' : 'paused',
      kind: 'media',
      format: input.format,
    });
    this.emit('changed', row);
    if (input.start) this.start(row.id);
    return row;
  }

  /** Begins (or resumes) a download. Returns immediately; watch 'finished' for the result. */
  start(id: number): void {
    const row = this.store.getDownload(id);
    if (!row || this.running.has(id) || row.status === 'completed') return;
    const queue = row.queueId != null ? this.store.getQueue(row.queueId) : undefined;

    const dest = path.join(row.dir, row.filename);
    let downloader: DownloaderLike;
    try {
      downloader =
        row.kind === 'media'
          ? this.mediaFactory(row)
          : this.factory({ ...this.options.engine, url: row.url, dest, headers: row.headers });
    } catch (err) {
      this.update(id, { status: 'failed', error: err instanceof Error ? err.message : String(err), attempts: row.attempts + 1 });
      this.emit('finished', id, 'failed' as Outcome);
      return;
    }
    this.running.set(id, downloader);
    this.applyLimits();
    this.update(id, { status: 'running', error: null });

    downloader.on('probe', (p: ProbeResult) =>
      this.update(id, { finalUrl: p.finalUrl, size: p.size, etag: p.etag, lastModified: p.lastModified }),
    );
    downloader.on('filename', (name: string) => this.update(id, { filename: name }));
    downloader.on('progress', (p: ProgressInfo) => {
      if (row.kind === 'media' && p.size) this.store.updateDownload(id, { size: p.size });
      this.emit('progress', id, p);
      const now = Date.now();
      if (now - (this.lastWrite.get(id) ?? 0) >= (this.options.progressWriteMs ?? 1000)) {
        this.lastWrite.set(id, now);
        this.store.updateDownload(id, { downloaded: p.downloaded });
      }
    });

    void this.run(row, downloader, dest, queue?.kind === 'sync');
  }

  pause(id: number): void {
    const dl = this.running.get(id);
    if (!dl) return;
    // Before the engine has started there is nothing to abort yet; run() checks this flag instead.
    if (this.engineStarted.has(id)) dl.pause();
    else this.pauseRequested.add(id);
  }

  pauseAll(): void {
    for (const id of this.running.keys()) this.pause(id);
  }

  /** Pause everything and wait until every download has stopped; call before closing the store. */
  async shutdown(): Promise<void> {
    const ids = [...this.running.keys()];
    this.pauseAll();
    await Promise.all(ids.map((id) => this.waitUntilStopped(id)));
  }

  async remove(id: number, deleteFiles = false): Promise<void> {
    const row = this.store.getDownload(id);
    if (!row) return;
    const dl = this.running.get(id);
    if (dl) {
      dl.pause();
      await this.waitUntilStopped(id);
    }
    if (deleteFiles) {
      const dest = path.join(row.dir, row.filename);
      await Promise.all([dest, `${dest}.part`, `${dest}.part.json`].map((f) => fs.rm(f, { force: true })));
    }
    this.store.deleteDownload(id);
    this.emit('removed', id);
  }

  // --- internals -----------------------------------------------------------

  private async run(row: DownloadRow, downloader: DownloaderLike, dest: string, sync: boolean): Promise<void> {
    let outcome: Outcome;
    try {
      await fs.mkdir(row.dir, { recursive: true });
      if (this.pauseRequested.has(row.id)) {
        outcome = 'paused';
      } else if (sync && (await this.isUnchanged(row, dest))) {
        outcome = 'completed';
      } else if (this.pauseRequested.has(row.id)) {
        outcome = 'paused';
      } else {
        this.engineStarted.add(row.id);
        outcome = await downloader.start();
      }
      if (outcome === 'completed') {
        const cur = this.store.getDownload(row.id);
        const finalPath = cur ? path.join(cur.dir, cur.filename) : dest;
        // Media rows have no size from the server, so record what is on disk.
        const onDisk = await fs.stat(finalPath).then((s) => s.size).catch(() => null);
        const size = row.kind === 'media' ? (onDisk ?? cur?.size ?? null) : (cur?.size ?? row.size ?? onDisk);
        this.update(row.id, {
          status: 'completed',
          ...(row.kind === 'media' && size != null ? { size } : {}),
          downloaded: row.kind === 'media' ? (size ?? 0) : (this.store.getDownload(row.id)?.size ?? size ?? 0),
          completedAt: Date.now(),
          error: null,
        });
      } else {
        this.update(row.id, { status: 'paused' });
      }
    } catch (err) {
      outcome = 'failed';
      const current = this.store.getDownload(row.id);
      this.update(row.id, {
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
        attempts: (current?.attempts ?? 0) + 1,
      });
    }
    this.running.delete(row.id);
    this.applyLimits();
    this.lastWrite.delete(row.id);
    this.engineStarted.delete(row.id);
    this.pauseRequested.delete(row.id);
    this.emit('finished', row.id, outcome);
  }

  /** Sync queues skip files whose validators match what the server reports now. */
  private async isUnchanged(row: DownloadRow, dest: string): Promise<boolean> {
    if (!row.etag && !row.lastModified) return false;
    const exists = await fs.stat(dest).then(() => true).catch(() => false);
    if (!exists) return false;
    const info = await this.probeFn(row.url, row.headers).catch(() => null);
    return !!info && info.etag === row.etag && info.lastModified === row.lastModified;
  }

  private async uniqueName(dir: string, name: string): Promise<string> {
    const ext = path.extname(name);
    const stem = name.slice(0, name.length - ext.length);
    const taken = new Set(this.store.listDownloads().filter((d) => d.dir === dir).map((d) => d.filename.toLowerCase()));
    for (let i = 0; ; i++) {
      const candidate = i === 0 ? name : `${stem} (${i})${ext}`;
      if (taken.has(candidate.toLowerCase())) continue;
      const dest = path.join(dir, candidate);
      const used = await Promise.all([dest, `${dest}.part`].map((f) => fs.stat(f).then(() => true, () => false)));
      if (!used.some(Boolean)) return candidate;
    }
  }

  private update(id: number, patch: Partial<Omit<DownloadRow, 'id' | 'createdAt'>>): void {
    const row = this.store.updateDownload(id, patch);
    if (row) this.emit('changed', row);
  }

  private waitUntilStopped(id: number): Promise<void> {
    return new Promise((resolve) => {
      const check = (finishedId: number) => {
        if (finishedId !== id) return;
        this.off('finished', check);
        resolve();
      };
      this.on('finished', check);
      if (!this.running.has(id)) check(id);
    });
  }
}
