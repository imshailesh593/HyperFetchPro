import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { DatabaseSync as DatabaseSyncType, SQLInputValue } from 'node:sqlite';
import type { CategoryRow, DownloadRow, QueueRow } from './types.js';

// Loaded via require so bundlers/test runners that don't know `node:sqlite` leave it alone.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

type Row = Record<string, unknown>;

const MIGRATIONS: string[] = [
  `
  CREATE TABLE categories (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, extensions TEXT NOT NULL, save_dir TEXT
  );
  CREATE TABLE queues (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL,
    max_parallel INTEGER NOT NULL DEFAULT 1, start_time TEXT, stop_time TEXT,
    days INTEGER NOT NULL DEFAULT 127, after_action TEXT NOT NULL DEFAULT 'none'
  );
  CREATE TABLE downloads (
    id INTEGER PRIMARY KEY, url TEXT NOT NULL, final_url TEXT, dir TEXT NOT NULL,
    filename TEXT NOT NULL, size INTEGER, downloaded INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL, category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
    queue_id INTEGER REFERENCES queues(id) ON DELETE SET NULL, headers_json TEXT NOT NULL DEFAULT '{}',
    error TEXT, attempts INTEGER NOT NULL DEFAULT 0, retry_at INTEGER NOT NULL DEFAULT 0,
    queue_order INTEGER NOT NULL DEFAULT 0, etag TEXT, last_modified TEXT,
    created_at INTEGER NOT NULL, completed_at INTEGER
  );
  CREATE INDEX idx_downloads_queue ON downloads(queue_id, status, queue_order);
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  INSERT INTO queues (id, name, kind, max_parallel) VALUES
    (1, 'Main download queue', 'download', 1), (2, 'Main synchronization queue', 'sync', 1);
  INSERT INTO categories (name, extensions) VALUES
    ('Compressed', 'zip rar 7z gz tar bz2 xz iso'),
    ('Documents', 'pdf doc docx xls xlsx ppt pptx txt epub'),
    ('Music', 'mp3 flac wav aac ogg m4a wma'),
    ('Programs', 'exe msi dmg pkg deb apk appimage'),
    ('Video', 'mp4 mkv avi mov wmv flv webm m4v');
  `,
  `
  ALTER TABLE downloads ADD COLUMN kind TEXT NOT NULL DEFAULT 'http';
  ALTER TABLE downloads ADD COLUMN format TEXT;
  `,
];

const DOWNLOAD_COLUMNS: Record<string, string> = {
  url: 'url', finalUrl: 'final_url', dir: 'dir', filename: 'filename', size: 'size',
  downloaded: 'downloaded', status: 'status', categoryId: 'category_id', queueId: 'queue_id',
  error: 'error', attempts: 'attempts', retryAt: 'retry_at', queueOrder: 'queue_order',
  etag: 'etag', lastModified: 'last_modified', completedAt: 'completed_at', kind: 'kind', format: 'format',
};

const QUEUE_COLUMNS: Record<string, string> = {
  name: 'name', kind: 'kind', maxParallel: 'max_parallel', startTime: 'start_time',
  stopTime: 'stop_time', days: 'days', afterAction: 'after_action',
};

export type NewDownload = Pick<DownloadRow, 'url' | 'dir' | 'filename'> &
  Partial<Omit<DownloadRow, 'id' | 'url' | 'dir' | 'filename' | 'createdAt'>>;

export class Store {
  private db: DatabaseSyncType;

  constructor(file = ':memory:') {
    if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    const { user_version: current } = this.db.prepare('PRAGMA user_version').get() as { user_version: number };
    for (let v = current; v < MIGRATIONS.length; v++) {
      this.db.exec('BEGIN');
      try {
        this.db.exec(MIGRATIONS[v]);
        this.db.exec(`PRAGMA user_version = ${v + 1}`);
        this.db.exec('COMMIT');
      } catch (e) {
        this.db.exec('ROLLBACK');
        throw e;
      }
    }
  }

