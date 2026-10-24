import path from 'node:path';
import type { Media } from '@dm/media';
import { DownloadManager, Scheduler } from '@dm/scheduler';
import { MAIN_DOWNLOAD_QUEUE, type DownloadRow, type Store } from '@dm/store';

/**
 * The host's API. Transport-agnostic: `emit` pushes events to the UI, `handle` answers requests.
 *
 * Events: download.changed {download}, download.progress {id, downloaded, size, speed, segments},
 * download.removed {id}, queue.changed {queueId, running}, queue.finished {queueId, afterAction}.
 */
export class Api {
  readonly manager: DownloadManager;
  readonly scheduler: Scheduler;
  private readonly media?: Media;

  constructor(
    private readonly store: Store,
    private readonly emit: (event: string, data: unknown) => void,
    deps: { manager?: DownloadManager; scheduler?: Scheduler; media?: Media } = {},
  ) {
    // A crash can leave rows marked running; nothing is running at startup.
    for (const d of store.listDownloads({ status: 'running' })) store.updateDownload(d.id, { status: 'paused' });

    this.media = deps.media;
    const media = deps.media;
    this.manager =
      deps.manager ??
      new DownloadManager(store, {
        mediaFactory: media
          ? (row) => {
              const stem = row.filename.replace(/\.[^.]+$/, '');
              return media.downloader({ url: row.url, dir: row.dir, stem, format: row.format ?? 'b', headers: row.headers });
            }
          : undefined,
      });
    this.scheduler = deps.scheduler ?? new Scheduler(store, this.manager);

    const limit = Number(store.getSetting('speedLimit') ?? 0);
    const conns = Number(store.getSetting('maxConnections') ?? 8);
    this.manager.setGlobalSpeedLimit(limit);
    this.manager.setMaxConnections(conns);
    this.applyQuota(Number(store.getSetting('quotaMb') ?? 0), Number(store.getSetting('quotaHours') ?? 1));
    this.manager.on('quota', (q: unknown) => emit('quota.changed', q));

    this.manager.on('changed', (download: DownloadRow) => emit('download.changed', { download }));
    this.manager.on('removed', (id: number) => emit('download.removed', { id }));
    this.manager.on('progress', (id: number, p: { downloaded: number; size: number | null; speed: number; segments: unknown }) =>
      emit('download.progress', { id, downloaded: p.downloaded, size: p.size, speed: p.speed, segments: p.segments }),
    );
    this.scheduler.on('queueStarted', (queueId: number) => emit('queue.changed', { queueId, running: true }));
    this.scheduler.on('queueStopped', (queueId: number) => emit('queue.changed', { queueId, running: false }));
    this.scheduler.on('queueFinished', (queueId: number, afterAction: string) => {
      emit('queue.changed', { queueId, running: false });
      emit('queue.finished', { queueId, afterAction });
    });
    this.scheduler.start();
  }

  private applyQuota(mb: number, hours: number): void {
    this.manager.setQuota(mb * 1024 * 1024, hours * 3_600_000);
  }

  private queues() {
    return this.store.listQueues().map((q) => ({ ...q, running: this.scheduler.isRunning(q.id) }));
  }

  private requireMedia(): Media {
    if (!this.media) throw new Error('Video downloads are not available');
    return this.media;
  }

  async shutdown(): Promise<void> {
    this.scheduler.dispose();
    await this.manager.shutdown();
  }

  async handle(method: string, p: Record<string, unknown> = {}): Promise<unknown> {
    const s = this.store;
    const num = (k: string): number => {
      const v = p[k];
      if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`Missing numeric parameter: ${k}`);
      return v;
    };
    const str = (k: string): string => {
      const v = p[k];
      if (typeof v !== 'string' || !v) throw new Error(`Missing string parameter: ${k}`);
      return v;
    };

