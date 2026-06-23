import { execFile } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { parse, stringify } from "yaml";
import { z } from "zod";

const execFileAsync = promisify(execFile);
const exitCodeSchema = z.number().int().min(0).max(255);
const reproduceRuntimeSchema = z.enum(["node", "python"]);
const relativePathSchema = z
  .string()
  .trim()
  .min(1)
  .transform((value, ctx) => {
    try {
      return normalizeRelativePath(value);
    } catch (error) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: error instanceof Error ? error.message : "Path must be repository-relative"
      });
      return z.NEVER;
    }
  });

export const PatchProofConfigSchema = z
  .object({
    version: z.literal(1),
    commands: z
      .object({
        reproduce: z
          .object({
            runtime: reproduceRuntimeSchema.default("node"),
            harness_root: relativePathSchema.default(".patchproof/harness"),
            entrypoint: relativePathSchema.default("reproduce.mjs"),
            args: z.array(z.string()).default([]),
            timeout_ms: z.number().int().positive().max(3_600_000).default(30_000),
            expected_exit_code: z
              .object({
                base: exitCodeSchema.default(1),
                head: exitCodeSchema.default(0)
              })
              .default({})
          })
          .strict(),
        test: z
          .object({
            run: z.string().trim().min(1),
            timeout_ms: z.number().int().positive().max(3_600_000).default(120_000),
            expected_exit_code: exitCodeSchema.default(0)
          })
          .strict()
      })
      .strict(),
    output: z
      .object({
        limit_bytes: z.number().int().min(1024).max(10_000_000).default(1_000_000)
      })
      .strict()
      .default({}),
    runtime: z
      .object({
        env_passthrough: z
          .array(z.string().regex(/^[A-Z_][A-Z0-9_]*$/))
          .max(0, "env_passthrough is disabled for untrusted verification")
          .default([])
      })
      .strict()
      .default({}),
    risk: z
      .object({
        dependency_files: z.array(z.string().trim().min(1)).default([]),
        public_api_files: z.array(z.string().trim().min(1)).default([])
      })
      .strict()
      .default({}),
    codex: z
      .object({
        enabled: z.boolean().default(false),
        max_context_bytes: z.number().int().min(1024).max(200_000).default(32_000)
      })
      .strict()
      .default({})
  })
  .strict();

export type PatchProofConfig = z.infer<typeof PatchProofConfigSchema>;

export interface LoadedPatchProofConfig {
  config: PatchProofConfig;
  path: string;
}

export interface LoadedGitPatchProofConfig extends LoadedPatchProofConfig {
  blobSha: string;
  sourceRef: string;
  sourceSha: string;
}

export class ConfigError extends Error {
  public constructor(
    message: string,
    public readonly originalError?: unknown
  ) {
    super(message);
    this.name = "ConfigError";
  }
}

export const DEFAULT_CONFIG_FILE = "patchproof.yml";
export const DEFAULT_HARNESS_ROOT = ".patchproof/harness";
export const DEFAULT_HARNESS_ENTRYPOINT = "reproduce.mjs";
export const DEFAULT_REPRO_TARGET = ".patchproof/repro-target.mjs";
export const DEFAULT_TEST_TARGET = ".patchproof/test-target.mjs";

export function createDefaultConfig(): PatchProofConfig {
  return PatchProofConfigSchema.parse({
    version: 1,
    commands: {
      reproduce: {
        runtime: "node",
        harness_root: DEFAULT_HARNESS_ROOT,
        entrypoint: DEFAULT_HARNESS_ENTRYPOINT,
        args: ["node", DEFAULT_REPRO_TARGET],
        expected_exit_code: {
          base: 1,
          head: 0
        }
      },
      test: {
        run: `node ${DEFAULT_TEST_TARGET}`
      }
    },
    risk: {
      dependency_files: [],
      public_api_files: []
    }
  });
}

export function formatDefaultConfig(config: PatchProofConfig = createDefaultConfig()): string {
  return stringify(config, {
    aliasDuplicateObjects: false,
    lineWidth: 100
  });
}

