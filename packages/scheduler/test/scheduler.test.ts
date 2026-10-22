import { createHash, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { DownloadOptions } from '@dm/engine';
import { Store } from '@dm/store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DownloadManager, Scheduler, type DownloaderLike } from '../src/index.js';

async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** URL path decides behaviour: /ok, /slow, /hang (until paused), /fail2 (fails twice), /fail (always). */
class FakeDownloader extends EventEmitter implements DownloaderLike {
  static failures = new Map<string, number>();
  static started: string[] = [];
  static active = 0;
  static maxActive = 0;
  private release: ((v: 'paused') => void) | null = null;

  constructor(private opts: DownloadOptions) {
    super();
  }

  async start(): Promise<'completed' | 'paused'> {
    const kind = new URL(this.opts.url).pathname.slice(1);
    FakeDownloader.started.push(this.opts.url);
    FakeDownloader.maxActive = Math.max(FakeDownloader.maxActive, ++FakeDownloader.active);
    try {
      if (kind === 'hang') return await new Promise<'paused'>((r) => (this.release = r));
      await new Promise((r) => setTimeout(r, kind === 'slow' ? 40 : 5));
      if (kind === 'fail') throw new Error('boom');
      if (kind === 'fail2') {
        const n = FakeDownloader.failures.get(this.opts.url) ?? 0;
        FakeDownloader.failures.set(this.opts.url, n + 1);
        if (n < 2) throw new Error('transient');
      }
      return 'completed';
    } finally {
      FakeDownloader.active--;
    }
  }
  pause(): void {
    this.release?.('paused');
  }
}

let store: Store;
let manager: DownloadManager;
let scheduler: Scheduler;
let dir: string;
const finished: Array<[number, string]> = [];
const queueFinished: number[] = [];

function setup(opts: { retryDelayMs?: number; maxQueueAttempts?: number; now?: () => Date } = {}) {
  store = new Store();
  store.setSetting('defaultDir', dir);
  manager = new DownloadManager(store, {
    factory: (o) => new FakeDownloader(o),
    probeFn: async () => {
      throw new Error('offline');
    },
  });
  scheduler = new Scheduler(store, manager, { retryDelayMs: 20, ...opts });
  manager.on('finished', (id, outcome) => finished.push([id, outcome]));
  scheduler.on('queueFinished', (q) => queueFinished.push(q));
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dm-sched-'));
  finished.length = 0;
  queueFinished.length = 0;
  Object.assign(FakeDownloader, { failures: new Map(), started: [], active: 0, maxActive: 0 });
  setup();
});

afterEach(async () => {
  scheduler.dispose();
  await manager.shutdown();
  store.close();
  await fs.rm(dir, { recursive: true, force: true });
});

const add = (p: string) => manager.add({ url: `http://t/${p}`, filename: `${p}.bin`, probe: false });

describe('DownloadManager.add', () => {
  it('picks category folder and avoids filename collisions', async () => {
    const a = await manager.add({ url: 'http://t/x.mp4', probe: false });
    const b = await manager.add({ url: 'http://t/x.mp4', probe: false });
    expect(a.dir).toBe(path.join(dir, 'Video'));
    expect([a.filename, b.filename]).toEqual(['x.mp4', 'x (1).mp4']);
    expect(a.status).toBe('queued');
    expect(a.queueId).toBe(1);
  });

  it('avoids names that exist on disk', async () => {
    await fs.mkdir(path.join(dir, 'Documents'), { recursive: true });
    await fs.writeFile(path.join(dir, 'Documents', 'a.pdf'), 'x');
    expect((await manager.add({ url: 'http://t/a.pdf', probe: false })).filename).toBe('a (1).pdf');
  });
});

