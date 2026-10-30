import fsSync from 'node:fs';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Media, ProgressTracker, cookieDomain, cookieHeaderToNetscape, explainError, prepareHeaders, compareVersions, latestYtDlpVersion, parsePlan, parseProgress, safeTitle, simplify, infoArgs } from '../src/index.js';

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
  it('treats watch links as one video even when they name a playlist', () => {
    expect(infoArgs('https://www.youtube.com/watch?v=abc&list=PL1')).toContain('--no-playlist');
    expect(infoArgs('https://youtu.be/abc?list=PL1')).toContain('--no-playlist');
    const list = infoArgs('https://www.youtube.com/playlist?list=PL1');
    expect(list).not.toContain('--no-playlist');
    expect(list).toEqual(expect.arrayContaining(['--flat-playlist', '--playlist-end', '500']));
  });
  it('only accepts http(s) links, and puts the URL after --', () => {
    expect(() => infoArgs('file:///c:/x')).toThrow();
    expect(() => infoArgs('--exec=calc')).toThrow();
    expect(infoArgs('https://a/b').slice(-2)).toEqual(['--', 'https://a/b']);
  });
});

describe('cookies and logins', () => {
  it('picks the domain a browser would store the cookie for', () => {
    expect(cookieDomain('www.instagram.com')).toBe('.instagram.com');
    expect(cookieDomain('i.instagram.com')).toBe('.instagram.com');
    expect(cookieDomain('www.bbc.co.uk')).toBe('.bbc.co.uk');
    expect(cookieDomain('127.0.0.1')).toBe('127.0.0.1');
    expect(cookieDomain('localhost')).toBe('localhost');
  });

  it('converts a Cookie header to a Netscape cookie file', () => {
    const txt = cookieHeaderToNetscape('sessionid=abc%3A1; csrftoken=xyz; ; junk; =novalue', 'https://www.instagram.com/reel/x/', 1_000_000_000_000);
    const rows = txt.trim().split('\n');
    expect(rows[0]).toBe('# Netscape HTTP Cookie File');
    expect(rows.slice(1)).toEqual([
      ['.instagram.com', 'TRUE', '/', 'TRUE', '1002592000', 'sessionid', 'abc%3A1'].join('\t'),
      ['.instagram.com', 'TRUE', '/', 'TRUE', '1002592000', 'csrftoken', 'xyz'].join('\t'),
    ]);
    // a local address is matched exactly and is not marked secure over plain http
    const local = cookieHeaderToNetscape('a=b', 'http://127.0.0.1:8770/x').split('\n')[1].split('\t');
    expect([local[0], local[1], local[2], local[3], local[5], local[6]]).toEqual(['127.0.0.1', 'FALSE', '/', 'FALSE', 'a', 'b']);
  });

  it('keeps cookies out of the header arguments and cleans up the temp file', () => {
    const p = prepareHeaders('https://x.example/v', { Cookie: 'sid=abc', Referer: 'https://x.example/', 'User-Agent': 'UA' });
    expect(p.headerArgs).toEqual(['--add-header', 'Referer:https://x.example/', '--add-header', 'User-Agent:UA']);
    expect(p.cookieArgs[0]).toBe('--cookies');
    const file = p.cookieArgs[1];
    expect(fsSync.readFileSync(file, 'utf8')).toContain('\tsid\tabc');
    p.cleanup();
    p.cleanup(); // calling twice is harmless
    expect(fsSync.existsSync(file)).toBe(false);
    expect(prepareHeaders('https://x/', { Referer: 'r' }).cookieArgs).toEqual([]);
    expect(prepareHeaders('https://x/', { cookie: 'not a pair' }).cookieArgs).toEqual([]);
  });

  it('never puts a cookie value on the command line', () => {
    expect(infoArgs('https://x/v', { Cookie: 'sid=secret' }).join(' ')).not.toContain('secret');
  });

  it('adds login advice only to login-type errors', () => {
    expect(explainError('https://www.instagram.com/p/x/', 'empty media response')).toMatch(/Instagram needs you to be logged in/);
    expect(explainError('https://example.com/v', 'Sign in to confirm')).toMatch(/may need you to be logged in/);
    expect(explainError('https://example.com/v', 'HTTP Error 404')).toBe('HTTP Error 404');
    expect(explainError('https://example.com/v', 'Unable to download webpage: HTTP Error 403: Forbidden')).toMatch(/may need you to be logged in/);
  });

  it('reads info and downloads a login-only video when the Cookie header is supplied', async () => {
    const log = path.join(dir, 'cookie-paths.txt');
    process.env.DM_FAKE_LOG = log;
    try {
      const media = new Media(dir, launch);
      const url = 'https://www.instagram.com/login'; // the fake picks its behaviour from the last path segment
      await expect(media.info(url)).rejects.toThrow(/Instagram needs you to be logged in/);

      const info = await media.info(url, { Cookie: 'sid=abc; other=1' });
      expect(info.title).toBe('Private reel');

      const d = media.downloader({ url, dir, stem: 'reel', format: 'b', headers: { Cookie: 'sid=abc' } });
      expect(await d.start()).toBe('completed');
      expect(fsSync.readFileSync(path.join(dir, 'reel.mp4'), 'utf8')).toBe('video-bytes');

      const used = fsSync.readFileSync(log, 'utf8').trim().split('\n');
      expect(used.length).toBe(2); // one for the info call, one for the download
      for (const f of used) expect(fsSync.existsSync(f)).toBe(false); // temporary cookie files were removed
    } finally {
      delete process.env.DM_FAKE_LOG;
    }
  });
});

