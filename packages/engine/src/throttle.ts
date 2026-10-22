/** Shared token bucket. `take` resolves once `n` bytes may be consumed. */
export class Throttle {
  private tokens: number;
  private last = Date.now();

  constructor(private bytesPerSecond: number) {
    this.tokens = bytesPerSecond;
  }

  setRate(bytesPerSecond: number): void {
    this.bytesPerSecond = bytesPerSecond;
  }

  async take(n: number, signal?: AbortSignal): Promise<void> {
    if (this.bytesPerSecond <= 0) return;
    for (;;) {
      this.refill();
      if (this.tokens >= Math.min(n, this.bytesPerSecond)) {
        this.tokens -= Math.min(n, this.bytesPerSecond);
        return;
      }
      if (signal?.aborted) return;
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  private refill(): void {
    const now = Date.now();
    this.tokens = Math.min(this.bytesPerSecond, this.tokens + ((now - this.last) / 1000) * this.bytesPerSecond);
    this.last = now;
  }
}
