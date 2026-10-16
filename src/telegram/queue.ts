/** mtcute emits synchronously. This bounded queue explicitly awaits the durable sink. */
export class AwaitedQueue<T> {
  private readonly items: T[] = [];
  private active: Promise<void> | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private gap = false;
  constructor(private readonly sink: (event: T) => Promise<void>, private readonly onGap: () => Promise<void>, private readonly capacity = 512) {}
  get size(): number { return this.items.length; }
  get requiresReplay(): boolean { return this.gap; }
  push(event: T): void {
    if (this.closed) return;
    if (this.items.length >= this.capacity) { this.gap = true; this.pump(); return; }
    this.items.push(event); this.pump();
  }
  private pump(): void {
    if (this.active || this.retry || this.closed) return;
    this.active = (async () => {
      while (!this.closed && (this.items.length || this.gap)) {
        try {
          if (this.gap) { this.gap = false; await this.onGap(); }
          if (this.items.length) { await this.sink(this.items[0]!); this.items.shift(); }
        } catch {
          this.gap = true;
          this.retry = setTimeout(() => { this.retry = null; this.pump(); }, 1_000); this.retry.unref();
          return;
        }
      }
    })().finally(() => { this.active = null; });
  }
  async flush(timeoutMs = 10_000): Promise<boolean> {
    const end = Date.now() + timeoutMs;
    while (this.items.length || this.active || this.gap) {
      this.pump(); if (Date.now() >= end) return false;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return true;
  }
  async close(): Promise<void> { this.closed = true; if (this.retry) clearTimeout(this.retry); await this.active; }
}