describe('Scheduler queues', () => {
  it('runs a queue to completion within maxParallel and leaves the queue', async () => {
    store.updateQueue(1, { maxParallel: 2 });
    const rows = [await add('slow'), await add('slow'), await add('slow'), await add('ok')];
    scheduler.startQueue(1);
    await waitFor(() => queueFinished.length === 1);
    expect(FakeDownloader.maxActive).toBe(2);
    for (const r of rows) expect(store.getDownload(r.id)).toMatchObject({ status: 'completed', queueId: null });
    expect(scheduler.isRunning(1)).toBe(false);
  });

  it('retries failed downloads later and moves them to the back', async () => {
    const flaky = await add('fail2');
    const fine = await add('ok');
    scheduler.startQueue(1);
    await waitFor(() => queueFinished.length === 1);
    expect(store.getDownload(flaky.id)?.status).toBe('completed');
    expect(store.getDownload(fine.id)?.status).toBe('completed');
    // flaky started first, failed, then 'ok' ran before its retry
    expect(FakeDownloader.started.map((u) => u.split('/').pop())).toEqual(['fail2', 'ok', 'fail2', 'fail2']);
  });

  it('gives up after maxQueueAttempts', async () => {
    scheduler.dispose();
    setup({ maxQueueAttempts: 3 });
    const bad = await add('fail');
    scheduler.startQueue(1);
    await waitFor(() => queueFinished.length === 1);
    expect(store.getDownload(bad.id)).toMatchObject({ status: 'failed', attempts: 3, error: 'boom' });
    expect(FakeDownloader.started).toHaveLength(3);
  });

  it('stopQueue pauses running items and startQueue resumes them', async () => {
    const h = await add('hang');
    scheduler.startQueue(1);
    await waitFor(() => FakeDownloader.started.length === 1); // engine is really running
    scheduler.stopQueue(1);
    await waitFor(() => store.getDownload(h.id)?.status === 'paused');
    expect(scheduler.isRunning(1)).toBe(false);

    scheduler.startQueue(1);
    await waitFor(() => FakeDownloader.started.length === 2);
    expect(store.getDownload(h.id)?.status).toBe('running');
    scheduler.stopQueue(1);
  });

  it('a stop that arrives before the engine starts still pauses the download', async () => {
    const h = await add('hang');
    scheduler.startQueue(1);
    scheduler.stopQueue(1); // immediately: engine not started yet
    await waitFor(() => store.getDownload(h.id)?.status === 'paused');
    expect(FakeDownloader.started).toHaveLength(0);
    expect(manager.isRunning(h.id)).toBe(false);
  });

  it('syncs: re-checks completed items every run and keeps them in the queue', async () => {
    const row = store.addDownload({ url: 'http://t/ok', dir, filename: 'ok.bin', queueId: 2, status: 'completed' });
    scheduler.startQueue(2);
    await waitFor(() => queueFinished.length === 1);
    expect(FakeDownloader.started).toHaveLength(1);
    expect(store.getDownload(row.id)).toMatchObject({ status: 'completed', queueId: 2 });
  });
});

describe('Scheduler timing', () => {
  it('starts and stops at scheduled times, once per minute, on selected days', async () => {
    scheduler.dispose();
    let current = new Date(2026, 0, 5, 1, 59, 0); // Monday
    setup({ now: () => current });
    store.updateQueue(1, { startTime: '02:00', stopTime: '03:00', days: 1 << 1 }); // Mondays only
    const h = await add('hang');

    scheduler.tick();
    expect(scheduler.isRunning(1)).toBe(false);

    current = new Date(2026, 0, 5, 2, 0, 5);
    scheduler.tick();
    expect(scheduler.isRunning(1)).toBe(true);
    await waitFor(() => store.getDownload(h.id)?.status === 'running');

    scheduler.stopQueue(1); // manual stop inside the same minute...
    scheduler.tick(); // ...must not restart it
    expect(scheduler.isRunning(1)).toBe(false);

    current = new Date(2026, 0, 5, 3, 0, 0);
    scheduler.tick();
    expect(scheduler.isRunning(1)).toBe(false);

    current = new Date(2026, 0, 6, 2, 0, 0); // Tuesday: not scheduled
    scheduler.tick();
    expect(scheduler.isRunning(1)).toBe(false);
  });
});

describe('end to end with the real engine', () => {
  it('downloads queued files over HTTP', async () => {
    const data = randomBytes(1024 * 1024);
    const server = http.createServer((req, res) => {
      if (req.method === 'HEAD') {
        res.setHeader('Content-Length', data.length).setHeader('Accept-Ranges', 'bytes').end();
        return;
      }
      const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? '');
      const start = m ? Number(m[1]) : 0;
      const end = m && m[2] ? Number(m[2]) : data.length - 1;
      if (m) res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${data.length}`, 'Accept-Ranges': 'bytes' });
      res.end(data.subarray(start, end + 1));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/pack.zip`;

    const real = new DownloadManager(store);
    const s = new Scheduler(store, real);
    const row = await real.add({ url });
    expect(row).toMatchObject({ filename: 'pack.zip', size: data.length });
    s.startQueue(1);
    await waitFor(() => store.getDownload(row.id)?.status === 'completed', 8000);
    const out = await fs.readFile(path.join(row.dir, row.filename));
    expect(createHash('sha256').update(out).digest('hex')).toBe(createHash('sha256').update(data).digest('hex'));
    s.dispose();
    server.close();
  });
});
