import { existsSync } from "node:fs";
import { chmod, cp, mkdir, readFile, readdir, stat, symlink, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import type { CheckSpec, Config, ProfileConfig, ProviderName, RunLimitConfig } from "./types.js";
import {
  DEFAULT_LIMITS,
  DEFAULT_WORKFLOW,
  PROVIDERS,
  deepMerge,
  defaultConfig,
  inferPushMode,
  loadConfig,
  loadEnv,
  loadProfile,
  parseEnvFile,
  resolveModel,
  resolveRunLimits,
  sampleConfigPath,
  saveConfig,
  saveEnv,
  validateConfig
} from "./config.js";
import { PACKAGE_ROOT, paths, profilePaths, safeName } from "./platform/paths.js";
import { runCommand } from "./platform/spawn.js";
import { runDoctor, formatDoctor } from "./doctor.js";
import {
  installService,
  pauseService,
  resumeService,
  startService,
  statusService,
  stopService
} from "./service.js";
import { loadState, readHistory, readPid } from "./state.js";
import { clientForAgent } from "./ziki.js";
import { escalationUrl } from "./urls.js";
import { BUILTIN_PROVIDERS, getProvider, listProviderIds, SHORTLIST_PROVIDER_IDS } from "./providers/index.js";
import { SHORTLIST_SPECS } from "./providers/specs.js";
import {
  assignRoles,
  formatKeyTable,
  inspectKeys,
  knownProjects,
  listPlatforms,
  projectSummary
} from "./keys.js";
import { runUninstall } from "./uninstall.js";
import { GitHub } from "./github.js";
import { formatRunSummary } from "./run-report.js";
import { formatTokens } from "./usage.js";
import {
  detectedStackAt,
  ensureFork,
  githubLogin,
  inferPlatform,
  listBranches,
  parseRepoRef,
  rankCandidates,
  repoInfo,
  repoName,
  searchRepos
} from "./discover.js";

const REPO_URL = "https://github.com/peter-abah/ziki-auto-work";

const HELP = `auto-work — autonomous Ziki work loop

Usage:
  auto-work                         # set up if needed, then run in the foreground
  auto-work install [--keys-file <path>] [--service] [--profile <name>]
  auto-work init [--keys-file <path>] [--profile <name>] [--example <name>] [--from-file <path>] [--yes] [--advanced]
                 [--discover] [--fork] [--fork-owner <owner>] [--repo-url <url>] [--personal-fork] [--no-fork]
                 [--dry-run] [--env-file <path>]
                 [--project-slug <slug>] [--platform <p>] [--github-repo <owner/name>] [--base <branch>]
  auto-work keys import <file>
  auto-work keys check
  auto-work uninstall [--dry-run] [--keep-data] [--yes]
  auto-work detect [--json]
  auto-work models [--provider <p>] [--profile <name>] [--json]
  auto-work providers [--check]
  auto-work profiles
  auto-work start [--profile <name>] [--foreground] [--verbose] [--once] [--dry-run] [--all]
                  [--max-runtime 2h] [--max-cycles N] [--until ISO] [--max-deliveries N] [--forever]
  auto-work run [--profile <name>] [--verbose] [--once] [--dry-run]
  auto-work stop [--profile <name>] [--all]
  auto-work pause [--profile <name>]
  auto-work resume [--profile <name>]
  auto-work status [--profile <name>] [--all] [--verbose] [--line] [--watch]
  auto-work report [--profile <name>] [--all] [--since 24h] [--json]
  auto-work history [--profile <name>] [--limit 50]
  auto-work logs [--profile <name>] [--lines 80] [--follow]
  auto-work escalations [--profile <name>]
  auto-work memory [--profile <name>]
  auto-work config [--show] [--validate]
  auto-work prompts [--profile <name>]
  auto-work doctor [--profile <name>] [--json]

Environment overrides:
  AUTO_WORK_HOME, AUTO_WORK_CONFIG_DIR, AUTO_WORK_STATE_DIR, AUTO_WORK_CACHE_DIR
`;

interface Flags {
  [key: string]: string | boolean | undefined;
}

function parseArgs(argv: string[]): { command: string; flags: Flags; positionals: string[] } {
  const [command = "", ...rest] = argv;
  const flags: Flags = {};
  const positionals: string[] = [];
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index]!;
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const next = rest[index + 1];
    if (next && !next.startsWith("--")) {
      flags[key] = next;
      index += 1;
    } else {
      flags[key] = true;
    }
  }
  return { command, flags, positionals };
}

function str(flags: Flags, key: string): string | undefined {
  const value = flags[key];
  return typeof value === "string" ? value : undefined;
}

function parseDurationMinutes(value: string): number | null {
  const text = value.trim().toLowerCase();
  if (["forever", "none", "off", "0"].includes(text)) return null;
  const match = text.match(/^(\d+(?:\.\d+)?)\s*(h|hr|hrs|hour|hours|m|min|mins|minute|minutes|s|sec|secs|seconds)?$/);
  if (!match) throw new Error(`Invalid duration "${value}". Use e.g. 2h, 90m, or 120.`);
  const amount = Number(match[1]);
  const unit = match[2] ?? "m";
  if (unit.startsWith("h")) return Math.round(amount * 60);
  if (unit.startsWith("s")) return Math.max(1, Math.round(amount / 60));
  return Math.round(amount);
}

function parseRunLimits(flags: Flags): Partial<RunLimitConfig> | null {
  const hasAny = ["forever", "max-runtime", "max-cycles", "until", "max-deliveries"].some((key) => flags[key] !== undefined);
  if (!hasAny) return null;
  if (flags.forever) {
    return { maxRuntimeMinutes: null, maxCycles: null, stopAt: null, maxDeliveriesTotal: null };
  }
  const limits: Partial<RunLimitConfig> = {};
  const runtime = str(flags, "max-runtime");
  if (runtime !== undefined) limits.maxRuntimeMinutes = parseDurationMinutes(runtime);
  const cycles = str(flags, "max-cycles");
  if (cycles !== undefined) {
    const value = Number(cycles);
    if (!Number.isFinite(value) || value < 1) throw new Error(`Invalid --max-cycles "${cycles}"`);
    limits.maxCycles = Math.floor(value);
  }
  const until = str(flags, "until");
  if (until !== undefined) {
    const at = new Date(until);
    if (!Number.isFinite(at.getTime())) throw new Error(`Invalid --until "${until}" (use ISO 8601)`);
    limits.stopAt = at.toISOString();
  }
  const deliveries = str(flags, "max-deliveries");
  if (deliveries !== undefined) {
    const value = Number(deliveries);
    if (!Number.isFinite(value) || value < 1) throw new Error(`Invalid --max-deliveries "${deliveries}"`);
    limits.maxDeliveriesTotal = Math.floor(value);
  }
  return limits;
}

function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "none";
  if (ms <= 0) return "0s";
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return `${Math.max(1, Math.round(ms / 1000))}s`;
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

async function writeRunLimits(profileName: string, limits: RunLimitConfig): Promise<void> {
  const jp = profilePaths(profileName);
  await mkdir(jp.stateDir, { recursive: true });
  await writeFile(jp.runLimitsFile, `${JSON.stringify(limits, null, 2)}\n`, "utf8");
}

async function resolveProfileName(flags: Flags): Promise<string> {
  const config = await loadConfig();
  return str(flags, "profile") || config.activeProfile || Object.keys(config.profiles)[0] || "";
}

async function importKeys(keysFile: string): Promise<number> {
  const text = await readFile(keysFile, "utf8");
  const parsed = parseEnvFile(text);
  const keys = Object.fromEntries(Object.entries(parsed).filter(([key]) => key.startsWith("ZIKI_")));
  if (!Object.keys(keys).length) throw new Error(`No ZIKI_* keys found in ${keysFile}`);
  const existing = await loadEnv();
  await saveEnv({ ...existing, ...keys });
  return Object.keys(keys).length;
}

function printKeyInstructions(): void {
  const p = paths();
  console.log("No Ziki agent keys found.");
  console.log("");
  console.log("Create agents in Ziki → Settings → Agents, then put their keys in a file:");
  console.log("");
  console.log("  ZIKI_KEY1=...   # working (required)");
  console.log("  ZIKI_KEY2=...   # manager/merger (optional)");
  console.log("");
  console.log("Import and validate them:");
  console.log("  auto-work keys import keys.env");
  console.log("");
  console.log(`Keys are stored in ${p.envFile} (mode 600), never in config or git.`);
}

function pathOnPath(dir: string): boolean {
  const wanted = process.platform === "win32" ? dir.toLowerCase() : dir;
  return (process.env.PATH || "")
    .split(path.delimiter)
    .filter(Boolean)
    .some((entry) => (process.platform === "win32" ? entry.toLowerCase() : entry) === wanted);
}

