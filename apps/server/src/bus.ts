/** In-memory event bus with a bounded backlog, so a browser that connects late still sees recent history. */
export interface GateEvent {
  seq: number;
  at: number;
  type: string;
  data: unknown;
}

export class EventBus {
  private seq = 0;
  private readonly backlog: GateEvent[] = [];
  private readonly listeners = new Set<(e: GateEvent) => void>();

  constructor(private readonly keep = 1000, private readonly clock: () => number = () => Date.now()) {}

  emit(type: string, data: unknown): GateEvent {
    // Snapshot: later mutation of a live record must not rewrite history already sent.
    const e: GateEvent = { seq: ++this.seq, at: this.clock(), type, data: JSON.parse(JSON.stringify(data ?? null)) as unknown };
    this.backlog.push(e);
    if (this.backlog.length > this.keep) this.backlog.shift();
    for (const l of this.listeners) l(e);
    return e;
  }

  since(seq = 0): GateEvent[] {
    return this.backlog.filter(e => e.seq > seq);
  }

  subscribe(fn: (e: GateEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}
