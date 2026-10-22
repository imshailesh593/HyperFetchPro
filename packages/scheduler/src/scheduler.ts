import { EventEmitter } from 'node:events';
import type { AfterAction, QueueRow, Store } from '@dm/store';
import type { DownloadManager, Outcome } from './manager.js';

export interface SchedulerOptions {
  now?: () => Date;
  /** How often schedules are checked. */
  tickMs?: number;
  /** Delay before a failed download is retried. */
  retryDelayMs?: number;
  /** After this many failures a download stays failed instead of re-queuing. */
  maxQueueAttempts?: number;
}

/**
 * Runs queues: starts up to `maxParallel` downloads per queue, sends failures to the back
 * of the queue to retry later, and starts/stops queues at their scheduled times.
 *
 * Events: 'queueStarted' (queueId), 'queueStopped' (queueId), 'queueFinished' (queueId, AfterAction).
 */
export class Scheduler extends EventEmitter {
  private running = new Set<number>();
  private lastFired = new Map<string, string>();
  private retryTimers = new Map<number, NodeJS.Timeout>();
  private tickTimer: NodeJS.Timeout | null = null;
  private readonly now: () => Date;
  private readonly retryDelayMs: number;
  private readonly maxAttempts: number;

  constructor(
    private readonly store: Store,
    private readonly manager: DownloadManager,
    private readonly options: SchedulerOptions = {},
  ) {
    super();
    this.now = options.now ?? (() => new Date());
    this.retryDelayMs = options.retryDelayMs ?? 30_000;
    this.maxAttempts = options.maxQueueAttempts ?? 20;
    manager.on('finished', (id: number, outcome: Outcome) => this.onFinished(id, outcome));
  }

  /** Begin watching schedules. */
  start(): void {
    if (this.tickTimer) return;
    this.tickTimer = setInterval(() => this.tick(), this.options.tickMs ?? 15_000);
    this.tickTimer.unref();
  }

  dispose(): void {
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = null;
    for (const t of this.retryTimers.values()) clearTimeout(t);
    this.retryTimers.clear();
  }

  isRunning(queueId: number): boolean {
    return this.running.has(queueId);
  }

  /** Start a queue now. Paused/failed items (and everything in a sync queue) are queued again. */
  startQueue(queueId: number): void {
    const queue = this.store.getQueue(queueId);
    if (!queue || this.running.has(queueId)) return;
    for (const d of this.store.listDownloads({ queueId })) {
      const rerun = d.status === 'paused' || d.status === 'failed' || (queue.kind === 'sync' && d.status === 'completed');
      if (rerun) this.store.updateDownload(d.id, { status: 'queued', attempts: 0, retryAt: 0, error: null });
    }
    this.running.add(queueId);
    this.emit('queueStarted', queueId);
    this.fill(queueId);
  }

  /** Stop a queue; its running downloads are paused and can resume on the next start. */
  stopQueue(queueId: number): void {
    if (!this.running.delete(queueId)) return;
    this.clearRetryTimer(queueId);
    for (const d of this.store.listDownloads({ queueId, status: 'running' })) this.manager.pause(d.id);
    this.emit('queueStopped', queueId);
  }

  /** Check start/stop times. Called by the timer; exposed so tests can drive it. */
  tick(): void {
    const now = this.now();
    const hhmm = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
    const day = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()} ${hhmm}`;
    for (const q of this.store.listQueues()) {
      if (!(q.days & (1 << now.getDay()))) continue;
      if (q.startTime === hhmm && this.fireOnce(q, 'start', day)) this.startQueue(q.id);
      if (q.stopTime === hhmm && this.fireOnce(q, 'stop', day)) this.stopQueue(q.id);
    }
  }

  // --- internals -----------------------------------------------------------

  private fireOnce(q: QueueRow, kind: 'start' | 'stop', stamp: string): boolean {
    const key = `${q.id}:${kind}`;
    if (this.lastFired.get(key) === stamp) return false;
    this.lastFired.set(key, stamp);
    return true;
  }

  private fill(queueId: number): void {
    const queue = this.store.getQueue(queueId);
    if (!queue || !this.running.has(queueId)) return;
    const nowMs = this.now().getTime();
    let slots = queue.maxParallel - this.store.listDownloads({ queueId, status: 'running' }).length;
    while (slots-- > 0) {
      const next = this.store.nextQueued(queueId, nowMs);
      if (!next) break;
      this.manager.start(next.id);
    }
    this.checkFinished(queue);
  }

  private checkFinished(queue: QueueRow): void {
    const pending = this.store.listDownloads({ queueId: queue.id }).filter((d) => d.status === 'queued' || d.status === 'running');
    if (pending.length === 0) {
      this.running.delete(queue.id);
      this.clearRetryTimer(queue.id);
      this.emit('queueFinished', queue.id, queue.afterAction satisfies AfterAction);
      return;
    }
    if (!pending.some((d) => d.status === 'running')) this.armRetryTimer(queue.id, Math.min(...pending.map((d) => d.retryAt)));
  }

  private onFinished(id: number, outcome: Outcome): void {
    const row = this.store.getDownload(id);
    if (!row || row.queueId == null) return;
    const queueId = row.queueId;

    if (outcome === 'completed' && this.store.getQueue(queueId)?.kind === 'download') {
      this.store.updateDownload(id, { queueId: null }); // finished downloads leave the download queue
    } else if (outcome === 'failed' && this.running.has(queueId) && row.attempts < this.maxAttempts) {
      this.store.updateDownload(id, { status: 'queued', retryAt: this.now().getTime() + this.retryDelayMs });
      this.store.moveToBack(id);
    }
    this.fill(queueId);
  }

  private armRetryTimer(queueId: number, retryAt: number): void {
    this.clearRetryTimer(queueId);
    const delay = Math.max(0, retryAt - this.now().getTime());
    const t = setTimeout(() => {
      this.retryTimers.delete(queueId);
      this.fill(queueId);
    }, delay);
    t.unref();
    this.retryTimers.set(queueId, t);
  }

  private clearRetryTimer(queueId: number): void {
    const t = this.retryTimers.get(queueId);
    if (t) clearTimeout(t);
    this.retryTimers.delete(queueId);
  }
}

const pad = (n: number): string => String(n).padStart(2, '0');