function pathHint(dir: string): string {
  return process.platform === "win32"
    ? `Add it to your user PATH and open a new terminal: ${dir}`
    : `Add it to PATH, e.g. export PATH="${dir}:$PATH"`;
}

async function installBinShim(): Promise<string> {
  const p = paths();
  const target = path.join(p.packageRoot, "bin/auto-work.mjs");
  if (process.platform === "win32") {
    const npmDir = process.env.APPDATA ? path.join(process.env.APPDATA, "npm") : null;
    const bin = npmDir && existsSync(npmDir) ? path.join(npmDir, "auto-work.cmd") : p.bin;
    await mkdir(path.dirname(bin), { recursive: true });
    await writeFile(bin, `@echo off\r\n"${process.execPath}" "${target}" %*\r\n`, "utf8");
    return bin;
  }
  await mkdir(path.dirname(p.bin), { recursive: true });
  await unlink(p.bin).catch(() => {});
  await symlink(target, p.bin);
  await chmod(target, 0o755).catch(() => {});
  return p.bin;
}

async function install(flags: Flags): Promise<void> {
  const p = paths();
  await mkdir(p.configDir, { recursive: true });
  await mkdir(p.stateDir, { recursive: true });
  await mkdir(p.profilesDir, { recursive: true });

  if (!existsSync(p.configFile)) {
    await saveConfig(defaultConfig());
  }

  const keysFile = str(flags, "keys-file") || process.env.AUTO_WORK_KEYS_FILE;
  if (keysFile) {
    const count = await importKeys(keysFile);
    console.log(`Imported ${count} ZIKI key(s) into ${p.envFile}`);
  }

  const bin = await installBinShim();
  const binDir = path.dirname(bin);
  if (!pathOnPath(binDir)) {
    console.log(`warning: ${binDir} is not on PATH. ${pathHint(binDir)}`);
  }
  const profileName = await resolveProfileName(flags);
  if ((flags.service || flags.systemd) && profileName) {
    const result = await installService(profileName);
    console.log(
      result.ok ? `Service installed (${result.mode}): ${result.file}` : `Service setup failed: ${result.detail ?? ""}`
    );
  }

  console.log("");
  console.log("Installed.");
  console.log(`  config: ${p.configFile}`);
  console.log(`  env:    ${p.envFile}`);
  console.log(`  state:  ${p.stateDir}`);
  console.log(`  bin:    ${bin}`);
  console.log("");
  console.log("Next:");
  console.log("  auto-work init          # configure a project");
  console.log("  auto-work doctor");
  console.log("  auto-work run --once --dry-run");
  console.log("  auto-work start");
}

function checkPreset(name: string): CheckSpec[] {
  if (name === "flutter") {
    return [
      { name: "deps", command: "flutter", args: ["pub", "get"], timeoutMs: 600_000 },
      {
        name: "format",
        command: "dart",
        args: ["format", "--output=none", "--set-exit-if-changed"],
        filesOnly: true,
        include: [".dart"]
      },
      { name: "analyze", command: "flutter", args: ["analyze", "--fatal-infos", "--fatal-warnings"] },
      {
        name: "test",
        command: "flutter",
        args: ["test", "--reporter", "json"],
        reporter: "json",
        timeoutMs: 1_800_000
      }
    ];
  }
  if (name === "node") {
    return [
      { name: "deps", command: "npm", args: ["ci"], timeoutMs: 600_000 },
      { name: "lint", command: "npm", args: ["run", "lint"], required: false },
      { name: "test", command: "npm", args: ["test"], timeoutMs: 1_800_000 }
    ];
  }
  if (name === "python") {
    return [
      { name: "deps", command: "python", args: ["-m", "pip", "install", "-e", "."], timeoutMs: 600_000 },
      { name: "lint", command: "ruff", args: ["check", "."], required: false },
      { name: "test", command: "pytest", args: ["-q"], timeoutMs: 1_800_000 }
    ];
  }
  if (name === "go") {
    return [
      { name: "build", command: "go", args: ["build", "./..."], timeoutMs: 900_000 },
      { name: "test", command: "go", args: ["test", "./..."], timeoutMs: 1_800_000 }
    ];
  }
  if (name === "rust") {
    return [
      { name: "build", command: "cargo", args: ["build"], timeoutMs: 1_800_000 },
      { name: "test", command: "cargo", args: ["test"], timeoutMs: 1_800_000 }
    ];
  }
  return [];
}

function detectedStack(): string {
  return detectedStackAt(process.cwd());
}

async function detectedProviders(): Promise<ProviderName[]> {
  const found: ProviderName[] = [];
  const candidates = [
    ...BUILTIN_PROVIDERS.filter((provider) => provider !== "custom"),
    ...Object.values(SHORTLIST_SPECS).map((spec) => spec.command)
  ];
  for (const provider of candidates) {
    const result = await runCommand(provider, ["--version"], { timeoutMs: 10_000 });
    if (result.ok && !found.includes(provider)) found.push(provider);
  }
  return found;
}

async function providerModels(provider: ProviderName): Promise<{ items: string[]; note?: string }> {
  const profile = baseProfile({ executor: { provider } });
  try {
    return await getProvider(provider, profile).models(profile);
  } catch (error) {
    return { items: [], note: error instanceof Error ? error.message : String(error) };
  }
}

async function copyPromptSet(profileName: string): Promise<string> {
  const p = paths();
  const target = path.join(p.configDir, "prompts", safeName(profileName));
  if (!existsSync(target)) {
    await mkdir(target, { recursive: true });
    await cp(path.join(PACKAGE_ROOT, "prompts", "generic"), target, { recursive: true });
  }
  return target;
}

function baseProfile(overrides: Partial<ProfileConfig>): ProfileConfig {
  const defaults = defaultConfig().defaults ?? {};
  return deepMerge(
    {
      ziki: { baseUrl: "https://ziki.dev", projectId: "", projectSlug: "", platform: "" },
      repo: { url: "", upstream: "", base: "main", githubRepo: "", forkOwner: "", defaultBranch: "main" },
      agents: { workers: [], managers: [] },
      executor: { provider: "opencode", model: null, timeoutMs: 2_700_000, permissionMode: "auto" },
      toolchain: {},
      checks: [],
      platformMatch: {},
      prompts: { dir: "prompts/generic" },
      pr: { templateFile: "prompts/generic/pr.md" },
      prTracking: { enabled: true, pollMinutes: 10, maxFollowUps: 10, fixFailingChecks: true, fixReviewComments: true },
      discovery: { enabled: false, maxIdeasPerRun: 3 },
      limits: { ...DEFAULT_LIMITS },
      workflow: { ...DEFAULT_WORKFLOW },
      pollSeconds: 120,
      memoryRefreshMinutes: 30,
      hitl: { enabled: true, defaultType: "question", notify: "auto", notifyCommand: null }
    } as ProfileConfig,
    { ...defaults, ...overrides }
  ) as ProfileConfig;
}

async function initFromExample(name: string): Promise<Config> {
  const file = sampleConfigPath(name);
  if (!existsSync(file)) throw new Error(`No example "${name}" at ${file}`);
  const example = JSON.parse(await readFile(file, "utf8")) as Config;
  const validation = validateConfig(example);
  if (!validation.ok) throw new Error(`Example is invalid: ${validation.errors.join("; ")}`);
  await saveConfig(example);
  return example;
}

async function initFromFile(file: string): Promise<Config> {
  const raw = JSON.parse(await readFile(file, "utf8")) as Config | ProfileConfig;
  let config: Config;
  if ("version" in raw && "profiles" in raw) {
    config = raw as Config;
  } else {
    config = {
      version: 3,
      activeProfile: "default",
      profiles: { default: raw as ProfileConfig }
    };
  }
  const validation = validateConfig(config);
  if (!validation.ok) throw new Error(`Config is invalid: ${validation.errors.join("; ")}`);
  await saveConfig(config);
  return config;
}

async function ask(question: string, fallback: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`${question}${fallback ? ` [${fallback}]` : ""}: `)).trim();
    return answer || fallback;
  } finally {
    rl.close();
  }
}