    switch (method) {
      case 'state.snapshot':
        return {
          downloads: s.listDownloads(),
          queues: this.queues(),
          categories: s.listCategories(),
          settings: {
            defaultDir: this.manager.defaultDir,
            speedLimit: Number(s.getSetting('speedLimit') ?? 0),
            maxConnections: Number(s.getSetting('maxConnections') ?? 8),
            quotaMb: Number(s.getSetting('quotaMb') ?? 0),
            quotaHours: Number(s.getSetting('quotaHours') ?? 1),
          },
          quota: this.manager.quotaStatus(),
        };

      case 'download.add': {
        const url = str('url');
        if (!/^(https?|ftp):\/\//i.test(url)) throw new Error('Only http, https and ftp links are supported');
        const row = await this.manager.add({
          url,
          dir: typeof p.dir === 'string' && p.dir ? p.dir : undefined,
          filename: typeof p.filename === 'string' && p.filename ? p.filename : undefined,
          headers: (p.headers as Record<string, string> | undefined) ?? undefined,
          categoryId: typeof p.categoryId === 'number' ? p.categoryId : undefined,
          queueId: p.startNow ? null : typeof p.queueId === 'number' ? p.queueId : MAIN_DOWNLOAD_QUEUE,
          start: p.startNow === true,
        });
        return row;
      }

      case 'download.start': {
        const id = num('id');
        const row = s.getDownload(id);
        if (!row) throw new Error('No such download');
        // Starting by hand takes it out of any queue's control flow but keeps its place in it.
        this.manager.start(id);
        return {};
      }
      case 'download.pause':
        this.manager.pause(num('id'));
        return {};
      case 'download.remove':
        await this.manager.remove(num('id'), p.deleteFiles === true);
        return {};
      case 'downloads.pauseAll':
        this.manager.pauseAll();
        return {};
      case 'downloads.resumeAll':
        for (const d of s.listDownloads()) {
          if (d.status === 'paused' || d.status === 'failed' || d.status === 'queued') this.manager.start(d.id);
        }
        return {};

      case 'queue.start':
        this.scheduler.startQueue(num('id'));
        return {};
      case 'queue.stop':
        this.scheduler.stopQueue(num('id'));
        return {};
      case 'queue.list':
        return this.queues();
      case 'queue.add': {
        const q = s.addQueue({ name: str('name'), ...queueFields(p) });
        this.emit('queues.changed', {});
        return { ...q, running: false };
      }
      case 'queue.update': {
        const id = num('id');
        if (!s.getQueue(id)) throw new Error('No such queue');
        const q = s.updateQueue(id, p.name !== undefined ? { name: str('name'), ...queueFields(p) } : queueFields(p));
        this.emit('queues.changed', {});
        return { ...q, running: this.scheduler.isRunning(id) };
      }
      case 'queue.delete': {
        const id = num('id');
        this.scheduler.stopQueue(id);
        const ok = s.deleteQueue(id);
        this.emit('queues.changed', {});
        return { deleted: ok };
      }

      case 'category.list':
        return s.listCategories();
      case 'category.add': {
        const c = s.addCategory({ name: str('name'), extensions: extList(p.extensions), saveDir: folderOrNull(p.saveDir) });
        this.emit('categories.changed', {});
        return c;
      }
      case 'category.update': {
        const patch: { name?: string; extensions?: string[]; saveDir?: string | null } = {};
        if (p.name !== undefined) patch.name = str('name');
        if (p.extensions !== undefined) patch.extensions = extList(p.extensions);
        if (p.saveDir !== undefined) patch.saveDir = folderOrNull(p.saveDir);
        const c = s.updateCategory(num('id'), patch);
        if (!c) throw new Error('No such category');
        this.emit('categories.changed', {});
        return c;
      }
      case 'category.delete': {
        const ok = s.deleteCategory(num('id'));
        this.emit('categories.changed', {});
        return { deleted: ok };
      }

      case 'settings.set': {
        if (p.speedLimit !== undefined) {
          s.setSetting('speedLimit', String(num('speedLimit')));
          this.manager.setGlobalSpeedLimit(num('speedLimit'));
        }
        if (p.maxConnections !== undefined) {
          s.setSetting('maxConnections', String(num('maxConnections')));
          this.manager.setMaxConnections(num('maxConnections'));
        }
        if (p.quotaMb !== undefined || p.quotaHours !== undefined) {
          const mb = p.quotaMb !== undefined ? num('quotaMb') : Number(s.getSetting('quotaMb') ?? 0);
          const hours = p.quotaHours !== undefined ? num('quotaHours') : Number(s.getSetting('quotaHours') ?? 1);
          if (mb < 0 || mb > 10_000_000) throw new Error('The download limit must be between 0 and 10,000,000 MB (0 = off)');
          if (hours < 0.1 || hours > 720) throw new Error('The limit period must be between 0.1 and 720 hours');
          s.setSetting('quotaMb', String(mb));
          s.setSetting('quotaHours', String(hours));
          this.applyQuota(mb, hours);
          this.emit('quota.changed', this.manager.quotaStatus());
        }
        if (typeof p.defaultDir === 'string') {
          if (!path.isAbsolute(p.defaultDir)) throw new Error('The download folder must be a full path');
          s.setSetting('defaultDir', p.defaultDir);
        }
        return {};
      }

      case 'media.status':
        return this.requireMedia().status();
      case 'media.install':
        return this.requireMedia().install();
      case 'media.installFfmpeg':
        return this.requireMedia().installFfmpeg();
      case 'media.info':
        return this.requireMedia().info(webUrl(str('url')), p.headers as Record<string, string> | undefined);
      case 'media.add': {
        this.requireMedia();
        return this.manager.addMedia({
          url: webUrl(str('url')),
          title: str('title'),
          format: str('format'),
          ext: typeof p.ext === 'string' && p.ext ? p.ext : 'mp4',
          dir: typeof p.dir === 'string' && p.dir ? p.dir : undefined,
          headers: (p.headers as Record<string, string> | undefined) ?? undefined,
          queueId: p.startNow ? null : MAIN_DOWNLOAD_QUEUE,
          start: p.startNow === true,
        });
      }

      case 'media.addMany': {
        this.requireMedia();
        const items = Array.isArray(p.items) ? (p.items as Array<{ url?: unknown; title?: unknown }>) : [];
        if (items.length === 0) throw new Error('Choose at least one video');
        if (items.length > 500) throw new Error('At most 500 videos can be added at once');
        const format = str('format');
        const ext = typeof p.ext === 'string' && p.ext ? p.ext : 'mp4';
        const dir = typeof p.dir === 'string' && p.dir ? p.dir : undefined;
        const headers = (p.headers as Record<string, string> | undefined) ?? undefined;
        const ids: number[] = [];
        for (const it of items) {
          if (typeof it.url !== 'string' || typeof it.title !== 'string') throw new Error('Each video needs a url and a title');
          const row = await this.manager.addMedia({ url: webUrl(it.url), title: it.title, format, ext, dir, headers, queueId: MAIN_DOWNLOAD_QUEUE });
          ids.push(row.id);
        }
        if (p.startNow === true) this.scheduler.startQueue(MAIN_DOWNLOAD_QUEUE);
        return { added: ids.length, ids };
      }

      case 'ping':
        return { pong: true };

      default:
        throw new Error(`Unknown method: ${method}`);
    }
  }
}

