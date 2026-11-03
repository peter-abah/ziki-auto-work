import { existsSync } from "node:fs";
import { chmod, copyFile, cp, mkdir, readFile, readdir, stat, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import type { CheckSpec, Config, JobConfig, ProviderName, Role } from "./types.js";
import {
  DEFAULT_LIMITS,
  PROVIDERS,
  deepMerge,
  defaultConfig,
  loadConfig,
  loadEnv,
  loadJob,
  migrateConfig,
  parseEnvFile,
  resolveModel,
  sampleConfigPath,
  saveConfig,
  saveEnv,
  validateConfig
} from "./config.js";
import { PACKAGE_ROOT, expandHome, jobPaths, paths, safeName } from "./platform/paths.js";
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
import { loadState, setPaused, setStopped } from "./state.js";
import { clientForAgent } from "./ziki.js";
import { getProvider } from "./providers/index.js";

const HELP = `auto-work — autonomous Ziki work loop

Usage:
  auto-work install [--keys-file <path>] [--service] [--job <name>]
  auto-work init [--job <name>] [--example <name>] [--from-file <path>] [--yes]
  auto-work detect [--json]
  auto-work models [--provider <p>] [--job <name>] [--json]
  auto-work jobs
  auto-work doctor [--job <name>]
  auto-work start [--job <name>] [--foreground] [--once] [--dry-run] [--all]
  auto-work run [--job <name>] [--once] [--dry-run]
  auto-work stop [--job <name>] [--all]
  auto-work pause [--job <name>]
  auto-work resume [--job <name>]
  auto-work status [--job <name>] [--all]
  auto-work logs [--job <name>] [--lines 80] [--follow]
  auto-work escalations [--job <name>]
  auto-work memory [--job <name>]
  auto-work config [--show] [--validate] [--migrate]
  auto-work prompts [--job <name>]

Environment overrides:
  AUTO_WORK_HOME, AUTO_WORK_CONFIG_DIR, AUTO_WORK_STATE_DIR, AUTO_WORK_CACHE_DIR
`;

interface Flags {
  [key: string]: string | boolean | undefined;
}

function parseArgs(argv: string[]): { command: string; flags: Flags } {
  const [command = "help", ...rest] = argv;
  const flags: Flags = {};
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index]!;
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = rest[index + 1];
    if (next && !next.startsWith("--")) {
      flags[key] = next;
      index += 1;
    } else {
      flags[key] = true;
    }
  }
  return { command, flags };
}

function str(flags: Flags, key: string): string | undefined {
  const value = flags[key];
  return typeof value === "string" ? value : undefined;
}

async function resolveJobName(flags: Flags): Promise<string> {
  const config = await loadConfig();
  return str(flags, "job") || config.activeJob || Object.keys(config.jobs)[0] || "";
}

