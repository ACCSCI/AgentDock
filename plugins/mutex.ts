/**
 * Per-key async mutex. Serializes async operations that share a key.
 * Zero external dependencies.
 */
export class Mutex {
  private queues = new Map<string, Promise<unknown>>();

  /**
   * Run `fn` exclusively for the given `key`.
   * If another task holds the key, `fn` waits until it completes.
   * A rejected predecessor does NOT block the queue.
   */
  async runExclusive<T>(key: string, fn: () => T | Promise<T>): Promise<T> {
    const prev = this.queues.get(key) ?? Promise.resolve();
    const task = prev.then(
      () => fn(),
      () => fn(),
    );
    const noop = task.then(
      () => {},
      () => {},
    );
    this.queues.set(key, noop);
    noop.finally(() => {
      if (this.queues.get(key) === noop) this.queues.delete(key);
    });
    return task;
  }
}
