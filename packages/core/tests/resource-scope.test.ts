import { describe, expect, it, vi } from 'vitest';
import { ResourceScope } from '../src/index.js';

describe('ResourceScope', () => {
  it('owns leases and releases unique resources once in reverse acquisition order', () => {
    const released: string[] = [];
    const scope = new ResourceScope();
    const a = { release: () => released.push('a') };
    const b = { release: () => released.push('b') };
    expect(scope.add(a)).toBe(a);
    scope.add(a);
    scope.add(b);
    expect(scope.size).toBe(2);
    scope.dispose();
    scope.release();
    expect(released).toEqual(['b', 'a']);
    expect(scope.size).toBe(0);
    expect(scope.disposed).toBe(true);
  });

  it('finishes all cleanup before surfacing failures and releases a late addition', () => {
    const scope = new ResourceScope();
    const release = vi.fn();
    scope.add({ release });
    scope.add({ release() { throw new Error('bad release'); } });
    expect(() => scope.dispose()).toThrow(AggregateError);
    expect(release).toHaveBeenCalledTimes(1);
    const late = vi.fn();
    expect(() => scope.add({ release: late })).toThrow('disposed');
    expect(late).toHaveBeenCalledTimes(1);
  });
});
