import type { ProbeResult } from './types.js';

export function parseContentDisposition(value: string | null): string | null {
  if (!value) return null;
  const star = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(value);
  if (star) {
    try {
      return sanitizeFilename(decodeURIComponent(star[1].trim()));
    } catch {
      /* fall through to plain filename */
    }
  }
  const plain = /filename\s*=\s*"?([^";]+)"?/.exec(value);
  return plain ? sanitizeFilename(plain[1].trim()) : null;
}

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

export function sanitizeFilename(name: string): string {
  let out = name.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/^\.+/, '').trim();
  if (!out || RESERVED.test(out)) out = `_${out}`;
  return out.slice(0, 200);
}

function filenameFromUrl(url: string): string | null {
  try {
    const last = new URL(url).pathname.split('/').filter(Boolean).pop();
    return last ? sanitizeFilename(decodeURIComponent(last)) : null;
  } catch {
    return null;
  }
}

/**
 * Discover size, range support and validators. Tries HEAD first and falls back to
 * a one-byte ranged GET, since some servers reject HEAD or omit headers on it.
 */
export async function probe(
  url: string,
  headers: Record<string, string> = {},
  signal?: AbortSignal,
): Promise<ProbeResult> {
  const head = await fetch(url, { method: 'HEAD', headers, redirect: 'follow', signal }).catch(() => null);
  if (head?.ok && head.headers.get('content-length')) {
    return fromHeaders(url, head, null);
  }
  const res = await fetch(url, {
    method: 'GET',
    headers: { ...headers, Range: 'bytes=0-0' },
    redirect: 'follow',
    signal,
  });
  if (!res.ok) throw new Error(`Probe failed: HTTP ${res.status}`);
  await res.body?.cancel();
  return fromHeaders(url, res, res.status === 206 ? parseContentRangeTotal(res.headers.get('content-range')) : null);
}

function parseContentRangeTotal(value: string | null): number | null {
  const m = value ? /\/(\d+)$/.exec(value) : null;
  return m ? Number(m[1]) : null;
}

function fromHeaders(url: string, res: Response, rangeTotal: number | null): ProbeResult {
  const len = res.headers.get('content-length');
  const size = rangeTotal ?? (len && res.status !== 206 ? Number(len) : null);
  const ranged = res.status === 206 || (res.headers.get('accept-ranges') ?? '').toLowerCase() === 'bytes';
  return {
    url,
    finalUrl: res.url || url,
    size: size !== null && Number.isFinite(size) ? size : null,
    acceptRanges: ranged,
    etag: res.headers.get('etag'),
    lastModified: res.headers.get('last-modified'),
    filename:
      parseContentDisposition(res.headers.get('content-disposition')) ?? filenameFromUrl(res.url || url),
  };
}
