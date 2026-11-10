import { abortReason, observeRejection } from './abort.js';

export interface ResourcePayload<T> {
  value: T;
  bytes: number;
}

export interface ResourceLease<T> {
  /** Resolves once. Releasing a pending lease rejects it with AbortError. */
  readonly value: Promise<T>;
  /** Releases this subscriber only. Safe to call more than once. */
  release(): void;
}

export interface ResourcePoolOptions<T> {
  /** Accounted resident bytes; active leases may temporarily exceed the budget. */
  maxBytes?: number;
  /** Idle entries expire on sweep/acquire/release, without one timer per asset. */
  idleMs?: number;
  dispose: (value: T) => void;
  now?: () => number;
  /** Cleanup failures never interrupt other releases or become unhandled promises. */
  onDisposeError?: (error: unknown) => void;
}

export interface AcquireOptions {
  signal?: AbortSignal;
}

export interface ResourcePoolStats {
  entries: number;
  loading: number;
  activeLeases: number;
  bytes: number;
  hits: number;
  misses: number;
  evictions: number;
}

interface Subscriber<T> {
  released: boolean;
  settled: boolean;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
  removeListener: () => void;
}

interface Entry<T> {
  key: string;
  controller: AbortController;
  state: 'loading' | 'ready' | 'removed';
  subscribers: Set<Subscriber<T>>;
  value?: T;
  bytes: number;
  unusedAt: number;
  lastUsed: number;
  order: number;
}

function limit(value: number, name: string): number {
  if (Number.isNaN(value) || value < 0 || (value !== Infinity && !Number.isFinite(value))) {
    throw new RangeError(`${name} must be non-negative or Infinity`);
  }
  return value;
}

/**
 * Single-flight resources with explicit subscriber ownership and a bounded idle
 * cache. This pool must exclusively own disposal of the values returned by load.
 * Referencing a key is not a lease; every acquired lease must eventually release.
 */
export class ResourcePool<T> {
  readonly #entries = new Map<string, Entry<T>>();
  readonly #disposeValueCallback: (value: T) => void;
  readonly #onDisposeError?: (error: unknown) => void;
  readonly #now: () => number;
  readonly #idleMs: number;
  #maxBytes: number;
  #bytes = 0;
  #activeLeases = 0;
  #hits = 0;
  #misses = 0;
  #evictions = 0;
  #order = 0;
  #disposed = false;
  #lastDisposalError: unknown;

  constructor(options: ResourcePoolOptions<T>) {
    if (typeof options.dispose !== 'function') throw new TypeError('ResourcePool requires a disposal function');
    this.#maxBytes = limit(options.maxBytes ?? 128 * 1024 * 1024, 'maxBytes');
    this.#idleMs = limit(options.idleMs ?? 30_000, 'idleMs');
    this.#disposeValueCallback = options.dispose;
    this.#onDisposeError = options.onDisposeError;
    this.#now = options.now ?? (() => performance.now());
  }

