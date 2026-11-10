import { abortReason, observeRejection } from './abort.js';

export interface TaskSchedulerOptions {
  concurrency?: number;
}

export interface ScheduleOptions<T = unknown> {
  /** Larger numbers run first. Equal priorities preserve enqueue order. */
  priority?: number;
  signal?: AbortSignal;
  /** Dispose a successful result that arrives after this caller was cancelled. */
  onDiscard?: (value: T) => void;
}

export interface TaskSchedulerStats {
  queued: number;
  /** Includes aborted work until its implementation actually stops. */
  running: number;
}

interface Task {
  order: number;
  priority: number;
  controller: AbortController;
  state: 'queued' | 'running' | 'finished';
  delivered: boolean;
  run: (signal: AbortSignal) => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  removeListener: () => void;
  onDiscard?: (value: unknown) => void;
}

/**
 * A bounded cooperative task queue. Queued tasks use priority order, with one
 * oldest-task slot every 32 contested dispatches to avoid perpetual starvation.
 * Aborting a task rejects its caller promptly but does not free its running slot
 * until the task settles: an uncooperative task cannot defeat the concurrency cap.
 */
export class TaskScheduler {
  readonly #concurrency: number;
  readonly #queue: Task[] = [];
  readonly #running = new Set<Task>();
  #order = 0;
  #priorityDispatches = 0;
  #disposed = false;
  #lastDiscardError: unknown;

  constructor(options: TaskSchedulerOptions = {}) {
    const concurrency = options.concurrency ?? 4;
    if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
      throw new RangeError('TaskScheduler concurrency must be a positive safe integer');
    }
    this.#concurrency = concurrency;
  }

  get stats(): TaskSchedulerStats {
    return { queued: this.#queue.length, running: this.#running.size };
  }

  /** Most recent onDiscard cleanup failure; failures never stall the task queue. */
  get lastDiscardError(): unknown { return this.#lastDiscardError; }

  schedule<T>(run: (signal: AbortSignal) => Promise<T>, options: ScheduleOptions<T> = {}): Promise<T> {
    if (typeof run !== 'function') throw new TypeError('TaskScheduler requires a task function');
    const priority = options.priority ?? 0;
    if (!Number.isFinite(priority)) throw new RangeError('Task priority must be finite');
    if (this.#disposed) {
      return observeRejection(Promise.reject(new DOMException('TaskScheduler is disposed', 'AbortError')));
    }
    if (options.signal?.aborted) return observeRejection(Promise.reject(abortReason(options.signal)));

    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason: unknown) => void;
    const promise = observeRejection(new Promise<T>((res, rej) => { resolve = res; reject = rej; }));
    const task: Task = {
      order: this.#order++, priority, controller: new AbortController(),
      state: 'queued', delivered: false, run,
      resolve: (value) => resolve(value as T), reject, removeListener: () => undefined,
      onDiscard: options.onDiscard ? (value) => options.onDiscard!(value as T) : undefined,
    };
    if (options.signal) {
      const signal = options.signal;
      const onAbort = () => this.#cancel(task, abortReason(signal));
      signal.addEventListener('abort', onAbort, { once: true });
      task.removeListener = () => signal.removeEventListener('abort', onAbort);
    }
    this.#queue.push(task);
    this.#pump();
    return promise;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    const reason = new DOMException('TaskScheduler is disposed', 'AbortError');
    for (const task of [...this.#queue, ...this.#running]) this.#cancel(task, reason);
  }

  #cancel(task: Task, reason: unknown): void {
    if (task.state === 'finished' || task.delivered) return;
    task.delivered = true;
    task.removeListener();
    task.reject(reason);
    if (task.state === 'queued') {
      const index = this.#queue.indexOf(task);
      if (index >= 0) this.#queue.splice(index, 1);
      task.state = 'finished';
    }
    task.controller.abort(reason);
  }

  #pump(): void {
    while (!this.#disposed && this.#running.size < this.#concurrency && this.#queue.length > 0) {
      let index = 0;
      const oldestSlot = this.#priorityDispatches >= 32;
      for (let candidate = 1; candidate < this.#queue.length; candidate++) {
        const current = this.#queue[index]!;
        const next = this.#queue[candidate]!;
        if (oldestSlot ? next.order < current.order :
          next.priority > current.priority || (next.priority === current.priority && next.order < current.order)) {
          index = candidate;
        }
      }
      if (oldestSlot) this.#priorityDispatches = 0;
      else if (this.#queue.length > 1) this.#priorityDispatches++;
      const task = this.#queue.splice(index, 1)[0]!;
      task.state = 'running';
      this.#running.add(task);
      const execution = Promise.resolve().then(() => {
        if (task.controller.signal.aborted) throw abortReason(task.controller.signal);
        return task.run(task.controller.signal);
      });
      void execution.then(
        (value) => this.#finish(task, true, value),
        (error: unknown) => this.#finish(task, false, error),
      );
    }
    if (this.#queue.length === 0) this.#priorityDispatches = 0;
  }

  #finish(task: Task, success: boolean, value: unknown): void {
    task.state = 'finished';
    this.#running.delete(task);
    task.removeListener();
    if (!task.delivered) {
      task.delivered = true;
      if (success) task.resolve(value);
      else task.reject(value);
    } else if (success && task.onDiscard) {
      try { task.onDiscard(value); }
      catch (error) { this.#lastDiscardError = error; }
    }
    this.#pump();
  }
}
