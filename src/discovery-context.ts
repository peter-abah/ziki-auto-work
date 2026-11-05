import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

export interface DiscoveryContextOptions {
  parityFile?: string | null;
  contextFiles?: string[];
  repoDir: string;
  packageRoot: string;
}

export interface DiscoveryContext {
  parity: string;
  context: string;
  missing: string[];
}

export function contextCandidates(file: string, repoDir: string, packageRoot: string): string[] {
  if (path.isAbsolute(file)) return [file];
  return [path.join(repoDir, file), path.join(packageRoot, file)];
}

export async function loadDiscoveryContext(options: DiscoveryContextOptions): Promise<DiscoveryContext> {
  const parts: string[] = [];
  const missing: string[] = [];
  let parity = "(no parity map yet)";

  if (options.parityFile) {
    if (existsSync(options.parityFile)) {
      parity = await readFile(options.parityFile, "utf8");
      parts.push(`## Parity map\n${parity}`);
    } else {
      parity = `(parity file not found: ${options.parityFile})`;
      missing.push(options.parityFile);
      parts.push(`## Parity map\n${parity}`);
    }
  }

  for (const file of options.contextFiles ?? []) {
    if (!file.trim()) continue;
    const found = contextCandidates(file, options.repoDir, options.packageRoot).find((candidate) => existsSync(candidate));
    if (!found) {
      missing.push(file);
      parts.push(`## Context: ${file}\n(file not found)`);
      continue;
    }
    parts.push(`## Context: ${file}\n${await readFile(found, "utf8")}`);
  }

  return {
    parity,
    context: parts.length ? parts.join("\n\n") : "(no discovery context configured)",
    missing
  };
}