  get stats(): ResourcePoolStats {
    let loading = 0;
    for (const entry of this.#entries.values()) if (entry.state === 'loading') loading++;
    return {
      entries: this.#entries.size, loading, activeLeases: this.#activeLeases,
      bytes: this.#bytes, hits: this.#hits, misses: this.#misses, evictions: this.#evictions,
    };
  }

  /** Diagnostic for applications that do not register onDisposeError. */
  get lastDisposalError(): unknown { return this.#lastDisposalError; }

  acquire(
    key: string,
    load: (signal: AbortSignal) => Promise<ResourcePayload<T>>,
    options: AcquireOptions = {},
  ): ResourceLease<T> {
    if (typeof key !== 'string' || key.length === 0) throw new TypeError('Resource key must be non-empty');
    if (typeof load !== 'function') throw new TypeError('Resource load must be a function');
    if (this.#disposed) return this.#rejectedLease(new DOMException('ResourcePool is disposed', 'AbortError'));
    if (options.signal?.aborted) return this.#rejectedLease(abortReason(options.signal));
    this.sweep();

    let entry = this.#entries.get(key);
    const created = !entry;
    if (entry) this.#hits++;
    else {
      this.#misses++;
      const now = this.#now();
      entry = {
        key, controller: new AbortController(), state: 'loading', subscribers: new Set(),
        bytes: 0, unusedAt: now, lastUsed: now, order: this.#order++,
      };
      this.#entries.set(key, entry);
    }
    entry.lastUsed = this.#now();
    const lease = this.#subscribe(entry, options.signal);
    if (created) this.#start(entry, load);
    return lease;
  }

  /** Evict expired entries, then least-recently-used idle entries over budget. */
  sweep(): void {
    const now = this.#now();
    const unused: Entry<T>[] = [];
    for (const entry of this.#entries.values()) {
      if (entry.state !== 'ready' || entry.subscribers.size !== 0) continue;
      if (now - entry.unusedAt >= this.#idleMs) this.#remove(entry, true);
      else unused.push(entry);
    }
    if (this.#bytes <= this.#maxBytes) return;
    unused.sort((a, b) => a.lastUsed - b.lastUsed || a.order - b.order);
    for (const entry of unused) {
      if (this.#bytes <= this.#maxBytes) break;
      this.#remove(entry, true);
    }
  }

  setBudget(bytes: number): void {
    this.#maxBytes = limit(bytes, 'maxBytes');
    this.sweep();
  }

  /** End all leases and remove all cached values. Late loads dispose on arrival. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    const reason = new DOMException('ResourcePool is disposed', 'AbortError');
    for (const entry of [...this.#entries.values()]) {
      for (const subscriber of [...entry.subscribers]) this.#release(entry, subscriber, reason);
      this.#remove(entry, false);
    }
  }

  #rejectedLease(error: unknown): ResourceLease<T> {
    return { value: observeRejection(Promise.reject<T>(error)), release: () => undefined };
  }

  #subscribe(entry: Entry<T>, signal?: AbortSignal): ResourceLease<T> {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (error: unknown) => void;
    const value = observeRejection(new Promise<T>((res, rej) => { resolve = res; reject = rej; }));
    const subscriber: Subscriber<T> = {
      released: false, settled: false, resolve, reject, removeListener: () => undefined,
    };
    entry.subscribers.add(subscriber);
    this.#activeLeases++;
    if (signal) {
      const onAbort = () => this.#release(entry, subscriber, abortReason(signal));
      signal.addEventListener('abort', onAbort, { once: true });
      subscriber.removeListener = () => signal.removeEventListener('abort', onAbort);
      if (signal.aborted) onAbort();
    }
    if (!subscriber.released && entry.state === 'ready') {
      subscriber.settled = true;
      subscriber.resolve(entry.value as T);
    }
    return {
      value,
      release: () => this.#release(entry, subscriber, new DOMException('Resource lease released', 'AbortError')),
    };
  }

  #release(entry: Entry<T>, subscriber: Subscriber<T>, reason: unknown): void {
    if (subscriber.released) return;
    subscriber.released = true;
    subscriber.removeListener();
    entry.subscribers.delete(subscriber);
    this.#activeLeases--;
    if (!subscriber.settled) {
      subscriber.settled = true;
      subscriber.reject(reason);
    }
    if (entry.subscribers.size !== 0) return;
    if (entry.state === 'loading') this.#remove(entry, false);
    else if (entry.state === 'ready') {
      entry.unusedAt = this.#now();
      entry.lastUsed = entry.unusedAt;
      if (!this.#disposed) this.sweep();
    }
  }

  #start(entry: Entry<T>, load: (signal: AbortSignal) => Promise<ResourcePayload<T>>): void {
    const execution = Promise.resolve().then(() => {
      if (entry.controller.signal.aborted) throw abortReason(entry.controller.signal);
      return load(entry.controller.signal);
    });
    void execution.then(
      (result) => this.#loaded(entry, result),
      (error: unknown) => this.#failed(entry, error),
    );
  }

  #loaded(entry: Entry<T>, result: ResourcePayload<T>): void {
    if (typeof result !== 'object' || result === null || !('value' in result)) {
      this.#failed(entry, new TypeError('Resource load must return { value, bytes }'));
      return;
    }
    if (entry.state !== 'loading' || this.#entries.get(entry.key) !== entry || this.#disposed) {
      this.#disposeValue(result.value);
      return;
    }
    if (!Number.isSafeInteger(result.bytes) || result.bytes < 0) {
      this.#disposeValue(result.value);
      this.#failed(entry, new RangeError('Resource bytes must be a non-negative safe integer'));
      return;
    }
    entry.state = 'ready';
    entry.value = result.value;
    entry.bytes = result.bytes;
    this.#bytes += result.bytes;
    for (const subscriber of entry.subscribers) {
      subscriber.settled = true;
      subscriber.resolve(result.value);
    }
    this.sweep();
  }

  #failed(entry: Entry<T>, error: unknown): void {
    if (entry.state !== 'loading') return;
    for (const subscriber of [...entry.subscribers]) this.#release(entry, subscriber, error);
    this.#remove(entry, false);
  }

  #remove(entry: Entry<T>, eviction: boolean): void {
    if (entry.state === 'removed') return;
    const wasReady = entry.state === 'ready';
    const value = entry.value;
    entry.state = 'removed';
    if (this.#entries.get(entry.key) === entry) this.#entries.delete(entry.key);
    if (wasReady) {
      this.#bytes -= entry.bytes;
      entry.bytes = 0;
      entry.value = undefined;
      if (eviction) this.#evictions++;
      this.#disposeValue(value as T);
    } else entry.controller.abort(new DOMException('Resource has no active consumers', 'AbortError'));
  }

  #disposeValue(value: T): void {
    try { this.#disposeValueCallback(value); }
    catch (error) {
      this.#lastDisposalError = error;
      // Cleanup diagnostics must not keep unrelated resources or in-flight work alive.
      try { this.#onDisposeError?.(error); } catch { /* Preserve the original diagnostic. */ }
    }
  }
}
