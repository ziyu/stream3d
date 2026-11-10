import { describe, expect, it, vi } from 'vitest';
import { ResourcePool, type ResourcePayload } from '../src/index.js';
import { deferred, flush } from './helpers.js';

describe('ResourcePool', () => {
  it('shares one load and value while accounting independent, idempotent leases', async () => {
    const dispose = vi.fn();
    const resource = { name: 'shared texture' };
    const load = vi.fn(async () => ({ value: resource, bytes: 12 }));
    const pool = new ResourcePool({ dispose, maxBytes: 100 });
    const a = pool.acquire('texture', load);
    const b = pool.acquire('texture', load);
    expect(await a.value).toBe(resource);
    expect(await b.value).toBe(resource);
    expect(load).toHaveBeenCalledTimes(1);
    expect(pool.stats).toMatchObject({ entries: 1, loading: 0, bytes: 12, activeLeases: 2, hits: 1, misses: 1 });
    a.release();
    a.release();
    expect(pool.stats.activeLeases).toBe(1);
    b.release();
    const cached = pool.acquire('texture', load);
    expect(await cached.value).toBe(resource);
    expect(load).toHaveBeenCalledTimes(1);
    expect(dispose).not.toHaveBeenCalled();
    cached.release();
    pool.dispose();
    pool.dispose();
    expect(dispose).toHaveBeenCalledExactlyOnceWith(resource);
    expect(pool.stats).toMatchObject({ entries: 0, bytes: 0, activeLeases: 0 });
  });

  it('cancels one subscriber without aborting shared work needed by another', async () => {
    const result = deferred<ResourcePayload<string>>();
    let workSignal!: AbortSignal;
    const load = vi.fn((signal: AbortSignal) => { workSignal = signal; return result.promise; });
    const pool = new ResourcePool<string>({ dispose: vi.fn() });
    const controller = new AbortController();
    const a = pool.acquire('mesh', load, { signal: controller.signal });
    const b = pool.acquire('mesh', load);
    await flush();
    const reason = new Error('view A left');
    controller.abort(reason);
    await expect(a.value).rejects.toBe(reason);
    expect(workSignal.aborted).toBe(false);
    expect(pool.stats.activeLeases).toBe(1);
    result.resolve({ value: 'mesh data', bytes: 20 });
    expect(await b.value).toBe('mesh data');
    pool.dispose();
  });

  it('aborts the last pending consumer and disposes a late result without replacing a newer load', async () => {
    const oldResult = deferred<ResourcePayload<string>>();
    const dispose = vi.fn();
    let oldSignal!: AbortSignal;
    const pool = new ResourcePool<string>({ dispose });
    const oldLease = pool.acquire('same-key', (signal) => { oldSignal = signal; return oldResult.promise; });
    await flush();
    oldLease.release();
    await expect(oldLease.value).rejects.toMatchObject({ name: 'AbortError' });
    expect(oldSignal.aborted).toBe(true);
    expect(pool.stats).toMatchObject({ entries: 0, loading: 0, activeLeases: 0 });

    const newLease = pool.acquire('same-key', async () => ({ value: 'new', bytes: 4 }));
    expect(await newLease.value).toBe('new');
    oldResult.resolve({ value: 'old', bytes: 9 });
    await flush();
    expect(dispose).toHaveBeenCalledExactlyOnceWith('old');
    expect(pool.stats).toMatchObject({ entries: 1, bytes: 4, activeLeases: 1 });
    pool.dispose();
    expect(dispose.mock.calls.map(([value]) => value)).toEqual(['old', 'new']);
  });

  it('does not start an immediately released load and safely observes discarded cancellation', async () => {
    const load = vi.fn(async () => ({ value: 'unused', bytes: 10 }));
    const pool = new ResourcePool<string>({ dispose: vi.fn() });
    const lease = pool.acquire('unused', load);
    lease.release();
    await flush();
    expect(load).not.toHaveBeenCalled();
    expect(pool.stats).toMatchObject({ loading: 0, activeLeases: 0, entries: 0 });
    // The caller can deliberately ignore a cancelled promise without an unhandled rejection.
    pool.dispose();
  });

  it('releases failed requests and allows a clean retry of the same key', async () => {
    const error = new Error('network failed');
    const pool = new ResourcePool<string>({ dispose: vi.fn() });
    const load = vi.fn(async () => { throw error; });
    const a = pool.acquire('key', load);
    const b = pool.acquire('key', load);
    await expect(a.value).rejects.toBe(error);
    await expect(b.value).rejects.toBe(error);
    expect(pool.stats).toMatchObject({ entries: 0, activeLeases: 0, bytes: 0 });
    a.release();
    b.release();
    const retry = pool.acquire('key', async () => ({ value: 'recovered', bytes: 2 }));
    expect(await retry.value).toBe('recovered');
    pool.dispose();
  });

  it('protects active resources even over budget and evicts on the final release', async () => {
    const dispose = vi.fn();
    const pool = new ResourcePool<string>({ maxBytes: 10, dispose });
    const a = pool.acquire('a', async () => ({ value: 'a', bytes: 8 }));
    const b = pool.acquire('b', async () => ({ value: 'b', bytes: 8 }));
    await Promise.all([a.value, b.value]);
    expect(pool.stats.bytes).toBe(16);
    expect(dispose).not.toHaveBeenCalled();
    pool.sweep();
    expect(dispose).not.toHaveBeenCalled();
    a.release();
    expect(dispose).toHaveBeenCalledExactlyOnceWith('a');
    expect(pool.stats.bytes).toBe(8);
    pool.setBudget(0);
    expect(pool.stats.bytes).toBe(8);
    b.release();
    expect(pool.stats).toMatchObject({ bytes: 0, entries: 0, evictions: 2 });
    pool.dispose();
  });

  it('evicts least recently used idle entries, with a cache hit renewing recency', async () => {
    let now = 0;
    const dispose = vi.fn();
    const pool = new ResourcePool<string>({ maxBytes: 100, dispose, now: () => now });
    const loadA = vi.fn(async () => ({ value: 'a', bytes: 5 }));
    const a = pool.acquire('a', loadA);
    await a.value;
    a.release();
    now = 1;
    const b = pool.acquire('b', async () => ({ value: 'b', bytes: 5 }));
    await b.value;
    b.release();
    now = 2;
    const again = pool.acquire('a', loadA);
    await again.value;
    again.release();
    pool.setBudget(5);
    expect(dispose).toHaveBeenCalledExactlyOnceWith('b');
    expect(loadA).toHaveBeenCalledTimes(1);
    expect(pool.stats.bytes).toBe(5);
    pool.dispose();
  });

  it('expires idle entries on sweep but does not expire active leases', async () => {
    let now = 0;
    const dispose = vi.fn();
    const pool = new ResourcePool<string>({ idleMs: 50, dispose, now: () => now });
    const idle = pool.acquire('idle', async () => ({ value: 'idle', bytes: 1 }));
    const active = pool.acquire('active', async () => ({ value: 'active', bytes: 1 }));
    await Promise.all([idle.value, active.value]);
    idle.release();
    now = 49;
    pool.sweep();
    expect(dispose).not.toHaveBeenCalled();
    now = 50;
    pool.sweep();
    expect(dispose).toHaveBeenCalledExactlyOnceWith('idle');
    expect(pool.stats.activeLeases).toBe(1);
    active.release();
    now = 100;
    pool.sweep();
    expect(pool.stats.entries).toBe(0);
    pool.dispose();
  });

  it('disposes settled and late values exactly once when the whole pool is destroyed', async () => {
    const pending = deferred<ResourcePayload<string>>();
    const dispose = vi.fn();
    const pool = new ResourcePool<string>({ dispose });
    const ready = pool.acquire('ready', async () => ({ value: 'ready', bytes: 3 }));
    const loading = pool.acquire('loading', () => pending.promise);
    await ready.value;
    pool.dispose();
    pool.dispose();
    await expect(loading.value).rejects.toMatchObject({ name: 'AbortError' });
    expect(pool.stats).toMatchObject({ entries: 0, activeLeases: 0, bytes: 0 });
    pending.resolve({ value: 'late', bytes: 2 });
    await flush();
    expect(dispose.mock.calls.map(([value]) => value)).toEqual(['ready', 'late']);
    ready.release();
    loading.release();
    expect(pool.stats.activeLeases).toBe(0);
    await expect(pool.acquire('closed', async () => ({ value: 'bad', bytes: 1 })).value)
      .rejects.toMatchObject({ name: 'AbortError' });
  });

  it('rejects invalid accounting and disposes the produced resource', async () => {
    const dispose = vi.fn();
    const pool = new ResourcePool<string>({ dispose });
    const bad = pool.acquire('bad', async () => ({ value: 'invalid', bytes: NaN }));
    await expect(bad.value).rejects.toThrow('bytes');
    expect(dispose).toHaveBeenCalledExactlyOnceWith('invalid');
    expect(pool.stats).toMatchObject({ entries: 0, bytes: 0, activeLeases: 0 });
    pool.dispose();
  });

  it('skips pre-aborted acquisition and releases a settled subscriber on abort', async () => {
    const signal = AbortSignal.abort('already gone');
    const load = vi.fn(async () => ({ value: 'value', bytes: 1 }));
    const pool = new ResourcePool<string>({ dispose: vi.fn(), idleMs: 0 });
    await expect(pool.acquire('a', load, { signal }).value).rejects.toBe('already gone');
    expect(pool.stats.misses).toBe(0);
    expect(load).not.toHaveBeenCalled();
    const controller = new AbortController();
    const lease = pool.acquire('a', load, { signal: controller.signal });
    expect(await lease.value).toBe('value');
    controller.abort();
    expect(pool.stats).toMatchObject({ activeLeases: 0, entries: 0, bytes: 0 });
    pool.dispose();
  });

  it('continues deterministic cleanup when a disposal callback fails', async () => {
    const failure = new Error('failed disposal');
    const seen: string[] = [];
    const onDisposeError = vi.fn();
    const pool = new ResourcePool<string>({
      dispose(value) { seen.push(value); if (value === 'a') throw failure; },
      onDisposeError,
    });
    const a = pool.acquire('a', async () => ({ value: 'a', bytes: 1 }));
    const b = pool.acquire('b', async () => ({ value: 'b', bytes: 1 }));
    await Promise.all([a.value, b.value]);
    expect(() => pool.dispose()).not.toThrow();
    expect(seen).toEqual(['a', 'b']);
    expect(pool.lastDisposalError).toBe(failure);
    expect(onDisposeError).toHaveBeenCalledExactlyOnceWith(failure);
    expect(pool.stats).toMatchObject({ bytes: 0, entries: 0, activeLeases: 0 });
  });
});