  private run(sql: string, ...params: SQLInputValue[]): { changes: number; id: number } {
    const r = this.db.prepare(sql).run(...params);
    return { changes: Number(r.changes), id: Number(r.lastInsertRowid) };
  }
  private all(sql: string, ...params: SQLInputValue[]): Row[] {
    return this.db.prepare(sql).all(...params) as Row[];
  }
  private one(sql: string, ...params: SQLInputValue[]): Row | undefined {
    return this.db.prepare(sql).get(...params) as Row | undefined;
  }

  // --- downloads -----------------------------------------------------------

  addDownload(input: NewDownload): DownloadRow {
    const order = this.one('SELECT COALESCE(MAX(queue_order), 0) + 1 AS n FROM downloads') as { n: number };
    const { id } = this.run(
      `INSERT INTO downloads (url, final_url, dir, filename, size, downloaded, status, category_id, queue_id,
         headers_json, error, attempts, retry_at, queue_order, etag, last_modified, created_at, completed_at, kind, format)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      input.url, input.finalUrl ?? null, input.dir, input.filename, input.size ?? null, input.downloaded ?? 0,
      input.status ?? 'paused', input.categoryId ?? null, input.queueId ?? null,
      JSON.stringify(input.headers ?? {}), input.error ?? null, input.attempts ?? 0, input.retryAt ?? 0,
      input.queueOrder ?? order.n, input.etag ?? null, input.lastModified ?? null, Date.now(),
      input.completedAt ?? null, input.kind ?? 'http', input.format ?? null,
    );
    return this.getDownload(id)!;
  }

  getDownload(id: number): DownloadRow | undefined {
    const r = this.one('SELECT * FROM downloads WHERE id = ?', id);
    return r && toDownload(r);
  }

  listDownloads(filter: { queueId?: number; status?: string } = {}): DownloadRow[] {
    const where: string[] = [];
    const params: SQLInputValue[] = [];
    if (filter.queueId !== undefined) (where.push('queue_id = ?'), params.push(filter.queueId));
    if (filter.status !== undefined) (where.push('status = ?'), params.push(filter.status));
    const sql = `SELECT * FROM downloads ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY queue_order, id`;
    return this.all(sql, ...params).map(toDownload);
  }

  updateDownload(id: number, patch: Partial<Omit<DownloadRow, 'id' | 'createdAt'>>): DownloadRow | undefined {
    const sets: string[] = [];
    const params: SQLInputValue[] = [];
    for (const [key, value] of Object.entries(patch)) {
      if (key === 'headers') {
        sets.push('headers_json = ?');
        params.push(JSON.stringify(value));
        continue;
      }
      const col = DOWNLOAD_COLUMNS[key];
      if (!col) throw new Error(`Unknown download field: ${key}`);
      sets.push(`${col} = ?`);
      params.push((value ?? null) as SQLInputValue);
    }
    if (sets.length) this.run(`UPDATE downloads SET ${sets.join(', ')} WHERE id = ?`, ...params, id);
    return this.getDownload(id);
  }

  deleteDownload(id: number): boolean {
    return this.run('DELETE FROM downloads WHERE id = ?', id).changes > 0;
  }

  /** Next runnable download in a queue: queued, retry delay elapsed, lowest order first. */
  nextQueued(queueId: number, nowMs: number): DownloadRow | undefined {
    const r = this.one(
      `SELECT * FROM downloads WHERE queue_id = ? AND status = 'queued' AND retry_at <= ?
       ORDER BY queue_order, id LIMIT 1`,
      queueId, nowMs,
    );
    return r && toDownload(r);
  }

  /** Move a download behind everything else, used when a download has to be retried later. */
  moveToBack(id: number): void {
    this.run('UPDATE downloads SET queue_order = (SELECT COALESCE(MAX(queue_order), 0) + 1 FROM downloads) WHERE id = ?', id);
  }

  // --- queues --------------------------------------------------------------

  getQueue(id: number): QueueRow | undefined {
    const r = this.one('SELECT * FROM queues WHERE id = ?', id);
    return r && toQueue(r);
  }

  listQueues(): QueueRow[] {
    return this.all('SELECT * FROM queues ORDER BY id').map(toQueue);
  }

  addQueue(input: Partial<Omit<QueueRow, 'id'>> & { name: string }): QueueRow {
    const { id } = this.run(
      'INSERT INTO queues (name, kind, max_parallel, start_time, stop_time, days, after_action) VALUES (?,?,?,?,?,?,?)',
      input.name, input.kind ?? 'download', input.maxParallel ?? 1, input.startTime ?? null,
      input.stopTime ?? null, input.days ?? 127, input.afterAction ?? 'none',
    );
    return this.getQueue(id)!;
  }

  updateQueue(id: number, patch: Partial<Omit<QueueRow, 'id'>>): QueueRow | undefined {
    const sets: string[] = [];
    const params: SQLInputValue[] = [];
    for (const [key, value] of Object.entries(patch)) {
      const col = QUEUE_COLUMNS[key];
      if (!col) throw new Error(`Unknown queue field: ${key}`);
      sets.push(`${col} = ?`);
      params.push((value ?? null) as SQLInputValue);
    }
    if (sets.length) this.run(`UPDATE queues SET ${sets.join(', ')} WHERE id = ?`, ...params, id);
    return this.getQueue(id);
  }

  /** The two main queues cannot be deleted. Downloads in a deleted queue become unqueued. */
  deleteQueue(id: number): boolean {
    if (id === 1 || id === 2) throw new Error('The main queues cannot be deleted');
    return this.run('DELETE FROM queues WHERE id = ?', id).changes > 0;
  }

  // --- categories ----------------------------------------------------------

  listCategories(): CategoryRow[] {
    return this.all('SELECT * FROM categories ORDER BY id').map(toCategory);
  }

  addCategory(input: { name: string; extensions: string[]; saveDir?: string | null }): CategoryRow {
    const { id } = this.run(
      'INSERT INTO categories (name, extensions, save_dir) VALUES (?,?,?)',
      input.name, normalizeExtensions(input.extensions).join(' '), input.saveDir ?? null,
    );
    return toCategory(this.one('SELECT * FROM categories WHERE id = ?', id)!);
  }

  deleteCategory(id: number): boolean {
    return this.run('DELETE FROM categories WHERE id = ?', id).changes > 0;
  }

  categoryForFilename(filename: string): CategoryRow | undefined {
    const ext = path.extname(filename).slice(1).toLowerCase();
    return ext ? this.listCategories().find((c) => c.extensions.includes(ext)) : undefined;
  }

  // --- settings ------------------------------------------------------------

  getSetting(key: string): string | undefined {
    return (this.one('SELECT value FROM settings WHERE key = ?', key) as { value: string } | undefined)?.value;
  }

  setSetting(key: string, value: string): void {
    this.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value);
  }
}

function normalizeExtensions(list: string[]): string[] {
  return list.map((e) => e.trim().replace(/^\./, '').toLowerCase()).filter(Boolean);
}

function toDownload(r: Row): DownloadRow {
  return {
    id: r.id as number, url: r.url as string, finalUrl: r.final_url as string | null,
    dir: r.dir as string, filename: r.filename as string, size: r.size as number | null,
    downloaded: r.downloaded as number, status: r.status as DownloadRow['status'],
    categoryId: r.category_id as number | null, queueId: r.queue_id as number | null,
    headers: JSON.parse(r.headers_json as string) as Record<string, string>,
    error: r.error as string | null, attempts: r.attempts as number, retryAt: r.retry_at as number,
    queueOrder: r.queue_order as number, etag: r.etag as string | null,
    lastModified: r.last_modified as string | null, createdAt: r.created_at as number,
    completedAt: r.completed_at as number | null,
    kind: r.kind as DownloadRow['kind'], format: r.format as string | null,
  };
}

function toQueue(r: Row): QueueRow {
  return {
    id: r.id as number, name: r.name as string, kind: r.kind as QueueRow['kind'],
    maxParallel: r.max_parallel as number, startTime: r.start_time as string | null,
    stopTime: r.stop_time as string | null, days: r.days as number,
    afterAction: r.after_action as QueueRow['afterAction'],
  };
}

function toCategory(r: Row): CategoryRow {
  return {
    id: r.id as number, name: r.name as string,
    extensions: (r.extensions as string).split(' ').filter(Boolean),
    saveDir: r.save_dir as string | null,
  };
}
