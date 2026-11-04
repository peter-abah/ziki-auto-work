export class Mutex {
    tail = Promise.resolve();
    run(fn) {
        const result = this.tail.then(fn, fn);
        this.tail = result.then(() => undefined, () => undefined);
        return result;
    }
}
const locks = new Map();
export function mutexFor(key) {
    let lock = locks.get(key);
    if (!lock) {
        lock = new Mutex();
        locks.set(key, lock);
    }
    return lock;
}
//# sourceMappingURL=mutex.js.map