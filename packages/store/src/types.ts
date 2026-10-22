export type DownloadRowStatus = 'queued' | 'running' | 'paused' | 'completed' | 'failed';
export type QueueKind = 'download' | 'sync';
export type AfterAction = 'none' | 'exit' | 'shutdown';

export interface DownloadRow {
  id: number;
  url: string;
  finalUrl: string | null;
  dir: string;
  filename: string;
  size: number | null;
  downloaded: number;
  status: DownloadRowStatus;
  categoryId: number | null;
  queueId: number | null;
  headers: Record<string, string>;
  error: string | null;
  attempts: number;
  /** Epoch ms; the scheduler will not start the download before this. */
  retryAt: number;
  queueOrder: number;
  etag: string | null;
  lastModified: string | null;
  createdAt: number;
  completedAt: number | null;
  /** 'http' = our segmented engine; 'media' = yt-dlp (video sites). */
  kind: 'http' | 'media';
  /** yt-dlp format selector for media downloads. */
  format: string | null;
}

export interface QueueRow {
  id: number;
  name: string;
  kind: QueueKind;
  maxParallel: number;
  /** 'HH:MM' local time, or null for manual-only. */
  startTime: string | null;
  stopTime: string | null;
  /** Bit 0 = Sunday ... bit 6 = Saturday. 127 = every day. */
  days: number;
  afterAction: AfterAction;
}

export interface CategoryRow {
  id: number;
  name: string;
  /** Lower-case extensions without dots. */
  extensions: string[];
  /** null means `<defaultDir>/<name>`. */
  saveDir: string | null;
}

export const MAIN_DOWNLOAD_QUEUE = 1;
export const MAIN_SYNC_QUEUE = 2;
