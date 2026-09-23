/**
 * Bounded job queue. Enforces MAX_CONCURRENT_JOBS and an overall job timeout so
 * no agent run, build or test can occupy the server forever.
 */
import { config } from '../config/index.ts';
import { logger } from '../lib/logger.ts';

export interface Job<T> {
  id: string;
  run: (signal: AbortSignal) => Promise<T>;
  timeoutMs: number;
}

interface QueuedJob {
  id: string;
  enqueuedAt: number;
  start: () => void;
}

export class JobQueue {
  private readonly running = new Map<string, AbortController>();
  private readonly queue: QueuedJob[] = [];
  private readonly maxConcurrent: number;

  constructor(maxConcurrent: number = config.maxConcurrentJobs) {
    this.maxConcurrent = Math.max(1, maxConcurrent);
  }

  public get active(): number {
    return this.running.size;
  }

  public get pending(): number {
    return this.queue.length;
  }

  public isRunning(id: string): boolean {
    return this.running.has(id);
  }

  public async submit<T>(job: Job<T>): Promise<T> {
    const controller = new AbortController();

    if (this.running.size >= this.maxConcurrent) {
      await new Promise<void>((resolve) => {
        this.queue.push({ id: job.id, enqueuedAt: Date.now(), start: resolve });
        logger.info('job queued', { jobId: job.id, queueDepth: this.queue.length });
      });
    }

    this.running.set(job.id, controller);
    let timer: NodeJS.Timeout | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort(new Error(`job ${job.id} exceeded timeout of ${job.timeoutMs}ms`));
          reject(new Error(`JOB_TIMEOUT: ${job.id} exceeded ${job.timeoutMs}ms`));
        }, job.timeoutMs);
      });
      return await Promise.race([job.run(controller.signal), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
      this.running.delete(job.id);
      const next = this.queue.shift();
      if (next) next.start();
    }
  }

  public cancel(id: string): boolean {
    const controller = this.running.get(id);
    if (!controller) return false;
    controller.abort(new Error('cancelled by user'));
    return true;
  }

  public cancelAll(): void {
    for (const controller of this.running.values()) {
      controller.abort(new Error('server shutting down'));
    }
  }
}

export const jobQueue = new JobQueue();
