import { access, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parse, stringify } from "yaml";
import { z } from "zod";

const exitCodeSchema = z.number().int().min(0).max(255);

export const PatchProofConfigSchema = z
  .object({
    version: z.literal(1),
    commands: z
      .object({
        reproduce: z
          .object({
            run: z.string().trim().min(1),
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
        env_passthrough: z.array(z.string().regex(/^[A-Z_][A-Z0-9_]*$/)).default([])
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

  return {
    config: result.data,
    path: absolutePath
  };
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
