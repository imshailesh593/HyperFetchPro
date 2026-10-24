export interface MediaFormat {
  /** yt-dlp format selector passed to `-f`. */
  id: string;
  label: string;
  ext: string;
  height: number | null;
  size: number | null;
  kind: 'best' | 'video' | 'merged' | 'audio';
}

export interface PlaylistEntry {
  id: string;
  title: string;
  /** Page link of the single video. */
  url: string;
  duration: number | null;
}

export const PLAYLIST_LIMIT = 500;

export interface MediaInfo {
  title: string;
  uploader: string | null;
  duration: number | null;
  thumbnail: string | null;
  webpageUrl: string;
  formats: MediaFormat[];
  /** False when ffmpeg is missing: only single-file formats are offered. */
  canMerge: boolean;
  /** Present when the link is a playlist, channel or multi-item post. */
  playlist?: { entries: PlaylistEntry[]; truncated: boolean };
}

interface RawFormat {
  format_id?: string;
  ext?: string;
  height?: number | null;
  vcodec?: string;
  acodec?: string;
  filesize?: number | null;
  filesize_approx?: number | null;
  protocol?: string;
}

const hasV = (f: RawFormat) => !!f.vcodec && f.vcodec !== 'none';
const hasA = (f: RawFormat) => !!f.acodec && f.acodec !== 'none';
const sizeOf = (f: RawFormat) => f.filesize ?? f.filesize_approx ?? null;

const UNAVAILABLE = /^\[(private|deleted) video\]$/i;

