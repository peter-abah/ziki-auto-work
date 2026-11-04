export declare class Mutex {
    private tail;
    run<T>(fn: () => Promise<T> | T): Promise<T>;
}
export declare function mutexFor(key: string): Mutex;