export function parsePatchProofConfig(
  raw: string,
  configPath = DEFAULT_CONFIG_FILE
): PatchProofConfig {
  let parsed: unknown;
  try {
    parsed = parse(raw);
  } catch (error) {
    throw new ConfigError(`Could not parse ${configPath} as YAML`, error);
  }

  const result = PatchProofConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new ConfigError(`Invalid ${configPath}: ${result.error.message}`, result.error);
  }

  return result.data;
}

export async function loadPatchProofConfig(
  cwd: string,
  configPath = DEFAULT_CONFIG_FILE
): Promise<LoadedPatchProofConfig> {
  const absolutePath = resolve(cwd, configPath);

  let raw: string;
  try {
    raw = await readFile(absolutePath, "utf8");
  } catch (error) {
    throw new ConfigError(`Could not read ${configPath}`, error);
  }

  return {
    config: parsePatchProofConfig(raw, configPath),
    path: absolutePath
  };
}

export async function loadPatchProofConfigFromGit(
  repoPath: string,
  ref: string,
  configPath = DEFAULT_CONFIG_FILE
): Promise<LoadedGitPatchProofConfig> {
  const safePath = normalizeRelativeConfigPath(configPath);

  try {
    const sourceSha = (
      await execFileAsync("git", ["rev-parse", "--verify", `${ref}^{commit}`], {
        cwd: repoPath
      })
    ).stdout
      .toString()
      .trim();
    const raw = (
      await execFileAsync("git", ["show", `${sourceSha}:${safePath}`], {
        cwd: repoPath,
        maxBuffer: 10 * 1024 * 1024
      })
    ).stdout.toString();
    const blobSha = await getGitBlobSha(repoPath, sourceSha, safePath);

    return {
      blobSha,
      config: parsePatchProofConfig(raw, safePath),
      path: safePath,
      sourceRef: ref,
      sourceSha
    };
  } catch (error) {
    if (error instanceof ConfigError) {
      throw error;
    }
    throw new ConfigError(`Could not read trusted ${safePath} from ${ref}`, error);
  }
}

export async function getGitBlobSha(
  repoPath: string,
  ref: string,
  configPath = DEFAULT_CONFIG_FILE
): Promise<string> {
  const safePath = normalizeRelativeConfigPath(configPath);
  const { stdout } = await execFileAsync("git", ["rev-parse", `${ref}:${safePath}`], {
    cwd: repoPath
  });
  return stdout.toString().trim();
}

export async function getGitTreeSha(
  repoPath: string,
  ref: string,
  treePath: string
): Promise<string> {
  const safePath = normalizeRelativePath(treePath);
  const { stdout } = await execFileAsync("git", ["rev-parse", `${ref}:${safePath}`], {
    cwd: repoPath
  });
  return stdout.toString().trim();
}

export async function tryGetGitTreeSha(
  repoPath: string,
  ref: string,
  treePath: string
): Promise<string | null> {
  try {
    return await getGitTreeSha(repoPath, ref, treePath);
  } catch {
    return null;
  }
}

export async function listGitTreeFiles(
  repoPath: string,
  ref: string,
  treePath: string
): Promise<string[]> {
  const safePath = normalizeRelativePath(treePath);
  const { stdout } = await execFileAsync(
    "git",
    ["ls-tree", "-r", "-z", "--name-only", ref, "--", safePath],
    {
      cwd: repoPath,
      maxBuffer: 10 * 1024 * 1024
    }
  );

  return stdout
    .toString()
    .split("\0")
    .map((path) => path.trim())
    .filter(Boolean)
    .map(normalizeRelativePath)
    .sort();
}

export async function readGitFile(
  repoPath: string,
  ref: string,
  filePath: string
): Promise<Buffer> {
  const safePath = normalizeRelativePath(filePath);
  const { stdout } = await execFileAsync("git", ["show", `${ref}:${safePath}`], {
    cwd: repoPath,
    encoding: "buffer",
    maxBuffer: 10 * 1024 * 1024
  });
  return Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
}

