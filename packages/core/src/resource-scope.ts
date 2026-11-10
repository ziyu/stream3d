export interface Releasable {
  release(): void;
}

/** Own a collection of leases and release them together, once, in reverse order. */
export class ResourceScope implements Releasable {
  readonly #resources = new Set<Releasable>();
  #disposed = false;

  get size(): number { return this.#resources.size; }
  get disposed(): boolean { return this.#disposed; }

  add<T extends Releasable>(resource: T): T {
    if (this.#disposed) {
      resource.release();
      throw new Error('Cannot add a resource to a disposed ResourceScope');
    }
    this.#resources.add(resource);
    return resource;
  }

  release(): void { this.dispose(); }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    const resources = [...this.#resources].reverse();
    this.#resources.clear();
    const errors: unknown[] = [];
    for (const resource of resources) {
      try { resource.release(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, 'ResourceScope cleanup failed');
  }
}
