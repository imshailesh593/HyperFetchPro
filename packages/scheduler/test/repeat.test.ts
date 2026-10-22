import { EventEmitter } from 'node:events';
import { Store } from '@dm/store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DownloadManager, Scheduler, type DownloaderLike } from '../src/index.js';

let runs = 0;
class Instant extends EventEmitter implements DownloaderLike {
  async start(): Promise<'completed' | 'paused'> {
    runs++;
    await new Promise((r) => setTimeout(r, 2));
    return 'completed';
  }
  pause(): void {}
}

let store: Store;
let manager: DownloadManager;
let scheduler: Scheduler;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function setup(now?: () => Date) {
  scheduler?.dispose();
  scheduler = new Scheduler(store, manager, { repeatUnitMs: 30, now }); // one "repeat minute" = 30 ms
}

beforeEach(() => {
  runs = 0;
  store = new Store();
  store.setSetting('defaultDir', process.cwd());
  manager = new DownloadManager(store, {
    factory: () => new Instant(),
    probeFn: async () => {
      throw new Error('offline');
    },
  });
  setup();
  store.addDownload({ url: 'http://t/s', dir: process.cwd(), filename: 's.bin', queueId: 2, status: 'completed' });
});
afterEach(async () => {
  scheduler.dispose();
  await manager.shutdown();
  store.close();
});

describe('sync queue repeat', () => {
  it('runs again after the interval, and stopping ends the repetition', async () => {
    store.updateQueue(2, { repeatMinutes: 1 });
    scheduler.startQueue(2);
    await sleep(250);
    expect(runs).toBeGreaterThanOrEqual(3);

    scheduler.stopQueue(2);
    const after = runs;
    await sleep(150);
    expect(runs).toBe(after);
  });

  it('runs once when no interval is set', async () => {
    scheduler.startQueue(2);
    await sleep(200);
    expect(runs).toBe(1);
  });

  it('does not repeat a normal download queue', async () => {
    store.updateQueue(1, { repeatMinutes: 1 });
    store.addDownload({ url: 'http://t/d', dir: process.cwd(), filename: 'd.bin', queueId: 1, status: 'queued' });
    scheduler.startQueue(1);
    await sleep(200);
    expect(runs).toBe(1);
  });

  it('does not repeat once the stop time has passed', async () => {
    setup(() => new Date(2026, 0, 5, 10, 0, 0)); // 10:00
    store.updateQueue(2, { repeatMinutes: 1, stopTime: '09:00' });
    scheduler.startQueue(2);
    await sleep(200);
    expect(runs).toBe(1);
  });
});
