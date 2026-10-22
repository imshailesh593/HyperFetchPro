import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Media, parseProgress, safeTitle, simplify, infoArgs } from '../src/index.js';

const fake = fileURLToPath(new URL('./fake-ytdlp.mjs', import.meta.url));
const launch = { binary: process.execPath, prefix: [fake], ffmpeg: null as string | null };
let dir: string;
beforeEach(async () => (dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dm-media-'))));
afterEach(() => fs.rm(dir, { recursive: true, force: true }));

describe('parsing', () => {
  it('parses progress lines and tolerates NA', () => {
    expect(parseProgress('DMPROG:100|400|NA|50.5')).toEqual({ downloaded: 100, size: 400, speed: 50.5 });
    expect(parseProgress('DMPROG:100|NA|900|NA')).toEqual({ downloaded: 100, size: 900, speed: 0 });
    expect(parseProgress('[download] 5%')).toBeNull();
  });
  it('cleans titles for filenames', () => expect(safeTitle('My: Clip?/x')).toBe('My_ Clip__x'));
  it('only accepts http(s) links, and puts the URL after --', () => {
    expect(() => infoArgs('file:///c:/x')).toThrow();
    expect(() => infoArgs('--exec=calc')).toThrow();
    expect(infoArgs('https://a/b').slice(-2)).toEqual(['--', 'https://a/b']);
  });
});

describe('Media', () => {
  it('lists single-file qualities without ffmpeg (no streaming or video-only formats)', async () => {
    const info = await new Media(dir, launch).info('https://x/ok');
    expect(info.title).toBe('My: Clip?');
    expect(info.canMerge).toBe(false);
    expect(info.formats.map((f) => f.label)).toEqual(['Best available (single file)', '720p mp4', '360p mp4', 'Audio only (m4a)']);
  });

  it('offers merged qualities when ffmpeg exists', async () => {
    const info = await new Media(dir, { ...launch, ffmpeg: 'ffmpeg' }).info('https://x/ok');
    expect(info.formats.map((f) => f.label)).toEqual(['Best available', '1080p', '720p', '480p', '360p', 'Audio only (m4a)']);
    expect(info.formats[2].id).toBe('bv*[height<=720]+ba/b[height<=720]');
  });

  it('reports yt-dlp errors readably', async () => {
    await expect(new Media(dir, launch).info('https://x/fail')).rejects.toThrow('Unsupported URL');
  });

  it('downloads, emits progress and reports the real filename', async () => {
    const d = new Media(dir, launch).downloader({ url: 'https://x/ok', dir, stem: 'clip', format: '22' });
    const progress: number[] = [];
    let name = '';
    d.on('progress', (p) => progress.push(p.downloaded));
    d.on('filename', (n) => (name = n));
    expect(await d.start()).toBe('completed');
    expect(progress).toEqual([100, 200, 300]);
    expect(name).toBe('clip.mp4');
    expect(await fs.readFile(path.join(dir, 'clip.mp4'), 'utf8')).toBe('video-bytes');
  });

  it('pauses a running download', async () => {
    const d = new Media(dir, launch).downloader({ url: 'https://x/slow', dir, stem: 'clip', format: 'b' });
    d.once('progress', () => d.pause());
    expect(await d.start()).toBe('paused');
    await expect(fs.stat(path.join(dir, 'clip.mp4'))).rejects.toThrow();
  });

  it('fails with the yt-dlp message', async () => {
    const d = new Media(dir, launch).downloader({ url: 'https://x/fail', dir, stem: 'c', format: 'b' });
    await expect(d.start()).rejects.toThrow('Video unavailable');
  });
});
