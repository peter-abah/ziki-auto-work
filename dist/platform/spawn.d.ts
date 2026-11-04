import type { ChildProcess } from "node:child_process";
export interface RunResult {
    ok: boolean;
    code: number;
    stdout: string;
    stderr: string;
    command: string;
}
export interface RunOptions {
    cwd?: string;
    timeoutMs?: number;
    env?: NodeJS.ProcessEnv;
    maxBuffer?: number;
}
export declare function runCommand(command: string, args: string[], options?: RunOptions): Promise<RunResult>;
export declare function spawnCommand(command: string, args: string[], options?: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
}): ChildProcess;
export declare function spawnDetached(command: string, args: string[], options?: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
}): ChildProcess;
