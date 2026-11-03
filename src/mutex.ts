export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T> | T): Promise<T> {
    const result = this.tail.then(fn, fn);
    this.tail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }
}

const locks = new Map<string, Mutex>();

export function mutexFor(key: string): Mutex {
  let lock = locks.get(key);
  if (!lock) {
    lock = new Mutex();
    locks.set(key, lock);
  }
  return lock;
}
