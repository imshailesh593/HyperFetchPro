import { describe, expect, it } from 'vitest';
import { MAIN_DOWNLOAD_QUEUE, MAIN_SYNC_QUEUE, Store } from '../src/index.js';

const fresh = () => new Store();

describe('Store', () => {
  it('seeds main queues and categories', () => {
    const s = fresh();
    expect(s.listQueues().map((q) => q.id)).toEqual([MAIN_DOWNLOAD_QUEUE, MAIN_SYNC_QUEUE]);
    expect(s.categoryForFilename('Movie.MP4')?.name).toBe('Video');
    expect(s.categoryForFilename('notes.xyz')).toBeUndefined();
  });

  it('round-trips downloads including headers', () => {
    const s = fresh();
    const d = s.addDownload({ url: 'http://x/a.zip', dir: '/tmp', filename: 'a.zip', headers: { Cookie: 'k=v' }, queueId: 1, status: 'queued' });
    expect(s.getDownload(d.id)).toMatchObject({ filename: 'a.zip', status: 'queued', headers: { Cookie: 'k=v' } });
    s.updateDownload(d.id, { status: 'completed', size: 10, completedAt: 5 });
    expect(s.getDownload(d.id)).toMatchObject({ status: 'completed', size: 10, completedAt: 5 });
    expect(() => s.updateDownload(d.id, { bogus: 1 } as never)).toThrow();
    expect(s.deleteDownload(d.id)).toBe(true);
  });

  it('nextQueued respects order, retry delay and status', () => {
    const s = fresh();
    const a = s.addDownload({ url: 'a', dir: '.', filename: 'a', queueId: 1, status: 'queued' });
    const b = s.addDownload({ url: 'b', dir: '.', filename: 'b', queueId: 1, status: 'queued' });
    s.addDownload({ url: 'c', dir: '.', filename: 'c', queueId: 1, status: 'paused' });
    expect(s.nextQueued(1, 0)?.id).toBe(a.id);
    s.updateDownload(a.id, { retryAt: 1000 });
    expect(s.nextQueued(1, 500)?.id).toBe(b.id);
    expect(s.nextQueued(1, 1000)?.id).toBe(a.id);
    s.moveToBack(a.id);
    expect(s.nextQueued(1, 1000)?.id).toBe(b.id);
  });

  it('manages queues, categories and settings', () => {
    const s = fresh();
    const q = s.addQueue({ name: 'Night', startTime: '02:00', stopTime: '06:00', maxParallel: 3 });
    expect(s.updateQueue(q.id, { days: 62 })?.days).toBe(62);
    const d = s.addDownload({ url: 'a', dir: '.', filename: 'a', queueId: q.id });
    expect(s.deleteQueue(q.id)).toBe(true);
    expect(s.getDownload(d.id)?.queueId).toBeNull();
    expect(() => s.deleteQueue(1)).toThrow();

    const c = s.addCategory({ name: 'Books', extensions: ['.MOBI', 'azw3'] });
    expect(c.extensions).toEqual(['mobi', 'azw3']);
    expect(s.categoryForFilename('x.mobi')?.name).toBe('Books');

    expect(s.getSetting('defaultDir')).toBeUndefined();
    s.setSetting('defaultDir', 'D:/dl');
    s.setSetting('defaultDir', 'E:/dl');
    expect(s.getSetting('defaultDir')).toBe('E:/dl');
  });
});