function webUrl(url: string): string {
  if (!/^https?:\/\//i.test(url)) throw new Error('Only http and https links are supported');
  return url;
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Validates the optional queue fields shared by queue.add and queue.update. */
function queueFields(p: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  if (p.kind !== undefined) {
    if (p.kind !== 'download' && p.kind !== 'sync') throw new Error('Queue kind must be download or sync');
    out.kind = p.kind;
  }
  if (p.maxParallel !== undefined) {
    const n = Number(p.maxParallel);
    if (!Number.isInteger(n) || n < 1 || n > 10) throw new Error('Parallel downloads must be between 1 and 10');
    out.maxParallel = n;
  }
  for (const k of ['startTime', 'stopTime'] as const) {
    if (p[k] === undefined) continue;
    if (p[k] !== null && !(typeof p[k] === 'string' && TIME.test(p[k] as string))) throw new Error(`${k} must be HH:MM (24-hour) or null`);
    out[k] = p[k];
  }
  if (p.days !== undefined) {
    const d = Number(p.days);
    if (!Number.isInteger(d) || d < 0 || d > 127) throw new Error('days must be a number from 0 to 127');
    out.days = d;
  }
  if (p.repeatMinutes !== undefined) {
    if (p.repeatMinutes !== null) {
      const r = Number(p.repeatMinutes);
      if (!Number.isInteger(r) || r < 1 || r > 1440) throw new Error('Repeat interval must be between 1 and 1440 minutes, or empty');
      out.repeatMinutes = r;
    } else out.repeatMinutes = null;
  }
  if (p.afterAction !== undefined) {
    if (!['none', 'exit', 'shutdown'].includes(p.afterAction as string)) throw new Error('afterAction must be none, exit or shutdown');
    out.afterAction = p.afterAction;
  }
  return out;
}

function extList(v: unknown): string[] {
  const list = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[\s,]+/) : [];
  return list.filter((e): e is string => typeof e === 'string' && e.trim() !== '');
}

function folderOrNull(v: unknown): string | null {
  if (v === null || v === '' || v === undefined) return null;
  if (typeof v !== 'string' || !path.isAbsolute(v)) throw new Error('The folder must be a full path');
  return v;
}
