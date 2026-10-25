/**
 * Serializes async work per key (a group id), so two votes arriving at once
 * can't both evaluate the round and double-lock or double-advance it.
 * In-process only; a multi-instance deployment would need a DB advisory lock.
 */
export class KeyedLock {
  private tails = new Map<string, Promise<unknown>>();

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const next = previous.then(fn, fn);
    const tail = next.catch(() => {});
    this.tails.set(key, tail);
    tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return next;
  }
}