async function importKeys(keysFile: string): Promise<number> {
  const text = await readFile(keysFile, "utf8");
  const parsed = parseEnvFile(text);
  const keys = Object.fromEntries(Object.entries(parsed).filter(([key]) => key.startsWith("ZIKI_")));
  const existing = await loadEnv();
  await saveEnv({ ...existing, ...keys });
  return Object.keys(keys).length;
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
  await mkdir(p.jobsDir, { recursive: true });

  if (!existsSync(p.configFile)) {
    await saveConfig(defaultConfig());
  }

  const keysFile = str(flags, "keys-file") || process.env.AUTO_WORK_KEYS_FILE;
  if (keysFile) {
    const count = await importKeys(keysFile);
    console.log(`Imported ${count} ZIKI key(s) into ${p.envFile}`);
  }

  const bin = await installBinShim();
  const jobName = await resolveJobName(flags);
  if ((flags.service || flags.systemd) && jobName) {
    const result = await installService(jobName);
    console.log(result.ok ? `Service installed (${result.mode}): ${result.file}` : `Service setup failed: ${result.detail ?? ""}`);
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

async function copyPromptSet(jobName: string): Promise<string> {
  const p = paths();
  const target = path.join(p.configDir, "prompts", safeName(jobName));
  if (!existsSync(target)) {
    await mkdir(target, { recursive: true });
    await cp(path.join(PACKAGE_ROOT, "prompts", "generic"), target, { recursive: true });
  }
  return target;
}

function baseJob(overrides: Partial<JobConfig>): JobConfig {
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
    } as JobConfig,
    { ...defaults, ...overrides }
  ) as JobConfig;
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
  const raw = JSON.parse(await readFile(file, "utf8")) as Config | JobConfig;
  let config: Config;
  if ("version" in raw && "jobs" in raw) {
    config = raw as Config;
  } else {
    config = {
      version: 2,
      activeJob: "default",
      jobs: { default: raw as JobConfig }
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

async function initWizard(flags: Flags): Promise<Config> {
  const existing = await loadConfig();
  const stack = detectedStack();
  const providers = await detectedProviders();
  const yes = Boolean(flags.yes);

  const jobName = str(flags, "job") || (yes ? existing.activeJob || "default" : await ask("Job name", existing.activeJob || "default"));
  const projectId = str(flags, "project-id") || (yes ? "" : await ask("Ziki project ID", ""));
  const projectSlug = str(flags, "project-slug") || (yes ? "" : await ask("Ziki project slug", ""));
  const platform = str(flags, "platform") || (yes ? stack : await ask("Platform (desktop/web/mobile/…)", stack));
  const baseUrl = str(flags, "base-url") || (yes ? "https://ziki.dev" : await ask("Ziki base URL", "https://ziki.dev"));
  const repoUrl = str(flags, "repo-url") || (yes ? "" : await ask("Repo clone URL (your fork)", ""));
  const upstream = str(flags, "upstream") || (yes ? repoUrl : await ask("Upstream repo URL", repoUrl));
  const base = str(flags, "base") || (yes ? "main" : await ask("Base branch", "main"));
  const githubRepo = str(flags, "github-repo") || (yes ? "" : await ask("GitHub repo (owner/name)", ""));
  const forkOwner = str(flags, "fork-owner") || (yes ? "" : await ask("Fork owner", ""));
  const defaultBranch = str(flags, "default-branch") || (yes ? "main" : await ask("Default branch", "main"));
  const teamLead = str(flags, "team-lead") || (yes ? "" : await ask("Team lead handle (optional)", ""));
  const workers = str(flags, "workers") || (yes ? "ZIKI_KEY1" : await ask("Worker key env names (comma separated)", "ZIKI_KEY1"));
  const managers = str(flags, "managers") || (yes ? "ZIKI_KEY2" : await ask("Manager key env names (comma separated)", "ZIKI_KEY2"));
  const providerDefault = providers[0] ?? "opencode";
  const provider = (str(flags, "provider") || (yes ? providerDefault : await ask(`Provider (${PROVIDERS.join("/")})`, providerDefault))) as ProviderName;
  const model = str(flags, "model") || (yes ? "" : await ask("Model (blank = provider default)", ""));
  const checksName = str(flags, "checks") || (yes ? stack : await ask("Checks preset (flutter/node/python/none)", stack));
  const parity = str(flags, "parity") || (yes ? "" : await ask("Parity/context file (optional)", ""));

  const promptsDir = await copyPromptSet(jobName);
  const job = baseJob({
    ziki: { baseUrl, projectId, projectSlug, platform },
    repo: { url: repoUrl, upstream, base, githubRepo, forkOwner, defaultBranch, ...(teamLead ? { teamLead } : {}) },
    agents: {
      workers: workers.split(",").map((name) => name.trim()).filter(Boolean),
      managers: managers.split(",").map((name) => name.trim()).filter(Boolean)
    },
    executor: { provider, model: model || null, timeoutMs: 2_700_000, permissionMode: "auto" },
    checks: checkPreset(checksName),
    platformMatch: { keywords: [platform] },
    prompts: { dir: promptsDir },
    pr: { templateFile: path.join(promptsDir, "pr.md"), ...(teamLead ? { teamLead } : {}) },
    discovery: { enabled: Boolean(parity), ...(parity ? { parityFile: parity } : {}) }
  });

  const config: Config = {
    version: 2,
    activeJob: jobName,
    defaults: existing.defaults,
    jobs: { ...existing.jobs, [jobName]: job }
  };
  const validation = validateConfig(config);
  if (!validation.ok) {
    throw new Error(`Config is invalid:\n${validation.errors.join("\n")}`);
  }
  await saveConfig(config);
  return config;
}

async function init(flags: Flags): Promise<void> {
  if (flags["print-ai-prompt"]) {
    console.log(`Set up auto-work in this repository. Read ${path.join(PACKAGE_ROOT, "docs/AI-SETUP.md")} and follow it exactly. Detect the environment first, ask only for what is missing, write the config, run \`auto-work config validate\`, \`auto-work doctor\`, and \`auto-work run --once --dry-run\`. Do not start the loop.`);
    return;
  }
  if (flags.json) {
    const template = await readFile(path.join(PACKAGE_ROOT, "config", "generic.json"), "utf8").catch(() => JSON.stringify(defaultConfig(), null, 2));
    console.log(template);
    return;
  }
  if (flags["from-file"]) {
    const config = await initFromFile(str(flags, "from-file")!);
    console.log(`Config written: ${paths().configFile}`);
    console.log(`Active job: ${config.activeJob}`);
    return;
  }
  if (flags.example) {
    const config = await initFromExample(str(flags, "example")!);
    console.log(`Example installed: ${config.activeJob}`);
    console.log(`Config: ${paths().configFile}`);
    return;
  }
  const config = await initWizard(flags);
  console.log("");
  console.log(`Configured job "${config.activeJob}".`);
  console.log(`Config: ${paths().configFile}`);
  console.log(`Env:    ${paths().envFile}`);
  console.log("");
  console.log("Next:");
  console.log("  auto-work doctor");
  console.log("  auto-work run --once --dry-run");
  console.log("  auto-work start");
}

async function detect(flags: Flags): Promise<void> {
  const stack = detectedStack();
  const providers = await detectedProviders();
  const config = await loadConfig();
  const jobName = config.activeJob || Object.keys(config.jobs)[0] || null;
  const job = jobName ? config.jobs[jobName] : null;
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
    activeJob: jobName,
    provider: job?.executor?.provider ?? null,
    model: job ? resolveModel(job, "worker") : null,
    checks: job?.checks?.map((check) => check.name) ?? []
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
  console.log(`Job:       ${data.activeJob ?? "(none)"}`);
  console.log(`Provider:  ${data.provider ?? "(not configured)"}`);
  console.log(`Model:     ${data.model ?? "(provider default)"}`);
  console.log(`Checks:    ${data.checks.join(", ") || "(none)"}`);
}

async function models(flags: Flags): Promise<void> {
  let loaded = null;
  try {
    loaded = await loadJob(str(flags, "job"));
  } catch {
    loaded = null;
  }
  const providerName = (str(flags, "provider") as ProviderName) || loaded?.job.executor.provider || "opencode";
  if (!PROVIDERS.includes(providerName)) throw new Error(`Unknown provider "${providerName}"`);
  const job = loaded?.job ?? baseJob({ executor: { provider: providerName } });
  const provider = getProvider(providerName, { ...job, executor: { ...job.executor, provider: providerName } });
  const result = await provider.models(job);
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

async function jobs(): Promise<void> {
  const config = await loadConfig();
  if (!Object.keys(config.jobs).length) {
    console.log("No jobs configured. Run `auto-work init`.");
    return;
  }
  for (const [name, job] of Object.entries(config.jobs)) {
    const marker = name === config.activeJob ? "*" : " ";
    console.log(`${marker} ${name}  ${job.ziki.projectSlug}/${job.ziki.platform}  ${job.repo.githubRepo}:${job.repo.base}`);
  }
}

async function start(flags: Flags): Promise<void> {
  const config = await loadConfig();
  if (flags.all) {
    const results = [];
    for (const name of Object.keys(config.jobs)) {
      results.push({ name, ...(await startService(name)) });
    }
    for (const result of results) console.log(`${result.name}: ${result.mode}${result.pid ? ` (pid ${result.pid})` : ""}`);
    return;
  }
  const jobName = await resolveJobName(flags);
  if (!jobName) throw new Error("No job configured. Run `auto-work init`.");
  const once = Boolean(flags.once);
  const dryRun = Boolean(flags["dry-run"]);
  if (flags.foreground || once || dryRun) {
    const { runLoop } = await import("./orchestrator.js");
    const code = await runLoop({ jobName, foreground: true, once, dryRun });
    process.exitCode = code;
    return;
  }
  const result = await startService(jobName);
  if (result.mode === "already-running") {
    console.log(`Already running (pid ${result.pid}).`);
    return;
  }
  console.log(`Started (${result.mode})${result.pid ? ` pid ${result.pid}` : ""}.`);
}

async function stop(flags: Flags): Promise<void> {
  const config = await loadConfig();
  const names = flags.all ? Object.keys(config.jobs) : [await resolveJobName(flags)];
  for (const name of names.filter(Boolean)) {
    const result = await stopService(name);
    console.log(`${name}: stopped${result.pid ? ` (pid ${result.pid})` : ""}`);
  }
}

async function pause(flags: Flags): Promise<void> {
  await pauseService(await resolveJobName(flags));
  console.log("Paused.");
}

async function resume(flags: Flags): Promise<void> {
  await resumeService(await resolveJobName(flags));
  console.log("Resumed.");
}

async function status(flags: Flags): Promise<void> {
  const config = await loadConfig();
  const names = flags.all ? Object.keys(config.jobs) : [await resolveJobName(flags)];
  for (const name of names.filter(Boolean)) {
    const result = await statusService(name);
    console.log(`\n${name}: ${result.running ? `running (pid ${result.pid})` : "not running"}${result.paused ? " [paused]" : ""}`);
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
  const jobName = await resolveJobName(flags);
  const file = path.join(jobPaths(jobName).logsDir, `auto-work.${jobName}.log`);
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
  const jobName = await resolveJobName(flags);
  const state = await loadState(jobPaths(jobName));
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
  const loaded = await loadJob(str(flags, "job"));
  for (const agent of [...loaded.keys.workers, ...loaded.keys.managers]) {
    const client = clientForAgent(agent, loaded.job);
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

async function configCommand(flags: Flags): Promise<void> {
  const config = await loadConfig();
  if (flags.migrate) {
    if (Number((config as unknown as { version?: number }).version) === 1) {
      const migrated = migrateConfig(config as unknown as Record<string, unknown>);
      await saveConfig(migrated);
      console.log("Migrated config to version 2.");
    } else {
      console.log("Config is already version 2.");
    }
    return;
  }
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
  console.log(`active: ${config.activeJob}`);
  for (const [name, job] of Object.entries(config.jobs)) {
    console.log(`  ${name}: ${job.ziki.projectSlug}/${job.ziki.platform} → ${job.repo.githubRepo}:${job.repo.base} (${job.executor.provider})`);
  }
  if (flags.show) console.log(JSON.stringify(config, null, 2));
}

async function prompts(flags: Flags): Promise<void> {
  const loaded = await loadJob(str(flags, "job"));
  const dir = loaded.job.prompts.dir;
  console.log(path.isAbsolute(dir) ? dir : path.join(PACKAGE_ROOT, dir));
  const absolute = path.isAbsolute(dir) ? dir : path.join(PACKAGE_ROOT, dir);
  if (existsSync(absolute)) {
    for (const file of await readdir(absolute)) console.log(`  ${file}`);
  }
}

async function doctor(flags: Flags): Promise<void> {
  const result = await runDoctor({ jobName: str(flags, "job") });
  console.log(formatDoctor(result));
  process.exitCode = result.ok ? 0 : 1;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const { command, flags } = parseArgs(argv);
  switch (command) {
    case "install":
      await install(flags);
      break;
    case "init":
      await init(flags);
      break;
    case "detect":
      await detect(flags);
      break;
    case "models":
      await models(flags);
      break;
    case "jobs":
      await jobs();
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
