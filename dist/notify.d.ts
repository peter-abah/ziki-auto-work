import type { NotifyMode, ProfileConfig } from "./types.js";
import type { Logger } from "./log.js";
export interface NotifyResult {
    ok: boolean;
    mode: NotifyMode;
    detail: string;
}
export declare function resolveNotifyMode(profile: ProfileConfig): NotifyMode;
export declare function desktopNotifier(platform?: NodeJS.Platform): {
    command: string;
    args: (title: string, body: string) => string[];
} | null;
export declare function desktopNotifierAvailable(platform?: NodeJS.Platform): Promise<boolean>;
export declare function notifyProfile(profile: ProfileConfig, title: string, body: string, logger?: Logger | null): Promise<NotifyResult>;
