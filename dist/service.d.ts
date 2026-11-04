import { profilePaths } from "./platform/paths.js";
export declare function systemdUnitText(profileName: string): string;
export declare function launchdPlistText(profileName: string): string;
export declare function installService(profileName: string): Promise<{
    ok: boolean;
    mode: string;
    file: string;
    detail?: string;
}>;
export declare function startService(profileName: string): Promise<{
    mode: string;
    pid?: number;
}>;
export declare function stopService(profileName: string): Promise<{
    stopped: boolean;
    pid: number | null;
}>;
export declare function statusService(profileName: string): Promise<{
    pid: number | null;
    running: boolean;
    paused: boolean;
    stopped: boolean;
    status: Record<string, unknown> | null;
    profilePaths: ReturnType<typeof profilePaths>;
}>;
export declare function pauseService(profileName: string): Promise<{
    paused: boolean;
}>;
export declare function resumeService(profileName: string): Promise<{
    paused: boolean;
}>;
