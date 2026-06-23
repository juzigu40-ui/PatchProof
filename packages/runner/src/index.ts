import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface CommandResult {
  command: string;
  cwd: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  durationMs: number;
  timedOut: boolean;
}

export interface RunCommandOptions {
  command: string;
  args?: readonly string[];
  cwd: string;
  timeoutMs: number;
  outputLimitBytes: number;
  displayCommand?: string;
  env?: NodeJS.ProcessEnv;
  extraFiles?: readonly RunCommandExtraFile[];
  shell?: boolean;
}

export interface RunCommandExtraFile {
  fd: number;
  path: string;
  flags: "r" | "w";
}

export interface CreateCommandEnvironmentOptions {
  passthrough?: readonly string[];
  overrides?: NodeJS.ProcessEnv;
}

export const SAFE_ENV_KEYS = new Set([
  "CI",
  "FORCE_COLOR",
  "GITHUB_ACTIONS",
  "LANG",
  "LC_ALL",
  "NO_COLOR",
  "PATH",
  "PNPM_HOME",
  "RUNNER_OS",
  "SHELL",
  "TEMP",
  "TMP",
  "TMPDIR"
]);

export function createCommandEnvironment(
  source: NodeJS.ProcessEnv = process.env,
  options: readonly string[] | CreateCommandEnvironmentOptions = []
): NodeJS.ProcessEnv {
  const passthrough = isStringArray(options) ? options : (options.passthrough ?? []);
  const overrides = isStringArray(options) ? {} : (options.overrides ?? {});
  const keys = new Set([...SAFE_ENV_KEYS, ...passthrough]);
  const env: NodeJS.ProcessEnv = {};

  for (const key of keys) {
    const value = source[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }

  return {
    ...env,
    ...overrides
  };
}

function isStringArray(
  value: readonly string[] | CreateCommandEnvironmentOptions
): value is readonly string[] {
  return Array.isArray(value);
}

export async function runCommand(options: RunCommandOptions): Promise<CommandResult> {
  const started = process.hrtime.bigint();
  const stdout = createLimitedCapture(options.outputLimitBytes);
  const stderr = createLimitedCapture(options.outputLimitBytes);
  const openedFiles: number[] = [];

  return await new Promise((resolve) => {
    const stdio: ("ignore" | "pipe" | number)[] = ["ignore", "pipe", "pipe"];
    for (const file of options.extraFiles ?? []) {
      if (file.fd < 3) {
        throw new Error("extra file descriptors must be 3 or greater");
      }
      const opened = openSync(file.path, file.flags);
      openedFiles.push(opened);
      while (stdio.length <= file.fd) {
        stdio.push("ignore");
      }
      stdio[file.fd] = opened;
    }

    const child = spawn(options.command, options.args ? [...options.args] : [], {
      cwd: options.cwd,
      env: options.env ?? createCommandEnvironment(),
      detached: process.platform !== "win32",
      shell: options.shell ?? options.args === undefined,
      stdio,
      windowsHide: true
    });
    closeOpenedFiles(openedFiles);

    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      killProcessTree(child.pid, "SIGTERM");
      setTimeout(() => {
        killProcessTree(child.pid, "SIGKILL");
      }, 500).unref();
    }, options.timeoutMs);
    timeout.unref();

    child.stdout?.on("data", (chunk: Buffer) => stdout.append(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.append(chunk));

    child.on("error", (error) => {
      stderr.append(Buffer.from(error.message));
    });

    child.on("close", (exitCode, signal) => {
      closeOpenedFiles(openedFiles);
      clearTimeout(timeout);
      const finished = process.hrtime.bigint();
      resolve({
        command: options.displayCommand ?? formatCommand(options.command, options.args),
        cwd: options.cwd,
        exitCode,
        signal,
        stdout: stdout.text(),
        stderr: stderr.text(),
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
        durationMs: Number((finished - started) / 1_000_000n),
        timedOut
      });
    });
  });
}

function formatCommand(command: string, args: readonly string[] | undefined): string {
  if (!args || args.length === 0) {
    return command;
  }
  return [command, ...args].map(shellQuote).join(" ");
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=@+-]+$/.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function closeOpenedFiles(openedFiles: number[]): void {
  while (openedFiles.length > 0) {
    const fd = openedFiles.pop();
    if (fd === undefined) {
      continue;
    }
    try {
      closeSync(fd);
    } catch {
      // The descriptor may already be closed after spawn setup or error handling.
    }
  }
}

function killProcessTree(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) {
    return;
  }

  try {
    if (process.platform === "win32") {
      process.kill(pid, signal);
      return;
    }
    process.kill(-pid, signal);
  } catch {
    // The process may have exited naturally between timeout handling steps.
  }
}

function createLimitedCapture(limitBytes: number): {
  readonly truncated: boolean;
  append(chunk: Buffer): void;
  text(): string;
} {
  const chunks: Buffer[] = [];
  let capturedBytes = 0;
  let truncated = false;

  return {
    get truncated() {
      return truncated;
    },
    append(chunk: Buffer) {
      if (capturedBytes >= limitBytes) {
        truncated = true;
        return;
      }

      const remaining = limitBytes - capturedBytes;
      if (chunk.byteLength <= remaining) {
        chunks.push(chunk);
        capturedBytes += chunk.byteLength;
        return;
      }

      chunks.push(chunk.subarray(0, remaining));
      capturedBytes = limitBytes;
      truncated = true;
    },
    text() {
      return Buffer.concat(chunks).toString("utf8");
    }
  };
}

export interface Worktree {
  path: string;
  ref: string;
  sha: string;
}

export async function resolveCommit(repoPath: string, ref: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["rev-parse", "--verify", `${ref}^{commit}`], {
    cwd: repoPath
  });
  return stdout.trim();
}

export async function listChangedFiles(
  repoPath: string,
  baseSha: string,
  headSha: string
): Promise<string[]> {
  const { stdout } = await execFileAsync("git", ["diff", "--name-only", baseSha, headSha], {
    cwd: repoPath,
    maxBuffer: 10 * 1024 * 1024
  });

  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

export async function createWorktree(
  repoPath: string,
  worktreeRoot: string,
  label: string,
  ref: string,
  sha: string
): Promise<Worktree> {
  const path = join(worktreeRoot, `${label}-${randomUUID()}`);
  await mkdir(dirname(path), { recursive: true });
  await execFileAsync("git", ["worktree", "add", "--detach", path, sha], {
    cwd: repoPath,
    maxBuffer: 10 * 1024 * 1024
  });
  return { path, ref, sha };
}

export async function removeWorktree(repoPath: string, worktreePath: string): Promise<void> {
  try {
    await execFileAsync("git", ["worktree", "remove", "--force", worktreePath], {
      cwd: repoPath,
      maxBuffer: 10 * 1024 * 1024
    });
  } catch {
    await rm(worktreePath, { force: true, recursive: true });
  }
}
