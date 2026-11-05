export interface LiveFrame {
    line: string;
    key?: string;
}
export interface LiveStatusOptions {
    enabled?: boolean;
    intervalMs?: number;
    render: () => LiveFrame;
    stream?: NodeJS.WriteStream;
}
export declare class LiveStatus {
    private readonly stream;
    private readonly enabled;
    private readonly tty;
    private readonly intervalMs;
    private readonly render;
    private timer;
    private lastLine;
    private lastKey;
    private wroteLine;
    constructor(options: LiveStatusOptions);
    start(): void;
    stop(): void;
    refresh(): void;
    note(message: string): void;
}
export declare function formatLiveTask(task: {
    label?: string;
    key: string;
    kind: string;
    ageMs: number;
}): string;
export declare function formatLiveDuration(ms: number | null | undefined): string;
