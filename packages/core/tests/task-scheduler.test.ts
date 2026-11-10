import { describe, expect, it, vi } from 'vitest';
import { TaskScheduler } from '../src/index.js';
import { deferred, flush } from './helpers.js';

describe('TaskScheduler', () => {
  it('honors the concurrency cap and runs queued priorities in stable order', async () => {
    const scheduler = new TaskScheduler({ concurrency: 1 });
    const gate = deferred<void>();
    const first = scheduler.schedule(() => gate.promise);
    const order: string[] = [];
    const enqueue = (name: string, priority: number) => scheduler.schedule(async () => { order.push(name); }, { priority });
    const low = enqueue('low', 0);
    const high1 = enqueue('high-1', 10);
    const medium = enqueue('medium', 5);
    const high2 = enqueue('high-2', 10);
    expect(scheduler.stats).toEqual({ queued: 4, running: 1 });
    await flush();
    expect(order).toEqual([]);
    gate.resolve();
    await Promise.all([first, low, high1, medium, high2]);
    expect(order).toEqual(['high-1', 'high-2', 'medium', 'low']);
    expect(scheduler.stats).toEqual({ queued: 0, running: 0 });
    scheduler.dispose();
  });

  it('removes cancelled queued work without invoking it', async () => {
    const scheduler = new TaskScheduler({ concurrency: 1 });
    const gate = deferred<void>();
    const running = scheduler.schedule(() => gate.promise);
    const controller = new AbortController();
    const run = vi.fn(async () => 3);
    const cancelled = scheduler.schedule(run, { signal: controller.signal, priority: 100 });
    controller.abort('left view');
    await expect(cancelled).rejects.toBe('left view');
    expect(scheduler.stats).toEqual({ queued: 0, running: 1 });
    gate.resolve();
    await running;
    expect(run).not.toHaveBeenCalled();
    scheduler.dispose();
  });

  it('rejects active cancellation promptly but retains its slot until work actually stops', async () => {
    const scheduler = new TaskScheduler({ concurrency: 1 });
    const uncooperative = deferred<string>();
    const controller = new AbortController();
    let workSignal!: AbortSignal;
    const cancelled = scheduler.schedule((signal) => { workSignal = signal; return uncooperative.promise; }, { signal: controller.signal });
    const nextRun = vi.fn(async () => 'next');
    const next = scheduler.schedule(nextRun);
    await flush();
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
    expect(workSignal.aborted).toBe(true);
    expect(nextRun).not.toHaveBeenCalled();
    expect(scheduler.stats).toEqual({ running: 1, queued: 1 });
    uncooperative.resolve('discarded');
    expect(await next).toBe('next');
    expect(scheduler.stats.running).toBe(0);
    scheduler.dispose();
  });

  it('rejects queued and active work on disposal and never starts another task', async () => {
    const scheduler = new TaskScheduler({ concurrency: 1 });
    const gate = deferred<void>();
    const active = scheduler.schedule(() => gate.promise);
    const queuedRun = vi.fn(async () => 2);
    const queued = scheduler.schedule(queuedRun);
    await flush();
    scheduler.dispose();
    scheduler.dispose();
    await expect(active).rejects.toMatchObject({ name: 'AbortError' });
    await expect(queued).rejects.toMatchObject({ name: 'AbortError' });
    gate.resolve();
    await flush();
    expect(queuedRun).not.toHaveBeenCalled();
    expect(scheduler.stats).toEqual({ queued: 0, running: 0 });
    await expect(scheduler.schedule(async () => 1)).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('recovers slots after synchronous throws and skips pre-aborted requests', async () => {
    const scheduler = new TaskScheduler({ concurrency: 1 });
    const run = vi.fn(async () => 1);
    await expect(scheduler.schedule(run, { signal: AbortSignal.abort('skip') })).rejects.toBe('skip');
    expect(run).not.toHaveBeenCalled();
    const failure = scheduler.schedule(() => { throw new Error('bad task'); });
    const success = scheduler.schedule(async () => 42);
    await expect(failure).rejects.toThrow('bad task');
    expect(await success).toBe(42);
    expect(scheduler.stats).toEqual({ queued: 0, running: 0 });
    scheduler.dispose();
  });

  it('gives old low-priority tasks a bounded fairness slot under sustained contention', async () => {
    const scheduler = new TaskScheduler({ concurrency: 1 });
    const gate = deferred<void>();
    const running = scheduler.schedule(() => gate.promise);
    const order: string[] = [];
    const oldest = scheduler.schedule(async () => { order.push('old'); }, { priority: -100 });
    const newer = Array.from({ length: 50 }, (_, index) => scheduler.schedule(async () => {
      order.push(`high-${index}`);
    }, { priority: 100 }));
    gate.resolve();
    await Promise.all([running, oldest, ...newer]);
    expect(order.indexOf('old')).toBe(32);
    scheduler.dispose();
  });

  it('rejects invalid scheduling settings', () => {
    expect(() => new TaskScheduler({ concurrency: 0 })).toThrow(RangeError);
    const scheduler = new TaskScheduler();
    expect(() => scheduler.schedule(async () => 1, { priority: NaN })).toThrow(RangeError);
    scheduler.dispose();
  });

  it('preserves an explicitly null abort reason', async () => {
    const scheduler = new TaskScheduler();
    await expect(scheduler.schedule(async () => 1, { signal: AbortSignal.abort(null) })).rejects.toBeNull();
    scheduler.dispose();
  });

  it('disposes a successful result if the caller cancels before result delivery', async () => {
    const scheduler = new TaskScheduler({ concurrency: 1 });
    const result = deferred<{ name: string }>();
    const controller = new AbortController();
    const onDiscard = vi.fn();
    const value = { name: 'parsed GPU resources' };
    const request = scheduler.schedule(() => result.promise, { signal: controller.signal, onDiscard });
    await flush();
    // Fulfillment queues delivery, but cancellation can still win before its microtask runs.
    result.resolve(value);
    controller.abort();
    await expect(request).rejects.toMatchObject({ name: 'AbortError' });
    await flush();
    expect(onDiscard).toHaveBeenCalledExactlyOnceWith(value);
    expect(scheduler.stats).toEqual({ queued: 0, running: 0 });
    scheduler.dispose();
    expect(onDiscard).toHaveBeenCalledTimes(1);
  });

  it('does not discard delivered results or failed work, and continues after cleanup failures', async () => {
    const scheduler = new TaskScheduler({ concurrency: 1 });
    const onDiscard = vi.fn();
    expect(await scheduler.schedule(async () => 2, { onDiscard })).toBe(2);
    await expect(scheduler.schedule(async () => { throw new Error('parse failed'); }, { onDiscard }))
      .rejects.toThrow('parse failed');
    expect(onDiscard).not.toHaveBeenCalled();

    const result = deferred<number>();
    const controller = new AbortController();
    const cleanupFailure = new Error('cleanup failed');
    const cancelled = scheduler.schedule(() => result.promise, {
      signal: controller.signal,
      onDiscard() { throw cleanupFailure; },
    });
    await flush();
    controller.abort();
    const next = scheduler.schedule(async () => 3);
    result.resolve(1);
    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
    expect(await next).toBe(3);
    expect(scheduler.lastDiscardError).toBe(cleanupFailure);
    scheduler.dispose();
  });
});
