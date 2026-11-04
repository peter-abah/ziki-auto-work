interface UninstallItem {
    kind: "systemd" | "launchd" | "task" | "bin" | "config" | "state" | "cache" | "legacy";
    label: string;
    path: string;
    exists: boolean;
    taskName?: string;
}
export declare function planUninstall(options: {
    keepData: boolean;
}): Promise<UninstallItem[]>;
export declare function runUninstall(options: {
    dryRun: boolean;
    keepData: boolean;
    yes: boolean;
}): Promise<void>;
export {};
