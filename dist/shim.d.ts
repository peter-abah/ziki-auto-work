export interface ShimPlan {
    path: string;
    dir: string;
    onPath: boolean;
}
export declare function chooseShimPath(options: {
    platform?: NodeJS.Platform;
    home: string;
    env?: NodeJS.ProcessEnv;
    pathValue?: string;
}): ShimPlan | null;
export declare function installShim(options: {
    packageRoot: string;
    home: string;
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
    pathValue?: string;
}): Promise<{
    plan: ShimPlan;
    target: string;
    created: boolean;
} | null>;
