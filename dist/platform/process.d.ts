export declare function windowsKillCommand(pid: number): {
    command: string;
    args: string[];
};
export declare function killProcessTree(pid: number | null | undefined, platform?: NodeJS.Platform): void;
