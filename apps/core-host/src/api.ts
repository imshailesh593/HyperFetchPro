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
          queues: s.listQueues().map((q) => ({ ...q, running: this.scheduler.isRunning(q.id) })),
          categories: s.listCategories(),
          settings: {
            defaultDir: this.manager.defaultDir,
            speedLimit: Number(s.getSetting('speedLimit') ?? 0),
            maxConnections: Number(s.getSetting('maxConnections') ?? 8),
          },
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
      case 'queue.update': {
        const { id, ...patch } = p as { id: number } & Record<string, never>;
        return s.updateQueue(Number(id), patch) ?? null;
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
