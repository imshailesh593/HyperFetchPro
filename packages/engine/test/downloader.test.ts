import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Downloader, parseContentDisposition, sanitizeFilename } from '../src/index.js';

const DATA = randomBytes(6 * 1024 * 1024);
const SHA = createHash('sha256').update(DATA).digest('hex');
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

let server: http.Server;
let base: string;
let dir: string;
const connections: string[] = [];
let failNext = 0;

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dm-engine-'));
  server = http.createServer((req, res) => {
    const ranged = req.url!.startsWith('/ranged');
    const slow = req.url!.includes('slow');
    res.setHeader('ETag', '"v1"');
    if (ranged) res.setHeader('Accept-Ranges', 'bytes');

    if (req.method === 'HEAD') {
      res.setHeader('Content-Length', DATA.length);
      return res.end();
    }
    if (req.url!.includes('flaky') && failNext > 0) {
      failNext--;
      return res.destroy();
    }

    let start = 0;
    let end = DATA.length - 1;
    const m = ranged && req.headers.range ? /bytes=(\d+)-(\d*)/.exec(req.headers.range) : null;
    if (m) {
      start = Number(m[1]);
      if (m[2]) end = Number(m[2]);
      res.statusCode = 206;
      res.setHeader('Content-Range', `bytes ${start}-${end}/${DATA.length}`);
      connections.push(req.headers.range!);
    }
    res.setHeader('Content-Length', end - start + 1);
    const body = DATA.subarray(start, end + 1);
    if (!slow) return res.end(body);
    // slow: 64 KiB every 10 ms so a pause can land mid-download
    let off = 0;
    const timer = setInterval(() => {
      if (res.destroyed) return clearInterval(timer);
      res.write(body.subarray(off, off + 65536));
      off += 65536;
      if (off >= body.length) {
        clearInterval(timer);
        res.end();
      }
    }, 10);
    res.on('close', () => clearInterval(timer));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.close();
  await fs.rm(dir, { recursive: true, force: true });
});

describe('Downloader', () => {
  it('downloads over several connections and the file matches', async () => {
    connections.length = 0;
    const dest = path.join(dir, 'multi.bin');
    const d = new Downloader({ url: `${base}/ranged`, dest, maxConnections: 4, minSplitSize: 64 * 1024 });
    expect(await d.start()).toBe('completed');
    expect(sha(await fs.readFile(dest))).toBe(SHA);
    expect(connections.length).toBeGreaterThan(1);
    await expect(fs.stat(`${dest}.part`)).rejects.toThrow();
    await expect(fs.stat(`${dest}.part.json`)).rejects.toThrow();
  });

  it('falls back to a single stream without range support', async () => {
    const dest = path.join(dir, 'plain.bin');
    const d = new Downloader({ url: `${base}/plain`, dest, maxConnections: 4 });
    expect(await d.start()).toBe('completed');
    expect(sha(await fs.readFile(dest))).toBe(SHA);
  });

  it('pauses and resumes to a correct file', async () => {
    const dest = path.join(dir, 'resume.bin');
    const opts = { url: `${base}/ranged-slow`, dest, maxConnections: 3, minSplitSize: 64 * 1024, stateFlushMs: 50 };
    const first = new Downloader(opts);
    first.on('progress', (p) => p.downloaded > 1_000_000 && first.pause());
    expect(await first.start()).toBe('paused');
    const partial = JSON.parse(await fs.readFile(`${dest}.part.json`, 'utf8'));
    const had = partial.segments.reduce((n: number, s: { written: number }) => n + s.written, 0);
    expect(had).toBeGreaterThan(0);
    expect(had).toBeLessThan(DATA.length);

    const second = new Downloader(opts);
    let firstSeen = -1;
    second.on('progress', (p) => firstSeen < 0 && (firstSeen = p.downloaded));
    expect(await second.start()).toBe('completed');
    expect(firstSeen).toBeGreaterThanOrEqual(had); // resumed, did not restart
    expect(sha(await fs.readFile(dest))).toBe(SHA);
  });

  it('retries after dropped connections', async () => {
    failNext = 2;
    const dest = path.join(dir, 'flaky.bin');
    const d = new Downloader({ url: `${base}/ranged-flaky`, dest, maxConnections: 2, maxRetries: 5 });
    expect(await d.start()).toBe('completed');
    expect(sha(await fs.readFile(dest))).toBe(SHA);
  });

  it('fails on HTTP 404 without retrying forever', async () => {
    const dest = path.join(dir, 'missing.bin');
    const bad = http.createServer((_, res) => {
      res.statusCode = 404;
      res.end();
    });
    await new Promise<void>((r) => bad.listen(0, '127.0.0.1', r));
    const port = (bad.address() as AddressInfo).port;
    const d = new Downloader({ url: `http://127.0.0.1:${port}/x`, dest });
    await expect(d.start()).rejects.toThrow();
    expect(d.status).toBe('failed');
    bad.close();
  });

  it('applies the speed limit', async () => {
    const dest = path.join(dir, 'limited.bin');
    const t0 = Date.now();
    const d = new Downloader({ url: `${base}/ranged`, dest, maxConnections: 2, speedLimit: 3 * 1024 * 1024 });
    await d.start();
    expect(Date.now() - t0).toBeGreaterThan(800); // 6 MiB at 3 MiB/s
  });
});

describe('filenames', () => {
  it('parses Content-Disposition', () => {
    expect(parseContentDisposition('attachment; filename="a b.zip"')).toBe('a b.zip');
    expect(parseContentDisposition("attachment; filename*=UTF-8''%E2%82%AC.txt")).toBe('€.txt');
  });
  it('sanitizes dangerous names', () => {
    expect(sanitizeFilename('../../etc/passwd')).toBe('.._.._etc_passwd'.replace(/^\.+/, ''));
    expect(sanitizeFilename('CON')).toBe('_CON');
  });
});
