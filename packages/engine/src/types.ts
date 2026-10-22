export interface ProbeResult {
  url: string;
  finalUrl: string;
  size: number | null;
  acceptRanges: boolean;
  etag: string | null;
  lastModified: string | null;
  filename: string | null;
}

export interface Segment {
  start: number;
  /** Exclusive end offset. */
  end: number;
  /** Bytes already written, counted from `start`. */
  written: number;
}

export interface DownloadState {
  url: string;
  finalUrl: string;
  size: number | null;
  etag: string | null;
  lastModified: string | null;
  segments: Segment[];
}

export interface DownloadOptions {
  url: string;
  /** Final file path. Data is written to `${dest}.part` until complete. */
  dest: string;
  maxConnections?: number;
  /** Segments smaller than twice this value are not split further. */
  minSplitSize?: number;
  headers?: Record<string, string>;
  /** Bytes per second across all connections; 0 or undefined means unlimited. */
  speedLimit?: number;
  maxRetries?: number;
  /** Skip the ETag / Last-Modified check when resuming. */
  ignoreModificationTime?: boolean;
  stateFlushMs?: number;
}

export interface ProgressInfo {
  downloaded: number;
  size: number | null;
  /** Bytes per second, smoothed over the last few seconds. */
  speed: number;
  segments: Segment[];
}

export type DownloadStatus = 'idle' | 'running' | 'paused' | 'completed' | 'failed';