function playlistEntries(raw: Record<string, any>): PlaylistEntry[] {
  const out: PlaylistEntry[] = [];
  for (const e of (raw.entries ?? []) as Array<Record<string, any> | null>) {
    if (!e) continue;
    let url: string | undefined = e.url ?? e.webpage_url;
    if (!url || !/^https?:\/\//i.test(url)) url = e.ie_key === 'Youtube' && e.id ? `https://www.youtube.com/watch?v=${e.id}` : undefined;
    const title = String(e.title ?? e.id ?? 'video');
    if (!url || UNAVAILABLE.test(title)) continue;
    out.push({ id: String(e.id ?? url), title, url, duration: typeof e.duration === 'number' ? e.duration : null });
  }
  return out;
}

/** Qualities offered for a whole playlist: fixed choices, since each video has its own formats. */
function playlistFormats(canMerge: boolean): MediaFormat[] {
  const formats: MediaFormat[] = canMerge
    ? [{ id: 'bv*+ba/b', label: 'Best available', ext: 'mp4', height: null, size: null, kind: 'best' as const }]
    : [{ id: 'b', label: 'Best available (single file)', ext: 'mp4', height: null, size: null, kind: 'best' as const }];
  if (canMerge) {
    for (const h of [1080, 720, 480, 360]) {
      formats.push({ id: `bv*[height<=${h}]+ba/b[height<=${h}]`, label: `Up to ${h}p`, ext: 'mp4', height: h, size: null, kind: 'merged' });
    }
  }
  formats.push({ id: 'ba', label: 'Audio only', ext: 'm4a', height: null, size: null, kind: 'audio' });
  return formats;
}

/** Turns yt-dlp's `-J` output into a short, choosable list of qualities. */
export function simplify(raw: Record<string, any>, canMerge: boolean): MediaInfo {
  if (raw._type === 'playlist') {
    const entries = playlistEntries(raw);
    return {
      title: String(raw.title ?? 'Playlist'),
      uploader: raw.uploader ?? raw.channel ?? null,
      duration: null,
      thumbnail: null,
      webpageUrl: String(raw.webpage_url ?? raw.original_url ?? ''),
      formats: playlistFormats(canMerge),
      canMerge,
      playlist: { entries, truncated: (raw.entries?.length ?? 0) >= PLAYLIST_LIMIT },
    };
  }
  const all = ((raw.formats ?? []) as RawFormat[]).filter((f) => f.format_id);
  const formats: MediaFormat[] = [
    canMerge
      ? { id: 'bv*+ba/b', label: 'Best available', ext: 'mp4', height: null, size: null, kind: 'best' }
      : { id: 'b', label: 'Best available (single file)', ext: 'mp4', height: null, size: null, kind: 'best' },
  ];

  if (canMerge) {
    const heights = [...new Set(all.filter(hasV).map((f) => f.height).filter((h): h is number => !!h))].sort((a, b) => b - a);
    for (const h of heights) {
      formats.push({ id: `bv*[height<=${h}]+ba/b[height<=${h}]`, label: `${h}p`, ext: 'mp4', height: h, size: null, kind: 'merged' });
    }
  } else {
    // Without ffmpeg only formats that already contain audio and video can be saved.
    const byHeight = new Map<number, RawFormat>();
    for (const f of all.filter((f) => hasV(f) && hasA(f) && f.height && !/m3u8|dash/.test(f.protocol ?? ''))) {
      const cur = byHeight.get(f.height!);
      if (!cur || (sizeOf(f) ?? 0) > (sizeOf(cur) ?? 0)) byHeight.set(f.height!, f);
    }
    for (const [h, f] of [...byHeight].sort((a, b) => b[0] - a[0])) {
      formats.push({ id: f.format_id!, label: `${h}p ${f.ext ?? ''}`.trim(), ext: f.ext ?? 'mp4', height: h, size: sizeOf(f), kind: 'video' });
    }
  }

  const audio = all.filter((f) => hasA(f) && !hasV(f)).sort((a, b) => (sizeOf(b) ?? 0) - (sizeOf(a) ?? 0))[0];
  if (audio) formats.push({ id: 'ba', label: `Audio only (${audio.ext ?? 'best'})`, ext: audio.ext ?? 'm4a', height: null, size: sizeOf(audio), kind: 'audio' });

  return {
    title: String(raw.title ?? raw.id ?? 'video'),
    uploader: raw.uploader ?? raw.channel ?? null,
    duration: typeof raw.duration === 'number' ? raw.duration : null,
    thumbnail: raw.thumbnail ?? null,
    webpageUrl: String(raw.webpage_url ?? raw.original_url ?? ''),
    formats,
    canMerge,
  };
}

export const PROGRESS_PREFIX = 'DMPROG:';
export const FILE_PREFIX = 'DMFILE:';
export const PLAN_PREFIX = 'DMPLAN:';
export const PROGRESS_TEMPLATE = `download:${PROGRESS_PREFIX}%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(info.format_id)s`;

const num = (s: string): number | null => {
  const n = Number(s);
  return s && s !== 'NA' && s !== 'None' && Number.isFinite(n) ? n : null;
};

export interface ProgressLine {
  downloaded: number;
  size: number | null;
  speed: number;
  /** Which stream this is (video and audio are separate streams); undefined if not reported. */
  stream?: string;
}

export function parseProgress(line: string): ProgressLine | null {
  if (!line.startsWith(PROGRESS_PREFIX)) return null;
  const [d, total, est, speed, stream] = line.slice(PROGRESS_PREFIX.length).trim().split('|');
  const id = stream && stream !== 'NA' && stream !== 'None' ? stream : undefined;
  return { downloaded: num(d) ?? 0, size: num(total) ?? num(est), speed: num(speed) ?? 0, stream: id };
}

/** Total bytes of all streams yt-dlp is about to fetch, from its `requested_formats` JSON; null if unknown. */
export function parsePlan(line: string): number | null {
  if (!line.startsWith(PLAN_PREFIX)) return null;
  try {
    const list = JSON.parse(line.slice(PLAN_PREFIX.length)) as Array<{ filesize?: number | null; filesize_approx?: number | null }> | null;
    if (!Array.isArray(list) || list.length === 0) return null;
    let sum = 0;
    for (const f of list) {
      const n = f.filesize ?? f.filesize_approx;
      if (!n) return null; // one stream without a size makes the total unreliable
      sum += n;
    }
    return sum > 0 ? sum : null;
  } catch {
    return null;
  }
}

/**
 * Turns per-stream progress into one figure for the whole video: when the stream changes, what the
 * previous stream finished with is added to a running offset. `plan` (total of all streams) is used as
 * the overall size when known, otherwise the size seen so far.
 */
export class ProgressTracker {
  private offset = 0;
  private stream: string | undefined;
  private last = 0;
  private lastSize: number | null = null;
  plan: number | null = null;

  update(p: ProgressLine): { downloaded: number; size: number | null; speed: number } {
    const switched = this.stream !== undefined && p.stream !== undefined && p.stream !== this.stream;
    // Without stream ids, a drop in the byte count also means a new stream began.
    const dropped = p.stream === undefined && p.downloaded < this.last;
    if (switched || dropped) this.offset += this.lastSize ?? this.last;
    this.stream = p.stream ?? this.stream;
    this.last = p.downloaded;
    this.lastSize = p.size ?? this.lastSize;
    const downloaded = this.offset + p.downloaded;
    const size = this.plan ?? (p.size !== null ? this.offset + p.size : null);
    return { downloaded, size: size !== null ? Math.max(size, downloaded) : null, speed: p.speed };
  }
}

const BAD = /[\\/:*?"<>|\x00-\x1f]/g;
export function safeTitle(title: string): string {
  return (title.replace(BAD, '_').replace(/^\.+/, '').trim() || 'video').slice(0, 150);
}
