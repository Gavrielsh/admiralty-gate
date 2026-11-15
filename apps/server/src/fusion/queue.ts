/**
 * Job queues for ingestion. Two implementations of one interface:
 *  - InlineQueue: in-process, sequential. The default without Redis, and what tests use.
 *  - BullQueue: BullMQ on Redis, so ingestion survives restarts and can be scaled out.
 */
import { Queue, Worker, type ConnectionOptions } from 'bullmq';

export const QUEUES = ['ingest-osint', 'geo-enrich', 'corroborate-cluster'] as const;
export type QueueName = (typeof QUEUES)[number];
export type Handlers = Record<QueueName, (data: unknown) => Promise<void>>;

export interface JobQueue {
  readonly kind: 'inline' | 'bullmq';
  add(name: QueueName, data: unknown): Promise<void>;
  /** Resolves when nothing is waiting or running. */
  idle(): Promise<void>;
  close(): Promise<void>;
}

export class InlineQueue implements JobQueue {
  readonly kind = 'inline' as const;
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;

  constructor(private readonly handlers: Handlers, private readonly onError: (name: QueueName, e: Error) => void = () => undefined) {}

  async add(name: QueueName, data: unknown): Promise<void> {
    this.pending++;
    this.tail = this.tail
      .then(() => this.handlers[name](data))
      .catch((e: Error) => this.onError(name, e))
      .finally(() => {
        this.pending--;
      });
  }

  async idle(): Promise<void> {
    // Handlers enqueue follow-up jobs, so wait until the chain stops growing.
    while (this.pending > 0) await this.tail;
  }

  async close(): Promise<void> {
    await this.idle();
  }
}

export function redisConnection(url: string): ConnectionOptions {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: Number(u.port || 6379),
    ...(u.username ? { username: decodeURIComponent(u.username) } : {}),
    ...(u.password ? { password: decodeURIComponent(u.password) } : {}),
    ...(u.pathname.length > 1 ? { db: Number(u.pathname.slice(1)) } : {}),
    ...(u.protocol === 'rediss:' ? { tls: {} } : {}),
    maxRetriesPerRequest: null,
  };
}

export class BullQueue implements JobQueue {
  readonly kind = 'bullmq' as const;
  private readonly queues = new Map<QueueName, Queue>();
  private readonly workers: Worker[] = [];

  constructor(redisUrl: string, handlers: Handlers, prefix = 'admiralty', onError: (name: QueueName, e: Error) => void = () => undefined) {
    const connection = redisConnection(redisUrl);
    for (const name of QUEUES) {
      this.queues.set(name, new Queue(name, { connection, prefix, defaultJobOptions: { removeOnComplete: 1000, removeOnFail: 1000, attempts: 3, backoff: { type: 'exponential', delay: 500 } } }));
      // One job at a time per queue: ingestion order decides which duplicate wins, and clustering reads what ingestion wrote.
      const w = new Worker(name, async job => handlers[name](job.data), { connection, prefix, concurrency: 1 });
      w.on('failed', (_job, e) => onError(name, e));
      this.workers.push(w);
    }
  }

  async add(name: QueueName, data: unknown): Promise<void> {
    await this.queues.get(name)!.add(name, data);
  }

  async idle(): Promise<void> {
    for (let quiet = 0; quiet < 2; ) {
      let busy = 0;
      for (const q of this.queues.values()) {
        const c = await q.getJobCounts('waiting', 'active', 'delayed', 'prioritized');
        busy += Object.values(c).reduce((a, b) => a + b, 0);
      }
      quiet = busy === 0 ? quiet + 1 : 0;
      if (quiet < 2) await new Promise(r => setTimeout(r, 25));
    }
  }

  /** Remove every key this queue set created in Redis (tests, or decommissioning a prefix). */
  async obliterate(): Promise<void> {
    for (const q of this.queues.values()) await q.obliterate({ force: true });
  }

  async close(): Promise<void> {
    await Promise.all(this.workers.map(w => w.close()));
    await Promise.all([...this.queues.values()].map(q => q.close()));
  }
}
