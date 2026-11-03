import { existsSync } from "node:fs";
import { chmod, cp, mkdir, readFile, readdir, stat, symlink, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import type { CheckSpec, Config, ProfileConfig, ProviderName } from "./types.js";
import {
  DEFAULT_LIMITS,
  PROVIDERS,
  deepMerge,
  defaultConfig,
  loadConfig,
  loadEnv,
  loadProfile,
  parseEnvFile,
  resolveModel,
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
import { loadState } from "./state.js";
import { clientForAgent } from "./ziki.js";
import { getProvider } from "./providers/index.js";
import {
  assignRoles,
  formatKeyTable,
  inspectKeys,
  knownProjects,
  listPlatforms,
  projectSummary
} from "./keys.js";
import { runUninstall } from "./uninstall.js";

const REPO_URL = "https://github.com/peter-abah/ziki-auto-work";

const HELP = `auto-work — autonomous Ziki work loop

Usage:
  auto-work install [--keys-file <path>] [--service] [--profile <name>]
  auto-work init [--keys-file <path>] [--profile <name>] [--example <name>] [--from-file <path>] [--yes]
  auto-work keys import <file>
  auto-work keys check
  auto-work uninstall [--dry-run] [--keep-data] [--yes]
  auto-work detect [--json]
  auto-work models [--provider <p>] [--profile <name>] [--json]
  auto-work profiles
  auto-work doctor [--profile <name>]
  auto-work start [--profile <name>] [--foreground] [--once] [--dry-run] [--all]
  auto-work run [--profile <name>] [--once] [--dry-run]
  auto-work stop [--profile <name>] [--all]
  auto-work pause [--profile <name>]
  auto-work resume [--profile <name>]
  auto-work status [--profile <name>] [--all]
  auto-work logs [--profile <name>] [--lines 80] [--follow]
  auto-work escalations [--profile <name>]
  auto-work memory [--profile <name>]
  auto-work config [--show] [--validate]
  auto-work prompts [--profile <name>]

Environment overrides:
  AUTO_WORK_HOME, AUTO_WORK_CONFIG_DIR, AUTO_WORK_STATE_DIR, AUTO_WORK_CACHE_DIR
`;

interface Flags {
  [key: string]: string | boolean | undefined;
}

function parseArgs(argv: string[]): { command: string; flags: Flags; positionals: string[] } {
  const [command = "help", ...rest] = argv;
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
  console.log("  ZIKI_KEY1=...   # manager");
  console.log("  ZIKI_KEY2=...   # working");
  console.log("");
  console.log("Import and validate them:");
  console.log("  auto-work keys import keys.env");
  console.log("");
  console.log(`Keys are stored in ${p.envFile} (mode 600), never in config or git.`);
}

async function installBinShim(): Promise<string> {
  const p = paths();
  const target = path.join(p.packageRoot, "bin/auto-work.mjs");
  if (process.platform === "win32") {
    await mkdir(path.dirname(p.bin), { recursive: true });
    await writeFile(p.bin, `@echo off\r\n"${process.execPath}" "${target}" %*\r\n`, "utf8");
    return p.bin;
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
        baseline: true,
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
  return [];
}

function detectedStack(): string {
  if (existsSync(path.join(process.cwd(), "pubspec.yaml"))) return "flutter";
  if (existsSync(path.join(process.cwd(), "package.json"))) return "node";
  if (existsSync(path.join(process.cwd(), "pyproject.toml"))) return "python";
  if (existsSync(path.join(process.cwd(), "go.mod"))) return "go";
  if (existsSync(path.join(process.cwd(), "Cargo.toml"))) return "rust";
  return "generic";
}

async function detectedProviders(): Promise<ProviderName[]> {
  const found: ProviderName[] = [];
  for (const provider of ["opencode", "claude", "codex", "gemini"] as ProviderName[]) {
    const result = await runCommand(provider, ["--version"], { timeoutMs: 10_000 });
    if (result.ok) found.push(provider);
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
      discovery: { enabled: false, maxIdeasPerRun: 3 },
      limits: { ...DEFAULT_LIMITS },
      pollSeconds: 120,
      memoryRefreshMinutes: 30,
      hitl: { enabled: true, defaultType: "question", notifyCommand: null }
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
    console.warn("warning: no manager/merger key. Awards, confirmations and merge reviews will not run.");
  }
  if (!roles.workers.length) {
    console.warn("warning: no working key. Deliveries will not run.");
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

  const checksName = str(flags, "checks") || (yes ? stack : await ask("Checks preset (flutter/node/python/none)", stack));
  const parity = str(flags, "parity") || (yes ? "" : await ask("Parity/context file (optional)", ""));

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
      `Set up auto-work in this repository. Read ${path.join(PACKAGE_ROOT, "docs/AI-SETUP.md")} and follow it exactly. Detect the environment first, ask only for what is missing, write the config, run \`auto-work config --validate\`, \`auto-work doctor\`, and \`auto-work run --once --dry-run\`. Do not start the loop.`
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
  if (!PROVIDERS.includes(providerName)) throw new Error(`Unknown provider "${providerName}"`);
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
  if (flags.all) {
    const results = [];
    for (const name of Object.keys(config.profiles)) {
      results.push({ name, ...(await startService(name)) });
    }
    for (const result of results) console.log(`${result.name}: ${result.mode}${result.pid ? ` (pid ${result.pid})` : ""}`);
    return;
  }
  const profileName = await resolveProfileName(flags);
  if (!profileName) throw new Error("No profile configured. Run `auto-work init`.");
  const once = Boolean(flags.once);
  const dryRun = Boolean(flags["dry-run"]);
  if (flags.foreground || once || dryRun) {
    const { runLoop } = await import("./orchestrator.js");
    const code = await runLoop({ profileName, foreground: true, once, dryRun });
    process.exitCode = code;
    return;
  }
  const result = await startService(profileName);
  if (result.mode === "already-running") {
    console.log(`Already running (pid ${result.pid}).`);
    return;
  }
  console.log(`Started (${result.mode})${result.pid ? ` pid ${result.pid}` : ""}.`);
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

async function status(flags: Flags): Promise<void> {
  const config = await loadConfig();
  const names = flags.all ? Object.keys(config.profiles) : [await resolveProfileName(flags)];
  for (const name of names.filter(Boolean)) {
    const result = await statusService(name);
    console.log(
      `\n${name}: ${result.running ? `running (pid ${result.pid})` : "not running"}${result.paused ? " [paused]" : ""}`
    );
    if (result.status) {
      console.log(`  cycles: ${result.status.cycles ?? 0}  last: ${result.status.lastCycleAt ?? "never"}`);
      console.log(`  counters: ${JSON.stringify(result.status.counters ?? {})}`);
      const escalations = (result.status.escalations as Array<Record<string, unknown>> | undefined) ?? [];
      if (escalations.length) {
        console.log("  needs you:");
        for (const escalation of escalations) {
          console.log(`    - ${escalation.type} #${escalation.issue}: ${escalation.body}`);
        }
      }
    }
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
  for (const escalation of open) {
    console.log(`${escalation.type} · #${escalation.issueNumber ?? "?"} ${escalation.issueTitle ?? ""}`);
    console.log(`  ${escalation.body}`);
    console.log(`  id: ${escalation.id}`);
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
  if (!roles.managers.length) console.warn("warning: no manager/merger key.");
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
  console.log(formatDoctor(result));
  process.exitCode = result.ok ? 0 : 1;
}

async function uninstallCommand(flags: Flags): Promise<void> {
  await runUninstall({
    dryRun: Boolean(flags["dry-run"]),
    keepData: Boolean(flags["keep-data"]),
    yes: Boolean(flags.yes)
  });
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const { command, flags, positionals } = parseArgs(argv);
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
