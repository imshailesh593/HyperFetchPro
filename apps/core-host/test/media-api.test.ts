import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Media } from '@dm/media';
import { Store } from '@dm/store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Api } from '../src/api.js';

const fake = fileURLToPath(new URL('../../../packages/media/test/fake-ytdlp.mjs', import.meta.url));
let dir: string, store: Store, api: Api;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dm-mapi-'));
  store = new Store();
  store.setSetting('defaultDir', dir);
  api = new Api(store, () => undefined, { media: new Media(dir, { binary: process.execPath, prefix: [fake] }) });
});
afterEach(async () => {
  await api.shutdown();
  store.close();
  await fs.rm(dir, { recursive: true, force: true });
});

async function waitFor(c: () => boolean) {
  for (let i = 0; i < 300 && !c(); i++) await new Promise((r) => setTimeout(r, 20));
  expect(c()).toBe(true);
}

describe('media api with a fake yt-dlp', () => {
  it('reads info, downloads through the queue machinery and records the real file name', async () => {
    const info = (await api.handle('media.info', { url: 'https://site/ok' })) as any;
    expect(info.formats.length).toBeGreaterThan(1);
    const row = (await api.handle('media.add', { url: 'https://site/ok', title: 'My: Clip', format: '22', ext: 'mp4', startNow: true })) as any;
    expect(row).toMatchObject({ kind: 'media', format: '22', filename: 'My_ Clip.mp4' });
    await waitFor(() => store.getDownload(row.id)?.status === 'completed');
    expect(await fs.readFile(path.join(row.dir, 'My_ Clip.mp4'), 'utf8')).toBe('video-bytes');
    expect(store.getDownload(row.id)).toMatchObject({ size: 'video-bytes'.length, downloaded: 'video-bytes'.length });
  });

  it('marks a failed video download with yt-dlp\'s message', async () => {
    const row = (await api.handle('media.add', { url: 'https://site/fail', title: 'Gone', format: 'b', ext: 'mp4', startNow: true })) as any;
    await waitFor(() => store.getDownload(row.id)?.status === 'failed');
    expect(store.getDownload(row.id)?.error).toContain('Video unavailable');
  });

  it('rejects link schemes that are not http(s)', async () => {
    await expect(api.handle('media.add', { url: 'file:///x', title: 't', format: 'b' })).rejects.toThrow(/http and https/);
  });
});
