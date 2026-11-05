export declare function errorMessage(error: unknown): string;
export declare function isNoopZikiError(error: unknown, patterns: ReadonlyArray<RegExp>): boolean;
export declare const NOOP_PATTERNS: {
    readonly reclaim: readonly [RegExp, RegExp];
    readonly open: readonly [RegExp, RegExp, RegExp];
    readonly review: readonly [RegExp, RegExp, RegExp];
    readonly convert: readonly [RegExp];
};
