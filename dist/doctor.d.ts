export interface DoctorCheck {
    name: string;
    ok: boolean;
    detail: string;
    critical: boolean;
}
export declare function runDoctor(options?: {
    profileName?: string;
}): Promise<{
    ok: boolean;
    checks: DoctorCheck[];
}>;
export declare function formatDoctor(result: {
    ok: boolean;
    checks: DoctorCheck[];
}): string;
export declare function doctorConfigPath(): string;
export declare function doctorConfigExists(): boolean;