describe('single embedded video pages', () => {
  it('names the only entry after the page, not "<title> (1)"', () => {
    const one = simplify({ _type: 'playlist', title: 'Members clip', entries: [{ id: 'x', title: 'Members clip (1)', url: 'https://s/clip.mp4' }] }, false);
    expect(one.playlist?.entries[0].title).toBe('Members clip');
    const two = simplify({ _type: 'playlist', title: 'Mix', entries: [{ id: 'a', title: 'Mix (1)', url: 'https://s/a' }, { id: 'b', title: 'Mix (2)', url: 'https://s/b' }] }, false);
    expect(two.playlist?.entries.map((e) => e.title)).toEqual(['Mix (1)', 'Mix (2)']); // real playlists keep their names
  });
});

describe('yt-dlp versions', () => {
  it('compares dotted versions numerically', () => {
    expect(compareVersions('2026.10.21', '2026.10.21')).toBe(0);
    expect(compareVersions('2026.9.30', '2026.10.1')).toBe(-1); // 9 < 10, not a text comparison
    expect(compareVersions('2026.10.21.5', '2026.10.21')).toBe(1);
    expect(compareVersions('2027.1.1', '2026.12.31')).toBe(1);
  });

  it('reads the latest release tag from the redirect', async () => {
    const fake = (async () => new Response(null, { status: 302, headers: { location: 'https://github.com/yt-dlp/yt-dlp/releases/tag/2026.11.02' } })) as typeof fetch;
    expect(await latestYtDlpVersion(fake)).toBe('2026.11.02');
  });

  it('fails clearly when GitHub does not redirect', async () => {
    const fake = (async () => new Response(null, { status: 200 })) as typeof fetch;
    await expect(latestYtDlpVersion(fake)).rejects.toThrow(/latest yt-dlp version/);
  });
});

describe('progress across streams', () => {
  it('parses the stream id and the plan', () => {
    expect(parseProgress('DMPROG:5|10|NA|2|137')).toEqual({ downloaded: 5, size: 10, speed: 2, stream: '137' });
    expect(parsePlan('DMPLAN:[{"filesize":1000},{"filesize_approx":500}]')).toBe(1500);
    expect(parsePlan('DMPLAN:[{"filesize":1000},{}]')).toBeNull(); // one unknown size: no reliable total
    expect(parsePlan('DMPLAN:null')).toBeNull();
    expect(parsePlan('DMPLAN:not json')).toBeNull();
  });

  it('keeps counting up when the audio stream starts (with a plan)', () => {
    const t = new ProgressTracker();
    t.plan = 1500;
    const out = [
      t.update({ downloaded: 500, size: 1000, speed: 1, stream: 'v' }),
      t.update({ downloaded: 1000, size: 1000, speed: 1, stream: 'v' }),
      t.update({ downloaded: 100, size: 500, speed: 1, stream: 'a' }),
      t.update({ downloaded: 500, size: 500, speed: 1, stream: 'a' }),
    ];
    expect(out.map((o) => o.downloaded)).toEqual([500, 1000, 1100, 1500]);
    expect(out.every((o) => o.size === 1500)).toBe(true);
  });

  it('still works without a plan or stream ids (a drop means a new stream)', () => {
    const t = new ProgressTracker();
    const a = t.update({ downloaded: 900, size: 1000, speed: 1 });
    const b = t.update({ downloaded: 100, size: 400, speed: 1 });
    expect(a).toMatchObject({ downloaded: 900, size: 1000 });
    expect(b.downloaded).toBe(1000 + 100); // previous stream ended at its size
    expect(b.size).toBe(1000 + 400);
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

  it('lists a playlist flat and drops private videos', async () => {
    const info = await new Media(dir, { ...launch, ffmpeg: 'ffmpeg' }).info('https://x/playlist');
    expect(info.title).toBe('My list');
    expect(info.playlist?.entries.map((e) => [e.title, e.url])).toEqual([
      ['First', 'https://site/ok'],
      ['Second', 'https://site/two'],
      ['Fourth', 'https://www.youtube.com/watch?v=d4'], // built from the id for YouTube entries
    ]);
    expect(info.playlist?.truncated).toBe(false);
    expect(info.formats.map((f) => f.label)).toEqual(['Best available', 'Up to 1080p', 'Up to 720p', 'Up to 480p', 'Up to 360p', 'Audio only']);
  });

  it('offers single-file choices for a playlist without ffmpeg', async () => {
    const info = await new Media(dir, launch).info('https://x/playlist');
    expect(info.formats.map((f) => f.label)).toEqual(['Best available (single file)', 'Audio only']);
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

  it('reports one continuous progress for a video + audio download', async () => {
    const d = new Media(dir, launch).downloader({ url: 'https://x/two', dir, stem: 'merged', format: 'bv*+ba/b' });
    const seen: Array<{ downloaded: number; size: number | null }> = [];
    d.on('progress', (p) => seen.push({ downloaded: p.downloaded, size: p.size }));
    expect(await d.start()).toBe('completed');
    const bytes = seen.map((s) => s.downloaded);
    expect(bytes).toEqual([...bytes].sort((a, b) => a - b)); // never goes backwards
    expect(bytes.at(-1)).toBe(1500);
    expect(seen.every((s) => s.size === 1500)).toBe(true);
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
