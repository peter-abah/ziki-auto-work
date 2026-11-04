import type { ProfilePaths, Paths } from "../types.js";
export declare const PACKAGE_ROOT: string;
export declare function paths(): Paths;
export declare function safeName(name: string): string;
export declare function profilePaths(profileName: string): ProfilePaths;
export declare function expandHome(value: string): string;
export declare function isWindows(): boolean;
export declare function isMac(): boolean;
export declare function isLinux(): boolean;
