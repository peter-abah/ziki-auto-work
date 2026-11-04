export declare function isTransientNetworkText(text: string | null | undefined): boolean;
export declare function errorText(error: unknown): string;
export declare function isTransientNetworkError(error: unknown): boolean;
export declare function retryNetwork<T>(operation: () => Promise<T>, options?: {
    attempts?: number;
    baseMs?: number;
    shouldRetry?: (error: unknown) => boolean;
}): Promise<T>;
