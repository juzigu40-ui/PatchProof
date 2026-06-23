import { execFile } from "node:child_process";
import { access, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, normalize, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { parse, stringify } from "yaml";
import { z } from "zod";

const execFileAsync = promisify(execFile);
const exitCodeSchema = z.number().int().min(0).max(255);
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
            run: z.string().trim().min(1),
            harness_files: z
              .array(relativePathSchema)
              .min(1, "commands.reproduce.harness_files must list trusted harness files"),
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

export function createDefaultConfig(): PatchProofConfig {
  return PatchProofConfigSchema.parse({
    version: 1,
    commands: {
      reproduce: {
        run: "pnpm test -- --run patchproof-repro",
        harness_files: ["patchproof.yml"],
        expected_exit_code: {
          base: 1,
          head: 0
        }
      },
      test: {
        run: "pnpm test -- --run"
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