async function initWizard(flags: Flags): Promise<Config | null> {
  const yes = Boolean(flags.yes);
  const baseUrl = str(flags, "base-url") || "https://ziki.dev";

  let existing: Config;
  try {
    existing = await loadConfig();
  } catch (error) {
    console.warn(`${error instanceof Error ? error.message : String(error)}`);
    console.warn("Starting from a fresh version-3 config.");
    existing = defaultConfig();
  }

  const keysFile = str(flags, "keys-file") || process.env.AUTO_WORK_KEYS_FILE;
  if (keysFile) {
    const count = await importKeys(keysFile);
    console.log(`Imported ${count} ZIKI key(s) into ${paths().envFile}`);
  }

  const env = await loadEnv();
  const inspections = await inspectKeys(env, baseUrl);
  if (!inspections.length) {
    printKeyInstructions();
    return null;
  }

  console.log("");
  console.log("Agent keys:");
  console.log(formatKeyTable(inspections));
  console.log("");

  const valid = inspections.filter((item) => item.ok);
  if (!valid.length) {
    console.error("No valid Ziki keys. Fix the keys above, then run `auto-work keys check`.");
    process.exitCode = 1;
    return null;
  }
  const invalid = inspections.filter((item) => !item.ok);
  if (invalid.length) console.warn(`warning: ${invalid.length} key(s) failed validation; they will be ignored.`);

  const roles = assignRoles(inspections);
  if (!roles.managers.length) {
    console.warn("warning: no manager/merger key. Merge reviews and manager-only actions will be skipped.");
  }
  if (!roles.workers.length) {
    console.warn("warning: no working key; manager keys will also do working tasks.");
  }
  const workers = roles.workers;
  const managers = roles.managers;

  const summary = projectSummary(valid);
  const projects = knownProjects(valid);
  let projectId = str(flags, "project-id") || summary?.id || "";
  let projectSlug = str(flags, "project-slug") || summary?.slug || "";
  let projectName = str(flags, "project-name") || summary?.name || "";
  if (!projectId || !projectSlug) {
    if (yes) throw new Error("Could not resolve a Ziki project from the keys. Pass --project-id and --project-slug.");
    projectId = await ask("Ziki project ID", projectId);
    projectSlug = await ask("Ziki project slug", projectSlug || projectId);
    projectName = await ask("Ziki project name", projectName || projectSlug);
  } else if (projects.length > 1 && !yes) {
    console.log("Projects available to your keys:");
    for (const project of projects) console.log(`  ${project.slug}  ${project.name}  (${project.id})`);
    const chosen = await ask("Project slug", projectSlug);
    const match = projects.find((project) => project.slug === chosen || project.id === chosen);
    if (match) {
      projectId = match.id;
      projectSlug = match.slug;
      projectName = match.name;
    }
  }

  let platforms: Awaited<ReturnType<typeof listPlatforms>> = [];
  try {
    platforms = await listPlatforms(baseUrl, valid[0]!.key);
  } catch (error) {
    console.warn(`warning: could not list Ziki platforms: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (platforms.length) {
    console.log("Ziki platforms:");
    for (const platform of platforms) console.log(`  ${platform.slug}  ${platform.name}`);
  }
  const stack = detectedStack();
  const stackPlatform = stack === "flutter" ? "desktop" : "web";
  const platformDefault =
    platforms.find((platform) => platform.slug === stackPlatform)?.slug ?? platforms[0]?.slug ?? stackPlatform;
  let platform = str(flags, "platform") || (yes ? platformDefault : "");
  if (!platform) {
    platform = await ask(
      `Platform slug (${platforms.map((entry) => entry.slug).join("/") || stackPlatform})`,
      platformDefault
    );
  }
  if (platforms.length && !platforms.some((entry) => entry.slug === platform)) {
    console.warn(`warning: platform "${platform}" is not in Ziki's platform list.`);
  }
  const stackLabel = str(flags, "stack") || (yes ? stack : await ask("Stack (for prompts and check presets)", stack));

  const profileName =
    str(flags, "profile") ||
    (yes ? existing.activeProfile || "default" : await ask("Profile name", existing.activeProfile || "default"));
  const repoUrl = str(flags, "repo-url") || (yes ? "" : await ask("Repo clone URL (your fork)", ""));
  const upstream = str(flags, "upstream") || (yes ? repoUrl : await ask("Upstream repo URL", repoUrl));
  const base = str(flags, "base") || (yes ? "main" : await ask("Base branch", "main"));
  const githubRepo = str(flags, "github-repo") || (yes ? "" : await ask("GitHub repo (owner/name)", ""));
  const forkOwner = str(flags, "fork-owner") || (yes ? "" : await ask("Fork owner", ""));
  const upstreamOwner = parseRepoRef(githubRepo)?.owner ?? parseRepoRef(upstream)?.owner ?? "";
  const pushMode = forkOwner && upstreamOwner && forkOwner.toLowerCase() === upstreamOwner.toLowerCase()
    ? "upstream" as const
    : undefined;
  const defaultBranch = str(flags, "default-branch") || (yes ? "main" : await ask("Default branch", "main"));
  const teamLead = str(flags, "team-lead") || (yes ? "" : await ask("Team lead handle (optional)", ""));

  const providerDefault = (await detectedProviders())[0] ?? "opencode";
  const provider = (str(flags, "provider") ||
    (yes ? providerDefault : await ask(`Provider (${PROVIDERS.join("/")})`, providerDefault))) as ProviderName;
  if (!PROVIDERS.includes(provider)) throw new Error(`Unknown provider "${provider}"`);
  const modelCandidates = await providerModels(provider);
  if (modelCandidates.items.length) {
    console.log(`Models: ${modelCandidates.items.slice(0, 20).join(", ")}`);
  }
  if (modelCandidates.note) console.log(modelCandidates.note);
  const model = str(flags, "model") || (yes ? "" : await ask("Model (blank = provider default)", ""));

  const checksName =
    str(flags, "checks") || (yes ? stack : await ask("Checks preset (flutter/node/python/go/rust/none)", stack));
  const parity =
    str(flags, "parity") ||
    (yes || !flags.advanced ? "" : await ask("Advanced: parity/context file (optional, blank to skip)", ""));

  const promptsDir = await copyPromptSet(profileName);
  const profile = baseProfile({
    ziki: { baseUrl, projectId, projectSlug, platform, ...(projectName ? { projectName } : {}) },
    ...(stackLabel ? { stack: stackLabel } : {}),
    repo: {
      url: repoUrl,
      upstream,
      base,
      githubRepo,
      forkOwner,
      ...(pushMode ? { pushMode } : {}),
      defaultBranch,
      ...(teamLead ? { teamLead } : {})
    },
    agents: { workers, managers },
    executor: { provider, model: model || null, timeoutMs: 2_700_000, permissionMode: "auto" },
    checks: checkPreset(checksName),
    platformMatch: { keywords: [platform] },
    prompts: { dir: promptsDir },
    pr: { templateFile: path.join(promptsDir, "pr.md"), ...(teamLead ? { teamLead } : {}) },
    discovery: { enabled: Boolean(parity), ...(parity ? { parityFile: parity } : {}) }
  });

  const config: Config = {
    version: 3,
    activeProfile: profileName,
    defaults: existing.defaults,
    profiles: { ...existing.profiles, [profileName]: profile }
  };
  const validation = validateConfig(config);
  if (!validation.ok) throw new Error(`Config is invalid:\n${validation.errors.join("\n")}`);
  await saveConfig(config);
  return config;
}


async function initDiscover(flags: Flags): Promise<void> {
  const yes = Boolean(flags.yes);
  const dryRun = Boolean(flags["dry-run"]);
  const baseUrl = str(flags, "base-url") || "https://ziki.dev";
  const gh = str(flags, "gh") || "gh";

  let existing: Config;
  try {
    existing = await loadConfig();
  } catch {
    existing = defaultConfig();
  }

  const keysFile = str(flags, "keys-file") || process.env.AUTO_WORK_KEYS_FILE;
  if (keysFile) {
    const count = await importKeys(keysFile);
    console.log(`Imported ${count} ZIKI key(s) into ${paths().envFile}`);
  }
  const env = await loadEnv();
  const inspections = await inspectKeys(env, baseUrl);
  if (!inspections.length) {
    printKeyInstructions();
    process.exitCode = 1;
    return;
  }
  console.log("");
  console.log("Agent keys:");
  console.log(formatKeyTable(inspections));
  console.log("");
  const valid = inspections.filter((item) => item.ok);
  if (!valid.length) throw new Error("No valid Ziki keys. Fix them with `auto-work keys check`.");
  const roles = assignRoles(inspections);
  if (!roles.workers.length) console.warn("warning: no working key; manager keys will also do working tasks.");
  if (!roles.managers.length) {
    console.warn("warning: no manager/merger key (optional; merge reviews and manager-only actions will be skipped).");
  }

  const summary = projectSummary(valid);
  const projects = knownProjects(valid);
  let projectId = str(flags, "project-id") || summary?.id || "";
  let projectSlug = str(flags, "project-slug") || summary?.slug || "";
  let projectName = str(flags, "project-name") || summary?.name || "";
  if (!projectId || !projectSlug) {
    if (yes) throw new Error("Could not resolve a Ziki project. Pass --project-id and --project-slug.");
    projectId = await ask("Ziki project ID", projectId);
    projectSlug = await ask("Ziki project slug", projectSlug || projectId);
    projectName = await ask("Ziki project name", projectName || projectSlug);
  } else if (projects.length > 1 && !yes) {
    console.log("Projects available to your keys:");
    for (const project of projects) console.log(`  ${project.slug}  ${project.name}  (${project.id})`);
    const chosen = await ask("Project slug", projectSlug);
    const match = projects.find((project) => project.slug === chosen || project.id === chosen);
    if (match) {
      projectId = match.id;
      projectSlug = match.slug;
      projectName = match.name;
    }
  }

  let platforms: Awaited<ReturnType<typeof listPlatforms>> = [];
  try {
    platforms = await listPlatforms(baseUrl, valid[0]!.key);
  } catch (error) {
    console.warn(`warning: could not list Ziki platforms: ${error instanceof Error ? error.message : String(error)}`);
  }

  let githubRepo = str(flags, "github-repo") || str(flags, "upstream");
  let repoRef = parseRepoRef(githubRepo);
  const repoUrlOverride = str(flags, "repo-url");
  const forkOwnerFlag = str(flags, "fork-owner");
  if (!repoRef) {
    if (!githubRepo) {
      const login = await githubLogin(gh);
      let candidates = await searchRepos(projectSlug, { gh, limit: 30 });
      const requestedPlatform = str(flags, "platform") || null;
      candidates = rankCandidates(candidates, projectSlug, requestedPlatform);
      if (!candidates.length) {
        if (yes) throw new Error(`No GitHub repository found for "${projectSlug}". Pass --github-repo owner/name.`);
        githubRepo = await ask("Upstream GitHub repo (owner/name)", "");
        repoRef = parseRepoRef(githubRepo);
      } else if (candidates.length === 1 || yes) {
        repoRef = parseRepoRef(candidates[0]!.fullName);
        if (!yes) console.log(`Repository: ${candidates[0]!.fullName}`);
      } else {
        console.log("Repository candidates:");
        candidates.slice(0, 10).forEach((candidate, index) => {
          console.log(`  ${index + 1}. ${candidate.fullName}${candidate.description ? ` — ${candidate.description}` : ""}`);
        });
        const chosen = await ask("Repository (number or owner/name)", candidates[0]!.fullName);
        const index = Number(chosen);
        const selected = Number.isInteger(index) && index >= 1 && index <= Math.min(10, candidates.length)
          ? candidates[index - 1]!
          : candidates.find((candidate) => candidate.fullName === chosen || candidate.fullName.endsWith(`/${chosen}`)) ?? null;
        if (!selected) throw new Error(`Unknown repository "${chosen}"`);
        repoRef = parseRepoRef(selected.fullName);
      }
    } else {
      throw new Error(`Could not parse repository "${githubRepo}". Use owner/name or a GitHub URL.`);
    }
  }
  if (!repoRef) throw new Error("A repository is required.");

  const upstream = `${repoRef.owner}/${repoRef.name}`;
  const info = await repoInfo(upstream, gh);
  if (!info) throw new Error(`Cannot read ${upstream}. Check gh auth and the repository name.`);
  const defaultBranch = info.defaultBranch;
  const branches = await listBranches(upstream, gh);
  const base = str(flags, "base") || (branches.includes("staging") ? "staging" : defaultBranch);

  const user = await githubLogin(gh);
  const repoUrlOwner = repoUrlOverride ? parseRepoRef(repoUrlOverride)?.owner : null;
  const noFork = Boolean(flags["no-fork"]);
  const personalFork = Boolean(flags["personal-fork"]);
  if (noFork && personalFork) throw new Error("--no-fork and --personal-fork cannot be combined");
  let forkOwner = forkOwnerFlag || repoUrlOwner || (personalFork ? user : "");
  if (noFork) forkOwner = repoRef.owner;
  if (!forkOwner) {
    if (yes) {
      throw new Error(
        "Choose a push target: pass --fork-owner <owner> and --repo-url <url>, or --personal-fork, or --no-fork."
      );
    }
    const answer = await ask(
      `Fork owner (blank = personal ${user}; ${repoRef.owner} = upstream)`,
      ""
    );
    forkOwner = answer || user;
  }
  const pushMode = noFork ? "upstream" : inferPushMode(forkOwner, repoRef.owner, user);
  if (pushMode === "upstream") forkOwner = repoRef.owner;
  const org = forkOwner !== user && pushMode !== "upstream" ? forkOwner : undefined;
  const createFork = Boolean(flags.fork) && !dryRun && pushMode !== "upstream";
  let fork = await ensureFork({ upstream, user: forkOwner, org, createFork, gh });
  if (fork.needsFork && !dryRun) {
    if (yes) throw new Error(`Fork ${fork.forkRepo} does not exist. Pass --fork to create it.`);
    const answer = await ask(`Create fork ${fork.forkRepo} from ${upstream}? (y/N)`, "n");
    if (/^y/i.test(answer)) fork = await ensureFork({ upstream, user: forkOwner, org, createFork: true, gh });
    else throw new Error(`A fork is required. Create ${fork.forkRepo} or pass --repo-url with an existing fork.`);
  }
  if (repoUrlOverride) {
    fork = { ...fork, forkGitUrl: repoUrlOverride, exists: true, needsFork: false };
  }

  let platform = str(flags, "platform") || inferPlatform(repoName(upstream)) || "";
  const platformDefault = platforms.find((entry) => entry.slug === platform)?.slug ?? platforms[0]?.slug ?? platform ?? "desktop";
  if (!platform) {
    if (yes) throw new Error("Could not infer the Ziki platform. Pass --platform desktop/mobile/web.");
    platform = await ask(`Platform slug (${platforms.map((entry) => entry.slug).join("/") || platformDefault})`, platformDefault);
  }
  if (platforms.length && !platforms.some((entry) => entry.slug === platform)) {
    console.warn(`warning: platform "${platform}" is not in Ziki's platform list.`);
  }

  const stackFlag = str(flags, "stack");
  const checksFlag = str(flags, "checks");
  const stack = stackFlag || "generic";
  const providerDefault = (await detectedProviders())[0] ?? "opencode";
  const provider = (str(flags, "provider") || (yes ? providerDefault : await ask(`Provider (${PROVIDERS.join("/")})`, providerDefault))) as ProviderName;
  if (!PROVIDERS.includes(provider)) throw new Error(`Unknown provider "${provider}"`);
  const model = str(flags, "model") || (yes ? "" : await ask("Model (blank = provider default)", ""));
  const teamLead = str(flags, "team-lead") || "";
  const profileName = str(flags, "profile") || `${projectSlug}-${platform}`;
  const promptsDir = path.join(paths().configDir, "prompts", safeName(profileName));
  const checks = checkPreset(checksFlag || stack);
  const parity = str(flags, "parity") || "";
  const envFile = str(flags, "env-file");

  const profile = baseProfile({
    ziki: { baseUrl, projectId, projectSlug, platform, ...(projectName ? { projectName } : {}) },
    stack,
    repo: {
      url: fork.forkGitUrl,
      upstream: `https://github.com/${upstream}.git`,
      base,
      githubRepo: upstream,
      forkOwner: fork.forkOwner,
      pushMode,
      defaultBranch,
      envFiles: [".env", ".env.local"],
      ...(teamLead ? { teamLead } : {})
    },
    agents: { workers: roles.workers, managers: roles.managers },
    executor: { provider, model: model || null, timeoutMs: 2_700_000, permissionMode: "auto" },
    checks,
    platformMatch: { keywords: [platform] },
    prompts: { dir: promptsDir },
    pr: { templateFile: path.join(promptsDir, "pr.md"), ...(teamLead ? { teamLead } : {}) },
    discovery: { enabled: Boolean(parity), ...(parity ? { parityFile: parity } : {}) }
  });

  const config: Config = {
    version: 3,
    activeProfile: profileName,
    defaults: existing.defaults,
    profiles: { ...existing.profiles, [profileName]: profile },
    ...(existing.doctor ? { doctor: existing.doctor } : {})
  };
  const validation = validateConfig(config);
  if (!validation.ok) throw new Error(`Config is invalid:\n${validation.errors.join("\n")}`);

  if (dryRun) {
    console.log("");
    console.log(`Discovery plan for profile "${profileName}"`);
    console.log(`  project:  ${projectSlug} (${projectId})`);
    console.log(`  platform: ${platform}`);
    console.log(`  upstream: ${upstream} (${defaultBranch})`);
    console.log(`  base:     ${base}`);
    console.log(`  fork:     ${fork.forkRepo}${fork.created ? " (created)" : fork.needsFork ? " (missing; use --fork)" : ""}`);
    console.log(`  clone:    ${fork.forkGitUrl}`);
    console.log(`  push:     ${pushMode} (${fork.forkOwner})`);
    console.log(`  provider: ${provider}${model ? ` · ${model}` : ""}`);
    console.log(`  checks:   ${checks.map((check) => check.name).join(", ") || "(none)"}`);
    console.log("");
    console.log("No config, fork, clone or other writes were made.");
    return;
  }

  await copyPromptSet(profileName);
  await saveConfig(config);

  let repoDir: string | null = null;
  try {
    const loaded = await loadProfile(profileName);
    const github = new GitHub({ profile: loaded.profile, profileName, reposDir: loaded.profilePaths.reposDir });
    repoDir = await github.ensureRepo();
  } catch (error) {
    console.warn(`warning: could not clone yet: ${error instanceof Error ? error.message : String(error)}`);
    console.warn("The config is written; fix access and run `auto-work doctor` to clone.");
  }

  if (repoDir && !stackFlag) {
    const detected = detectedStackAt(repoDir);
    if (detected !== "generic") {
      profile.stack = detected;
      if (!checksFlag) profile.checks = checkPreset(detected);
      await saveConfig(config);
      console.log(`Detected stack: ${detected}`);
    }
  }

  if (envFile && repoDir) {
    const text = await readFile(envFile, "utf8");
    const target = path.join(repoDir, ".env");
    await writeFile(target, text, { encoding: "utf8", mode: 0o600 });
    await chmod(target, 0o600).catch(() => {});
    console.log(`Env file copied to ${target} (mode 600, gitignored by the repo's .env rules).`);
  }

  console.log("");
  console.log(`Configured profile "${profileName}".`);
  console.log(`  config: ${paths().configFile}`);
  console.log(`  repo:   ${upstream} → ${base} (${pushMode}: ${fork.forkRepo})`);
  console.log(`  ziki:   ${projectSlug}/${platform}`);
  console.log(`  keys:   workers=${roles.workers.join(",") || "(none)"} managers=${roles.managers.join(",") || "(none)"}`);
  if (repoDir) console.log(`  clone:  ${repoDir}`);
  nextCommands();
}

function nextCommands(): void {
  console.log("");
  console.log("Next:");
  console.log("  auto-work doctor");
  console.log("  auto-work run --once --dry-run");
  console.log("  auto-work start");
  console.log("");
  console.log("One-off (no global install):");
  console.log("  npx github:peter-abah/ziki-auto-work doctor");
}

async function init(flags: Flags): Promise<void> {
  if (flags["print-ai-prompt"]) {
    console.log(
      `Set up auto-work for my Ziki project. Read ${path.join(PACKAGE_ROOT, "docs/AI-SETUP.md")} and follow it exactly. I will provide agent keys. Do not assume a local repository: resolve the project and platform from Ziki, find (or fork and clone) the repository, write the config, then run \`auto-work config --validate\`, \`auto-work doctor\`, and \`auto-work run --once --dry-run\`. Do not start the loop.`
    );
    return;
  }
  if (flags.json) {
    const template = await readFile(path.join(PACKAGE_ROOT, "config", "generic.json"), "utf8").catch(() =>
      JSON.stringify(defaultConfig(), null, 2)
    );
    console.log(template);
    return;
  }
  if (flags.discover) {
    await initDiscover(flags);
    return;
  }
  if (flags["from-file"]) {
    const config = await initFromFile(str(flags, "from-file")!);
    console.log(`Config written: ${paths().configFile}`);
    console.log(`Active profile: ${config.activeProfile}`);
    nextCommands();
    return;
  }
  if (flags.example) {
    const config = await initFromExample(str(flags, "example")!);
    console.log(`Example installed: ${config.activeProfile}`);
    console.log(`Config: ${paths().configFile}`);
    nextCommands();
    return;
  }
  const config = await initWizard(flags);
  if (!config) {
    if (process.exitCode === undefined) process.exitCode = 1;
    return;
  }
  console.log("");
  console.log(`Configured profile "${config.activeProfile}".`);
  console.log(`Config: ${paths().configFile}`);
  console.log(`Env:    ${paths().envFile}`);
  console.log(`Keys:   workers=${config.profiles[config.activeProfile]?.agents.workers.join(",") || "(none)"} managers=${config.profiles[config.activeProfile]?.agents.managers.join(",") || "(none)"}`);
  nextCommands();
}

async function detect(flags: Flags): Promise<void> {
  const stack = detectedStack();
  const providers = await detectedProviders();
  const config = await loadConfig();
  const profileName = config.activeProfile || Object.keys(config.profiles)[0] || null;
  const profile = profileName ? config.profiles[profileName] : null;
  const data = {
    os: process.platform,
    arch: process.arch,
    node: process.versions.node,
    cwd: process.cwd(),
    stack,
    stackFiles: ["pubspec.yaml", "package.json", "pyproject.toml", "go.mod", "Cargo.toml"].filter((file) =>
      existsSync(path.join(process.cwd(), file))
    ),
    providers,
    configFile: paths().configFile,
    activeProfile: profileName,
    provider: profile?.executor?.provider ?? null,
    model: profile ? resolveModel(profile, "worker") : null,
    checks: profile?.checks?.map((check) => check.name) ?? []
  };
  if (flags.json) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  console.log(`OS:        ${data.os} ${data.arch}`);
  console.log(`Node:      ${data.node}`);
  console.log(`Stack:     ${data.stack}${data.stackFiles.length ? ` (${data.stackFiles.join(", ")})` : ""}`);
  console.log(`Providers: ${data.providers.join(", ") || "none detected"}`);
  console.log(`Config:    ${data.configFile}`);
  console.log(`Profile:   ${data.activeProfile ?? "(none)"}`);
  console.log(`Provider:  ${data.provider ?? "(not configured)"}`);
  console.log(`Model:     ${data.model ?? "(provider default)"}`);
  console.log(`Checks:    ${data.checks.join(", ") || "(none)"}`);
}

async function models(flags: Flags): Promise<void> {
  let loaded = null;
  try {
    loaded = await loadProfile(str(flags, "profile"));
  } catch {
    loaded = null;
  }
  const providerName = (str(flags, "provider") as ProviderName) || loaded?.profile.executor.provider || "opencode";
  const providerIds = loaded ? listProviderIds(loaded.profile) : PROVIDERS;
  if (!providerIds.includes(providerName)) throw new Error(`Unknown provider "${providerName}"`);
  const profile = loaded?.profile ?? baseProfile({ executor: { provider: providerName } });
  const provider = getProvider(providerName, { ...profile, executor: { ...profile.executor, provider: providerName } });
  const result = await provider.models(profile);
  if (flags.json) {
    console.log(JSON.stringify({ provider: providerName, ...result }, null, 2));
    return;
  }
  console.log(`Provider: ${providerName}`);
  if (result.items.length) {
    for (const item of result.items) console.log(`  ${item}`);
  } else {
    console.log("  (no list available; pass a model name as free text)");
  }
  if (result.note) console.log(`\n${result.note}`);
}

async function providersCommand(flags: Flags): Promise<void> {
  let loaded: Awaited<ReturnType<typeof loadProfile>> | null = null;
  try {
    loaded = await loadProfile(str(flags, "profile"));
  } catch {
    loaded = null;
  }
  const ids = listProviderIds(loaded?.profile);
  for (const id of ids) {
    const spec = loaded?.profile.providers?.[id] ?? SHORTLIST_SPECS[id];
    let status = "";
    if (flags.check) {
      try {
        const provider = getProvider(id, loaded?.profile ?? baseProfile({ executor: { provider: id } }));
        const doctor = await provider.doctor(loaded?.profile ?? baseProfile({ executor: { provider: id } }));
        status = doctor.ok ? "installed" : `missing (${doctor.detail.split("\n")[0]})`;
      } catch (error) {
        status = error instanceof Error ? error.message : String(error);
      }
    }
    const label = spec?.label ?? id;
    const kind = spec?.experimental ? " experimental" : "";
    console.log(`${id.padEnd(14)} ${label}${kind}${status ? ` — ${status}` : ""}`);
  }
}

async function profiles(): Promise<void> {
  const config = await loadConfig();
  if (!Object.keys(config.profiles).length) {
    console.log("No profiles configured. Run `auto-work init`.");
    return;
  }
  for (const [name, profile] of Object.entries(config.profiles)) {
    const marker = name === config.activeProfile ? "*" : " ";
    console.log(
      `${marker} ${name}  ${profile.ziki.projectSlug}/${profile.ziki.platform}  ${profile.repo.githubRepo}:${profile.repo.base}`
    );
  }
}

async function start(flags: Flags): Promise<void> {
  const config = await loadConfig();
  const overrides = parseRunLimits(flags);
  if (flags.all) {
    const results = [];
    for (const name of Object.keys(config.profiles)) {
      const loaded = await loadProfile(name);
      const limits = resolveRunLimits(loaded.profile, overrides);
      await writeRunLimits(name, limits);
      results.push({ name, limits, ...(await startService(name)) });
    }
    for (const result of results) {
      console.log(
        `${result.name}: ${result.mode}${result.pid ? ` (pid ${result.pid})` : ""} · limit ${formatDuration(
          (result.limits.maxRuntimeMinutes ?? 0) * 60 * 1000 || null
        )}`
      );
    }
    return;
  }
  const profileName = await resolveProfileName(flags);
  if (!profileName) throw new Error("No profile configured. Run `auto-work init`.");
  const loaded = await loadProfile(profileName);
  const limits = resolveRunLimits(loaded.profile, overrides);
  const once = Boolean(flags.once);
  const dryRun = Boolean(flags["dry-run"]);
  if (flags.foreground || once || dryRun) {
    const { runLoop } = await import("./orchestrator.js");
    const code = await runLoop({ profileName, foreground: true, verbose: Boolean(flags.verbose), once, dryRun, limits });
    process.exitCode = code;
    return;
  }
  await writeRunLimits(profileName, limits);
  const result = await startService(profileName);
  if (result.mode === "already-running") {
    console.log(`Already running (pid ${result.pid}).`);
    return;
  }
  console.log(
    `Started (${result.mode})${result.pid ? ` pid ${result.pid}` : ""} · max runtime ${formatDuration(
      (limits.maxRuntimeMinutes ?? 0) * 60 * 1000 || null
    )}${limits.stopAt ? ` · until ${limits.stopAt}` : ""}`
  );
}

async function stop(flags: Flags): Promise<void> {
  const config = await loadConfig();
  const names = flags.all ? Object.keys(config.profiles) : [await resolveProfileName(flags)];
  for (const name of names.filter(Boolean)) {
    const result = await stopService(name);
    console.log(`${name}: stopped${result.pid ? ` (pid ${result.pid})` : ""}`);
  }
}

async function pause(flags: Flags): Promise<void> {
  await pauseService(await resolveProfileName(flags));
  console.log("Paused.");
}

async function resume(flags: Flags): Promise<void> {
  await resumeService(await resolveProfileName(flags));
  console.log("Resumed.");
}

function statusLine(name: string, result: Awaited<ReturnType<typeof statusService>>): string {
  const status = (result.status ?? {}) as Record<string, any>;
  const state = result.running
    ? `running${result.paused ? " [paused]" : ""}`
    : `stopped${status.run?.stopReason ? ` (${status.run.stopReason})` : ""}`;
  const spent = status.run?.elapsedMs != null ? formatDuration(status.run.elapsedMs) : "-";
  const limit =
    status.run?.limits?.maxRuntimeMinutes != null
      ? formatDuration(status.run.limits.maxRuntimeMinutes * 60 * 1000)
      : "none";
  const needs = status.needsYou?.count ?? (status.escalations as unknown[] | undefined)?.length ?? 0;
  const inflight = status.inFlight?.total ?? 0;
  const queue = status.queue ? Object.values(status.queue as Record<string, number>).reduce((sum, value) => sum + Number(value || 0), 0) : 0;
  const last = status.lastCycleMs != null ? formatDuration(status.lastCycleMs) : "-";
  const current = (status.inFlight?.tasks as Array<Record<string, unknown>> | undefined)?.[0];
  const phase = current
    ? ` | ${current.label ?? `${current.key} ${current.kind}`} ${formatDuration(Number(current.ageMs ?? 0))}`
    : status.phase
      ? ` | ${status.phase}${status.activity ? ` ${status.activity}` : ""}`
      : "";
  const network = status.run?.networkErrors ? ` | net err ${status.run.networkErrors}` : "";
  const tokenText = status.tokens
    ? ` | tokens ${formatTokens(status.tokens.total)}${status.tokens.limit ? `/${formatTokens(status.tokens.limit)} (${status.tokens.percent ?? 0}%)` : ""}`
    : "";
  const lastRun = status.lastRun
    ? ` | last run: ${status.lastRun.cycles}c/${status.lastRun.deliveries}d${status.lastRun.clean ? "" : " (incomplete)"}`
    : "";
  const health = status.health;
  const healthText =
    health && health.state !== "healthy"
      ? ` | health ${health.state}:${health.blockers?.[0]?.code ?? "issue"}`
      : "";
  return `${name} | ${state}${phase} | ${spent}/${limit}${network} | Ziki needs you: ${needs}${tokenText} | inflight ${inflight} | q ${queue} | last ${last}${lastRun}${healthText}`;
}

async function status(flags: Flags): Promise<void> {
  const config = await loadConfig();
  const names = flags.all ? Object.keys(config.profiles) : [await resolveProfileName(flags)];
  const compact = Boolean(flags.line || flags.watch);
  if (flags.watch) {
    const interval = Math.max(5, Number(str(flags, "interval") ?? 30));
    for (;;) {
      const lines: string[] = [];
      for (const name of names.filter(Boolean)) {
        lines.push(statusLine(name, await statusService(name)));
      }
      if (process.stdout.isTTY) process.stdout.write(`\r${lines.join(" | ")}\x1b[K`);
      else console.log(lines.join("\n"));
      await new Promise((resolve) => setTimeout(resolve, interval * 1000));
    }
  }
  for (const name of names.filter(Boolean)) {
    const result = await statusService(name);
    if (compact) console.log(statusLine(name, result));
    else {
      // printDetailedStatus reads flags.verbose from the closure.
      printDetailedStatusWithFlags(flags, name, result);
    }
  }
}

function printDetailedStatusWithFlags(
  flags: Flags,
  name: string,
  result: Awaited<ReturnType<typeof statusService>>
): void {
  const verbose = Boolean(flags.verbose);
  console.log(
    `\n${name}: ${result.running ? `running (pid ${result.pid})` : "not running"}${result.paused ? " [paused]" : ""}`
  );
  if (!result.status) return;
  const status = result.status as Record<string, any>;
  console.log(`  cycles: ${status.cycles ?? 0}  last: ${status.lastCycleAt ?? "never"}`);
  if (status.run) {
    console.log(
      `  run: ${formatDuration(status.run.elapsedMs)} elapsed · ${formatDuration(status.run.remainingMs)} remaining` +
        ` · limit ${status.run.limits?.maxRuntimeMinutes != null ? `${status.run.limits.maxRuntimeMinutes}m` : "none"}` +
        ` · stop ${status.run.stopReason ?? "-"}`
    );
    if (status.run.remainingCycles !== null || status.run.remainingDeliveries !== null) {
      console.log(
        `  remaining: cycles ${status.run.remainingCycles ?? "∞"} · deliveries ${status.run.remainingDeliveries ?? "∞"}`
      );
    }
  }
  console.log(`  counters: ${JSON.stringify(status.counters ?? {})}`);
  if (status.tokens) {
    console.log(
      `  tokens: ${status.tokens.total?.toLocaleString?.() ?? status.tokens.total} (${status.tokens.input} in / ${status.tokens.output} out)` +
        `${status.tokens.limit ? ` · ${status.tokens.percent ?? 0}% of ${status.tokens.limit.toLocaleString()}` : ""}` +
        `${status.tokens.estimated ? " · estimated" : ""}`
    );
  }
  const needs = status.needsYou?.count ?? 0;
  console.log(`  Ziki needs you: ${needs}${needs ? ` → ${status.needsYou?.link}` : ""}`);
  if (status.health) {
    const health = status.health as { state: string; blockers?: Array<Record<string, any>> };
    console.log(`  health: ${health.state}${status.stateDir ? ` · state ${status.stateDir}` : ""}`);
    for (const blocker of health.blockers ?? []) {
      const agents = Array.isArray(blocker.agents) && blocker.agents.length ? ` (${blocker.agents.join(", ")})` : "";
      console.log(`    - ${blocker.severity} ${blocker.component}:${blocker.code} — ${blocker.message}${agents}`);
      if (blocker.details?.setupUrl) console.log(`      setup: ${blocker.details.setupUrl}`);
      console.log(`      attempts ${blocker.attempts} · next retry ${blocker.nextRetryAt ?? "none"}`);
    }
  }
  if (status.agents) {
    for (const agent of status.agents as Array<Record<string, any>>) {
      const current = agent.current
        ? `${agent.current.label ?? agent.current.key} (${Math.round(Number(agent.current.ageMs ?? 0) / 1000)}s)`
        : agent.claim
          ? `claim #${agent.claim} (${agent.claimStatus})`
          : "idle";
      console.log(`  agent ${agent.name} [${agent.level}]: ${current}${agent.stale ? " · STALE HEARTBEAT" : ""}`);
    }
  }
  if (status.capacity) {
    console.log(
      `  effective limits: agents ${status.capacity.agentCeiling} · delivery ${status.capacity.delivery} · review ${status.capacity.review} · aux ${status.capacity.aux} · follow-up ${status.capacity.followup} · claims ${status.capacity.activeClaims}` +
        ` · daily deliveries ${status.profileLimits?.maxDeliveriesPerDay ?? "none"}` +
        ` · daily reviews ${status.profileLimits?.maxReviewsPerDay ?? "none"}` +
        ` · per-cycle aux ${status.profileLimits?.maxAuxPerCycle ?? "none"}`
    );
  }
  if (status.inFlight) {
    console.log(
      `  in flight: ${status.inFlight.total ?? 0} agent(s) · ${status.inFlight.deliveries} delivery · ${status.inFlight.followUps ?? 0} follow-up · ${status.inFlight.reviews} review · ${status.inFlight.aux} aux · ${status.inFlight.discovery} discovery`
    );
  }
  if (status.lastCycle) {
    console.log(
      `  last cycle: ${status.lastCycle.ms}ms · deliveries ${status.lastCycle.deliveries} · reviews ${status.lastCycle.reviews} · aux ${status.lastCycle.aux}`
    );
  }
  if (status.lastRun) {
    console.log(
      `  last run: ${status.lastRun.cycles} cycles · ${status.lastRun.deliveries} deliveries · ${status.lastRun.failures} failures · ${status.lastRun.networkErrors ?? 0} network errors · ${status.lastRun.clean ? "clean" : "incomplete"}`
    );
  }
  const escalations = (status.escalations as Array<Record<string, unknown>> | undefined) ?? [];
  if (escalations.length) {
    console.log("  needs you:");
    for (const escalation of escalations) {
      console.log(`    - ${escalation.type} #${escalation.issue}: ${escalation.body}`);
    }
  }
  if (verbose) {
    const taskList = (status.taskList as Array<Record<string, unknown>> | undefined) ?? [];
    console.log(`  tasks (${taskList.length}):`);
    for (const task of taskList) {
      console.log(
        `    - #${task.issue ?? "?"} [${task.status}] ${task.pr ? `PR ${task.pr}` : ""}${task.prState ? ` · ${task.prState}` : ""}${task.prChecks ? ` · checks ${task.prChecks}` : ""}${task.followUpAttempts ? ` · follow-ups ${task.followUpAttempts}` : ""}${task.tokens != null ? ` · ${formatTokens(Number(task.tokens))} tokens` : ""}${task.lastError ? ` · ${task.lastError}` : ""}`
      );
    }
    const inFlight = (status.inFlight?.tasks as Array<Record<string, unknown>> | undefined) ?? [];
    for (const task of inFlight) {
      console.log(
        `    ~ ${task.kind} ${task.key}${task.label ? ` (${task.label})` : ""} (${Math.round(Number(task.ageMs ?? 0) / 1000)}s)`
      );
    }
  }
}

function parseSince(value: string | undefined): number | null {
  if (!value) return null;
  const minutes = parseDurationMinutes(value);
  return minutes === null ? null : Date.now() - minutes * 60 * 1000;
}

async function report(flags: Flags): Promise<void> {
  const profileName = await resolveProfileName(flags);
  const jp = profilePaths(profileName);
  const state = await loadState(jp);
  const aggregate = Boolean(flags.all || flags.since);
  if (!aggregate) {
    const summary = state.lastRun;
    if (flags.json) {
      console.log(JSON.stringify(summary, null, 2));
      return;
    }
    if (!summary) {
      console.log("No run summary yet.");
      return;
    }
    const running = Boolean(await readPid(jp));
    const inProgress = running && !summary.clean;
    console.log(formatRunSummary(summary, { files: true, inProgress }));
    if (!summary.clean && !inProgress) {
      console.log("");
      console.log("This run did not shut down cleanly; counts reflect the last saved state.");
    }
    return;
  }
  const since = parseSince(str(flags, "since"));
  const entries = await readHistory(jp, 50_000);
  const filtered = since ? entries.filter((entry) => new Date(entry.at).getTime() >= since) : entries;
  const counts: Record<string, number> = {};
  const issues = new Set<number | string>();
  const prs = new Set<string>();
  for (const entry of filtered) {
    counts[entry.type] = (counts[entry.type] ?? 0) + 1;
    if (entry.issue !== undefined && entry.issue !== null) issues.add(entry.issue);
    const pr = entry.data?.pr;
    if (typeof pr === "string") prs.add(pr);
  }
  const openEscalations = Object.values(state.escalations).filter((escalation) => escalation.status === "open");
  let status: Record<string, any> | null = null;
  if (existsSync(jp.statusFile)) {
    try {
      status = JSON.parse(await readFile(jp.statusFile, "utf8")) as Record<string, any>;
    } catch {
      status = null;
    }
  }
  const data = {
    profile: profileName,
    since: since ? new Date(since).toISOString() : null,
    cycles: state.cycles,
    counters: state.counters,
    history: counts,
    deliveries: state.run.deliveries,
    openEscalations: openEscalations.length,
    issuesTouched: [...issues],
    prsTouched: [...prs],
    stopReason: status?.run?.stopReason ?? state.run.stopReason ?? state.lastRun?.stopReason ?? null,
    limits: status?.run?.limits ?? state.run.limits ?? null,
    tokens: status?.tokens ?? state.run.tokens ?? state.lastRun?.tokens ?? null,
    lastCycle: status?.lastCycle ?? state.lastCycle ?? null
  };
  if (flags.json) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  console.log(`Report for ${profileName}${since ? ` since ${data.since}` : ""}`);
  console.log(`  cycles: ${data.cycles}`);
  console.log(`  deliveries this run: ${data.deliveries}`);
  console.log(`  stop reason: ${data.stopReason ?? "-"}`);
  if (data.limits) {
    console.log(
      `  limit: ${data.limits.maxRuntimeMinutes != null ? `${data.limits.maxRuntimeMinutes}m` : "none"}` +
        `${data.limits.maxCycles != null ? ` · ${data.limits.maxCycles} cycles` : ""}` +
        `${data.limits.maxDeliveriesTotal != null ? ` · ${data.limits.maxDeliveriesTotal} deliveries` : ""}`
    );
  }
  const today = new Date().toISOString().slice(0, 10);
  const daily = state.counters[today] ?? { deliveries: 0, reviews: 0, discoveries: 0, aux: 0, errors: 0 };
  console.log(
    `  today: ${daily.deliveries} deliveries · ${daily.reviews} reviews · ${daily.discoveries} discoveries · ${daily.aux} aux · ${daily.errors} errors`
  );
  console.log(
    `  tokens: ${data.tokens?.total ?? 0} (${data.tokens?.input ?? 0} in / ${data.tokens?.output ?? 0} out)`
  );
  console.log(`  history: ${JSON.stringify(counts)}`);
  console.log(`  failures: ${counts.failure ?? 0}`);
  console.log(`  open escalations: ${data.openEscalations}`);
  console.log(`  issues touched: ${data.issuesTouched.length}  PRs touched: ${data.prsTouched.length}`);
  if (data.lastCycle) {
    console.log(
      `  last cycle: ${data.lastCycle.ms}ms · deliveries ${data.lastCycle.deliveries} · reviews ${data.lastCycle.reviews} · aux ${data.lastCycle.aux}`
    );
  }
}

async function historyCommand(flags: Flags): Promise<void> {
  const profileName = await resolveProfileName(flags);
  const limit = Number(str(flags, "limit") ?? 50);
  const entries = await readHistory(profilePaths(profileName), Number.isFinite(limit) ? limit : 50);
  if (!entries.length) {
    console.log("No history yet.");
    return;
  }
  for (const entry of entries) {
    const target = entry.issue ? `#${entry.issue}` : entry.idea ? `idea #${entry.idea}` : "";
    console.log(`${entry.at}  ${entry.type.padEnd(12)} ${target} ${entry.detail ?? ""}`.trimEnd());
  }
}

async function followFile(file: string, lines: number): Promise<void> {
  if (!existsSync(file)) {
    console.log(`No log yet: ${file}`);
    return;
  }
  const info = await stat(file);
  const start = Math.max(0, info.size - 200_000);
  const handle = await import("node:fs/promises").then((fs) => fs.open(file, "r"));
  try {
    const buffer = Buffer.alloc(info.size - start);
    await handle.read(buffer, 0, buffer.length, start);
    const text = buffer.toString();
    const all = text.split("\n");
    process.stdout.write(`${all.slice(-lines).join("\n")}\n`);
  } finally {
    await handle.close();
  }
  let position = info.size;
  setInterval(async () => {
    try {
      const current = await stat(file);
      if (current.size <= position) return;
      const handle2 = await import("node:fs/promises").then((fs) => fs.open(file, "r"));
      try {
        const buffer = Buffer.alloc(current.size - position);
        await handle2.read(buffer, 0, buffer.length, position);
        process.stdout.write(buffer.toString());
        position = current.size;
      } finally {
        await handle2.close();
      }
    } catch {
      // ignore
    }
  }, 500);
}

async function logs(flags: Flags): Promise<void> {
  const profileName = await resolveProfileName(flags);
  const file = path.join(profilePaths(profileName).logsDir, `auto-work.${profileName}.log`);
  const lines = Number(str(flags, "lines") ?? 80);
  if (flags.follow) {
    await followFile(file, lines);
    return;
  }
  if (!existsSync(file)) {
    console.log(`No log yet: ${file}`);
    return;
  }
  const text = await readFile(file, "utf8");
  process.stdout.write(`${text.split("\n").slice(-lines).join("\n")}\n`);
}

async function escalations(flags: Flags): Promise<void> {
  const profileName = await resolveProfileName(flags);
  const state = await loadState(profilePaths(profileName));
  const open = Object.values(state.escalations).filter((escalation) => escalation.status === "open");
  if (!open.length) {
    console.log("Nothing is waiting on you.");
    return;
  }
  let loaded: Awaited<ReturnType<typeof loadProfile>> | null = null;
  try {
    loaded = await loadProfile(profileName);
  } catch {
    loaded = null;
  }
  for (const escalation of open) {
    console.log(`${escalation.type} · #${escalation.issueNumber ?? "?"} ${escalation.issueTitle ?? ""}`);
    console.log(`  ${escalation.body}`);
    console.log(`  id: ${escalation.id}`);
    if (loaded) console.log(`  link: ${escalationUrl(loaded.profile, escalation.issueNumber)}`);
    console.log("");
  }
}

async function memory(flags: Flags): Promise<void> {
  const loaded = await loadProfile(str(flags, "profile"));
  for (const agent of [...loaded.keys.workers, ...loaded.keys.managers]) {
    const client = clientForAgent(agent, loaded.profile);
    try {
      const notes = await client.agentNotes();
      console.log(`${agent.name}: ${notes.items?.length ?? 0} note(s)`);
      for (const note of (notes.items ?? []).slice(0, 10)) {
        console.log(`  [${note.createdAt?.slice(0, 10)}] ${String(note.body).split("\n")[0]?.slice(0, 160)}`);
      }
    } catch (error) {
      console.log(`${agent.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

async function keysCommand(flags: Flags, positionals: string[]): Promise<void> {
  const sub = positionals[0] || "check";
  const baseUrl = str(flags, "base-url") || "https://ziki.dev";
  if (sub === "import") {
    const file = positionals[1] || str(flags, "file") || str(flags, "keys-file");
    if (!file) throw new Error("Usage: auto-work keys import <file>");
    const count = await importKeys(file);
    console.log(`Imported ${count} ZIKI key(s) into ${paths().envFile}`);
  } else if (sub !== "check") {
    throw new Error(`Unknown keys command "${sub}". Use \`auto-work keys import <file>\` or \`auto-work keys check\`.`);
  }
  const env = await loadEnv();
  const inspections = await inspectKeys(env, baseUrl);
  if (!inspections.length) {
    printKeyInstructions();
    process.exitCode = 1;
    return;
  }
  console.log(formatKeyTable(inspections));
  const roles = assignRoles(inspections);
  console.log(`Workers: ${roles.workers.join(", ") || "(none)"}   Managers: ${roles.managers.join(", ") || "(none)"}`);
  if (!roles.managers.length) {
    console.warn("warning: no manager/merger key (optional; merge reviews and manager-only actions will be skipped).");
  }
  if (inspections.some((item) => !item.ok)) process.exitCode = 1;
}

async function configCommand(flags: Flags): Promise<void> {
  const config = await loadConfig();
  if (flags.validate) {
    const result = validateConfig(config);
    for (const warning of result.warnings) console.log(`warn: ${warning}`);
    for (const error of result.errors) console.log(`error: ${error}`);
    console.log(result.ok ? "Valid." : "Invalid.");
    process.exitCode = result.ok ? 0 : 1;
    return;
  }
  console.log(`config: ${paths().configFile}`);
  console.log(`env:    ${paths().envFile}`);
  console.log(`active: ${config.activeProfile}`);
  for (const [name, profile] of Object.entries(config.profiles)) {
    console.log(
      `  ${name}: ${profile.ziki.projectSlug}/${profile.ziki.platform} → ${profile.repo.githubRepo}:${profile.repo.base} (${profile.executor.provider})`
    );
  }
  if (flags.show) console.log(JSON.stringify(config, null, 2));
}

async function prompts(flags: Flags): Promise<void> {
  const loaded = await loadProfile(str(flags, "profile"));
  const dir = loaded.profile.prompts.dir;
  console.log(path.isAbsolute(dir) ? dir : path.join(PACKAGE_ROOT, dir));
  const absolute = path.isAbsolute(dir) ? dir : path.join(PACKAGE_ROOT, dir);
  if (existsSync(absolute)) {
    for (const file of await readdir(absolute)) console.log(`  ${file}`);
  }
}

async function doctor(flags: Flags): Promise<void> {
  const result = await runDoctor({ profileName: str(flags, "profile") });
  console.log(flags.json ? JSON.stringify(result, null, 2) : formatDoctor(result));
  process.exitCode = result.ok ? 0 : 1;
}

async function uninstallCommand(flags: Flags): Promise<void> {
  await runUninstall({
    dryRun: Boolean(flags["dry-run"]),
    keepData: Boolean(flags["keep-data"]),
    yes: Boolean(flags.yes)
  });
}

async function defaultCommand(): Promise<{ command: string; flags: Flags }> {
  let config;
  try {
    config = await loadConfig();
  } catch {
    return { command: "init", flags: {} };
  }
  const name = config.activeProfile || Object.keys(config.profiles)[0] || "";
  if (!name) return { command: "init", flags: {} };
  try {
    await loadProfile(name);
  } catch {
    return { command: "init", flags: {} };
  }
  const pid = await readPid(profilePaths(name));
  if (pid) return { command: "status", flags: { profile: name, line: true } };
  return { command: "start", flags: { profile: name, foreground: true } };
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const parsed = parseArgs(argv);
  let { command, flags, positionals } = parsed;
  if (!command) {
    const routed = await defaultCommand();
    command = routed.command;
    flags = { ...flags, ...routed.flags };
  }
  switch (command) {
    case "install":
      await install(flags);
      break;
    case "init":
      await init(flags);
      break;
    case "keys":
      await keysCommand(flags, positionals);
      break;
    case "uninstall":
      await uninstallCommand(flags);
      break;
    case "detect":
      await detect(flags);
      break;
    case "models":
      await models(flags);
      break;
    case "providers":
      await providersCommand(flags);
      break;
    case "profiles":
      await profiles();
      break;
    case "doctor":
      await doctor(flags);
      break;
    case "start":
      await start(flags);
      break;
    case "run":
      await start({ ...flags, foreground: true });
      break;
    case "stop":
      await stop(flags);
      break;
    case "pause":
      await pause(flags);
      break;
    case "resume":
      await resume(flags);
      break;
    case "status":
      await status(flags);
      break;
    case "report":
      await report(flags);
      break;
    case "history":
      await historyCommand(flags);
      break;
    case "logs":
      await logs(flags);
      break;
    case "escalations":
      await escalations(flags);
      break;
    case "memory":
      await memory(flags);
      break;
    case "config":
      await configCommand(flags);
      break;
    case "prompts":
      await prompts(flags);
      break;
    case "help":
    case "--help":
    case "-h":
      console.log(HELP);
      break;
    default:
      console.error(`Unknown command: ${command}`);
      console.log(HELP);
      process.exitCode = 2;
  }
}
