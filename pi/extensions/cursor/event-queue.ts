export interface EventQueueOptions {
  maxSize?: number;
  onOverflow?: () => void;
}

const DEFAULT_MAX_SIZE = 1024;

export class EventQueue<T> {
  private buffer: T[] = [];
  private waiters: Array<(value: T) => void> = [];
  private overflowed = false;
  private readonly maxSize: number;
  private readonly onOverflow?: () => void;

  constructor(options: EventQueueOptions = {}) {
    this.maxSize = options.maxSize ?? DEFAULT_MAX_SIZE;
    this.onOverflow = options.onOverflow;
  }

  push(value: T): void {
    if (this.overflowed) return;
    if (this.waiters.length > 0) {
      const w = this.waiters.shift()!;
      w(value);
      return;
    }
    if (this.buffer.length >= this.maxSize) {
      this.overflowed = true;
      this.onOverflow?.();
      return;
    }
    this.buffer.push(value);
  }

  pushForce(value: T): void {
    if (this.waiters.length > 0) {
      const w = this.waiters.shift()!;
      w(value);
      return;
    }
    this.buffer.push(value);
  }

  next(): Promise<T> {
    if (this.buffer.length > 0) {
      return Promise.resolve(this.buffer.shift()!);
    }
    return new Promise<T>((resolve) => this.waiters.push(resolve));
  }
}