export async function tryGetGitBlobSha(
  repoPath: string,
  ref: string,
  configPath = DEFAULT_CONFIG_FILE
): Promise<string | null> {
  try {
    return await getGitBlobSha(repoPath, ref, configPath);
  } catch {
    return null;
  }
}

export async function writeInitialConfig(
  cwd: string,
  configPath = DEFAULT_CONFIG_FILE
): Promise<string> {
  const absolutePath = resolve(cwd, configPath);

  try {
    await access(absolutePath);
    throw new ConfigError(`${configPath} already exists`);
  } catch (error) {
    if (error instanceof ConfigError) {
      throw error;
    }
  }

  await writeFile(absolutePath, formatDefaultConfig(), "utf8");
  await writeInitialHarnessFiles(cwd);
  return absolutePath;
}

export function resolveConfigPath(cwd: string, configPath = DEFAULT_CONFIG_FILE): string {
  return join(cwd, configPath);
}

function normalizeRelativeConfigPath(configPath: string): string {
  return normalizeRelativePath(configPath);
}

export function normalizeRelativePath(path: string): string {
  if (isAbsolute(path)) {
    throw new ConfigError("Path must be relative");
  }

  const normalized = normalize(path);
  if (normalized === ".") {
    throw new ConfigError("Path must name a file");
  }
  if (normalized === ".." || normalized.startsWith(`..${sep}`)) {
    throw new ConfigError("Path must stay inside the repository");
  }

  return normalized.replaceAll("\\", "/");
}

async function writeInitialHarnessFiles(cwd: string): Promise<void> {
  const harnessPath = resolve(cwd, DEFAULT_HARNESS_ROOT, DEFAULT_HARNESS_ENTRYPOINT);
  const targetPath = resolve(cwd, DEFAULT_REPRO_TARGET);
  const testPath = resolve(cwd, DEFAULT_TEST_TARGET);
  await mkdir(dirname(harnessPath), { recursive: true });
  await mkdir(dirname(targetPath), { recursive: true });
  await mkdir(dirname(testPath), { recursive: true });
  await writeFile(harnessPath, defaultHarnessSource(), { encoding: "utf8", flag: "wx" });
  await writeFile(targetPath, defaultReproTargetSource(), { encoding: "utf8", flag: "wx" });
  await writeFile(testPath, defaultTestTargetSource(), { encoding: "utf8", flag: "wx" });
}

export function defaultHarnessSource(): string {
  return `import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

function writeResult(nonce, status) {
  writeFileSync(4, \`\${JSON.stringify({ nonce, status })}\\n\`, "utf8");
}

function main() {
  let nonce;
  try {
    const challenge = JSON.parse(readFileSync(3, "utf8"));
    nonce = challenge.nonce;
    if (typeof nonce !== "string" || nonce.length === 0) {
      throw new Error("missing nonce");
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }

  const [command, ...args] = process.argv.slice(2);
  if (!command) {
    writeResult(nonce, "setup_error");
    process.exit(2);
  }

  const child = spawn(command, args, {
    cwd: process.cwd(),
    env: process.env,
    shell: false,
    stdio: ["ignore", "inherit", "inherit"]
  });

  child.on("error", (error) => {
    console.error(error.message);
    writeResult(nonce, "setup_error");
    process.exit(2);
  });

  child.on("close", (exitCode, signal) => {
    if (signal) {
      writeResult(nonce, "setup_error");
      process.exit(2);
    }
    writeResult(nonce, exitCode === 0 ? "assertion_passed" : "assertion_failed");
    process.exit(exitCode === null ? 2 : exitCode);
  });
}

main();
`;
}

export function defaultReproTargetSource(): string {
  return `console.error("Configure ${DEFAULT_REPRO_TARGET} with a deterministic reproduction check.");
process.exit(1);
`;
}

export function defaultTestTargetSource(): string {
  return `console.log("Configure ${DEFAULT_TEST_TARGET} with the project test command.");
process.exit(0);
`;
}
