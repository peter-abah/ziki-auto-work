import type { ProviderSpec } from "../types.js";
/**
 * Experimental headless specs for popular CLIs. Verify flags against the
 * installed version before relying on them; users can override any spec in
 * `providers` in the config.
 */
export declare const SHORTLIST_SPECS: Record<string, ProviderSpec>;
