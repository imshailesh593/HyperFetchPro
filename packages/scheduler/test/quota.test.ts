import { EventEmitter } from 'node:events';
import { Store } from '@dm/store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DownloadManager, Scheduler, type DownloaderLike } from '../src/index.js';

const TOTAL = 4000;
const TICK = 400; // bytes per 20 ms
const progressByUrl = new Map<string, number>();

/** Reports progress and, like the real engine, continues from where it stopped after a pause. */
class Ticker extends EventEmitter implements DownloaderLike {
  private paused = false;
  constructor(private url: string) {
    super();
  }
  async start(): Promise<'completed' | 'paused'> {
    let done = progressByUrl.get(this.url) ?? 0;
    this.emit('progress', { downloaded: done, size: TOTAL, speed: 0, segments: [] }); // baseline
    while (done < TOTAL) {
      await new Promise((r) => setTimeout(r, 20));
      if (this.paused) return 'paused';
      done = Math.min(TOTAL, done + TICK);
      progressByUrl.set(this.url, done);
      this.emit('progress', { downloaded: done, size: TOTAL, speed: 0, segments: [] });
    }
    return 'completed';
  }
  pause(): void {
    this.paused = true;
  }
}

let store: Store;
let manager: DownloadManager;
const quotaEvents: Array<{ blocked: boolean; resumeAt: number | null }> = [];

async function waitFor(cond: () => boolean, ms = 4000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

const make = () => {
  manager = new DownloadManager(store, {
    factory: (o) => new Ticker(o.url),
    probeFn: async () => {
      throw new Error('offline');
    },
    progressWriteMs: 10,
  });
  manager.on('quota', (q) => quotaEvents.push(q));
};

beforeEach(() => {
  progressByUrl.clear();
  quotaEvents.length = 0;
  store = new Store();
  store.setSetting('defaultDir', process.cwd());
  make();
});
afterEach(async () => {
  await manager.shutdown();
  store.close();
});

const add = (name: string, start = false) => manager.add({ url: `http://t/${name}`, filename: `${name}.bin`, probe: false, start });

describe('download quota', () => {
  it('pauses when the limit is reached and resumes itself after the window', async () => {
    manager.setQuota(1000, 300);
    const row = await add('a', true);

    await waitFor(() => quotaEvents.some((e) => e.blocked));
    const blocked = quotaEvents.find((e) => e.blocked)!;
    expect(blocked.resumeAt).toBeGreaterThan(Date.now() - 50);
    await waitFor(() => store.getDownload(row.id)?.status === 'paused');
    const heldAt = progressByUrl.get('http://t/a')!;
    expect(store.getDownload(row.id)?.downloaded).toBeGreaterThanOrEqual(heldAt - TICK); // progress was saved when it paused
    expect(heldAt).toBeLessThan(TOTAL);
    expect(manager.quotaBlocked).toBe(true);

    // nothing moves while blocked
    await new Promise((r) => setTimeout(r, 100));
    expect(progressByUrl.get('http://t/a')).toBe(heldAt);

    // after the window it continues from where it stopped (not from zero) and finishes
    await waitFor(() => store.getDownload(row.id)?.status === 'completed', 6000);
    expect(quotaEvents.filter((e) => e.blocked).length).toBeGreaterThanOrEqual(2); // several windows were needed
    expect(manager.quotaBlocked).toBe(false);
  });

  it('keeps each window within the limit plus one tick of overshoot', async () => {
    manager.setQuota(1000, 300);
    const row = await add('b', true);
    const seen: number[] = [];
    manager.on('quota', () => seen.push(manager.quotaStatus().used));
    await waitFor(() => store.getDownload(row.id)?.status === 'completed', 6000);
    for (const used of seen) expect(used).toBeLessThanOrEqual(1000 + TICK);
  });

  it('holds a download started during the block and runs it when the window ends', async () => {
    manager.setQuota(1000, 300);
    const first = await add('c1', true);
    await waitFor(() => manager.quotaBlocked);
    const second = await add('c2', true);
    expect(store.getDownload(second.id)).toMatchObject({ status: 'queued', error: 'Waiting for the download limit to reset' });
    await waitFor(() => store.getDownload(second.id)?.status === 'completed' && store.getDownload(first.id)?.status === 'completed', 9000);
  });

  it('turning the quota off releases held downloads immediately', async () => {
    manager.setQuota(1000, 60_000);
    const row = await add('d', true);
    await waitFor(() => manager.quotaBlocked);
    manager.setQuota(0, 0);
    expect(manager.quotaBlocked).toBe(false);
    await waitFor(() => store.getDownload(row.id)?.status === 'completed');
  });

  it('remembers usage across a restart', async () => {
    manager.setQuota(1000, 60_000);
    const row = await add('e', true);
    await waitFor(() => manager.quotaBlocked);
    await manager.shutdown();
    expect(Number(store.getSetting('quotaUsed'))).toBeGreaterThanOrEqual(1000);

    make(); // a new manager over the same database
    manager.setQuota(1000, 60_000);
    expect(manager.quotaStatus().used).toBeGreaterThanOrEqual(1000);
    expect(manager.quotaBlocked).toBe(true); // the spent allowance still counts after a restart
    manager.start(row.id);
    expect(store.getDownload(row.id)).toMatchObject({ status: 'queued', error: 'Waiting for the download limit to reset' });
  });

  it('keeps queues from starting new items while blocked', async () => {
    manager.setQuota(1000, 400);
    const scheduler = new Scheduler(store, manager, { retryDelayMs: 20 });
    store.updateQueue(1, { maxParallel: 1 });
    const rows = [await add('q1'), await add('q2')];
    const finished: number[] = [];
    scheduler.on('queueFinished', (q) => finished.push(q));
    scheduler.startQueue(1);
    await waitFor(() => finished.length === 1, 12_000);
    for (const r of rows) expect(store.getDownload(r.id)?.status).toBe('completed');
    scheduler.dispose();
  });
});
