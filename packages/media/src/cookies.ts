import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const SECOND_LEVEL = new Set(['co', 'com', 'org', 'net', 'gov', 'edu', 'ac']);

/** The domain a site's cookies normally belong to: www.instagram.com -> .instagram.com, bbc.co.uk -> .bbc.co.uk. */
export function cookieDomain(host: string): string {
  if (/^[\d.]+$/.test(host) || host.includes(':') || !host.includes('.')) return host; // IP address or localhost: exact host
  const labels = host.split('.');
  const take = labels.length >= 3 && labels.at(-1)!.length === 2 && SECOND_LEVEL.has(labels.at(-2)!) ? 3 : 2;
  return '.' + labels.slice(-take).join('.');
}

/**
 * Turns a `Cookie` header ("a=1; b=2") into the Netscape cookie-file text yt-dlp reads, for the site of `url`.
 * Browser cookies carry no domain in a header, so they are attached to the site's own domain.
 */
export function cookieHeaderToNetscape(header: string, url: string, nowMs = Date.now()): string {
  const host = new URL(url).hostname;
  const domain = cookieDomain(host);
  const sub = domain.startsWith('.') ? 'TRUE' : 'FALSE';
  const secure = url.startsWith('https:') ? 'TRUE' : 'FALSE';
  const expires = Math.floor(nowMs / 1000) + 30 * 86_400;
  const lines = ['# Netscape HTTP Cookie File'];
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (!name || /[\t\r\n]/.test(name + value)) continue; // a tab or newline would corrupt the file
    lines.push([domain, sub, '/', secure, expires, name, value].join('\t'));
  }
  return lines.join('\n') + '\n';
}

export interface Prepared {
  /** `--add-header` arguments for every header except Cookie. */
  headerArgs: string[];
  /** `--cookies <file>` when a Cookie header was given. */
  cookieArgs: string[];
  /** Deletes the temporary cookie file. Safe to call more than once. */
  cleanup(): void;
}

/**
 * Splits request headers for yt-dlp: ordinary headers become `--add-header`, the Cookie header becomes a private
 * temporary cookie file (yt-dlp only applies cookies reliably through a cookie jar). The file is removed by `cleanup`.
 */
export function prepareHeaders(url: string, headers?: Record<string, string>): Prepared {
  const all = Object.entries(headers ?? {});
  const cookie = all.find(([k]) => k.toLowerCase() === 'cookie')?.[1];
  const headerArgs = all.filter(([k]) => k.toLowerCase() !== 'cookie').flatMap(([k, v]) => ['--add-header', `${k}:${v}`]);
  if (!cookie || !cookie.includes('=')) return { headerArgs, cookieArgs: [], cleanup() {} };

  const dir = mkdtempSync(path.join(tmpdir(), 'dm-ck-'));
  const file = path.join(dir, 'cookies.txt');
  writeFileSync(file, cookieHeaderToNetscape(cookie, url), { mode: 0o600 });
  let done = false;
  return {
    headerArgs,
    cookieArgs: ['--cookies', file],
    cleanup() {
      if (done) return;
      done = true;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Adds advice to errors that mean "you need to be logged in" (most Instagram content, private videos...). */
export function explainError(url: string, message: string): string {
  if (!/log ?in|sign in|cookies|empty media response|login required|private|age.restricted|confirm you.re not a bot|http error (401|403)|forbidden/i.test(message)) return message;
  const insta = /(^|\.)instagram\.com$/i.test(safeHost(url));
  if (insta) {
    // yt-dlp's own text is long and talks about command-line options; say the useful part plainly.
    return `Instagram needs you to be logged in for most posts, reels and stories (a post that is private or no longer exists gives the same answer). Log in to Instagram in your browser and use the HyperFetch Pro extension's download button, which passes your login, or paste your Cookie header under "Authentication and cookies".`;
  }
  const where = 'This site may need you to be logged in.';
  return `${message} ${where} Log in in your browser and use the HyperFetch Pro extension's download button (it passes your login), or paste your Cookie header under "Authentication and cookies".`;
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}
