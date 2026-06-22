import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { nodeAdapter } from "@patchproof/adapters-node";
import { pythonAdapter } from "@patchproof/adapters-python";
import { ConfigError, DEFAULT_CONFIG_FILE, writeInitialConfig } from "@patchproof/config";
import {
  loadProof,
  renderJsonReport,
  renderMarkdownReport,
  VerificationRuntimeError,
  verifyPatchProof
} from "@patchproof/core";

export interface CliIO {
  stdout: Pick<NodeJS.WriteStream, "write">;
  stderr: Pick<NodeJS.WriteStream, "write">;
}

export async function runCli(argv: readonly string[], io: CliIO = process): Promise<number> {
  const [command, ...args] = argv;

  try {
    switch (command) {
      case "init":
        return await initCommand(args, io);
      case "verify":
        return await verifyCommand(args, io);
      case "report":
        return await reportCommand(args, io);
      case "--help":
      case "-h":
      case undefined:
        io.stdout.write(helpText());
        return 0;
      default:
        io.stderr.write(`Unknown command: ${command}\n\n${helpText()}`);
        return 2;
    }
  } catch (error) {
    if (error instanceof ConfigError || error instanceof VerificationRuntimeError) {
      io.stderr.write(`${error.message}\n`);
      return 2;
    }

    const message = error instanceof Error ? error.message : String(error);
    io.stderr.write(`${message}\n`);
    return 2;
  }
}

async function initCommand(args: readonly string[], io: CliIO): Promise<number> {
  const parsed = parseArgs(args, {
    flags: [],
    values: ["config"]
  });
  const configPath = parsed.values.config ?? DEFAULT_CONFIG_FILE;
  const path = await writeInitialConfig(process.cwd(), configPath);
  io.stdout.write(`Created ${path}\n`);
  return 0;
}

async function verifyCommand(args: readonly string[], io: CliIO): Promise<number> {
  const parsed = parseArgs(args, {
    flags: [],
    values: ["base", "head", "config"]
  });

  const base = requiredValue(parsed.values.base, "--base");
  const head = requiredValue(parsed.values.head, "--head");
  const result = await verifyPatchProof({
    adapters: [nodeAdapter, pythonAdapter],
    baseRef: base,
    configPath: parsed.values.config ?? DEFAULT_CONFIG_FILE,
    headRef: head,
    repoPath: process.cwd()
  });

  io.stdout.write(`Wrote ${result.proofJsonPath}\n`);
  io.stdout.write(`Wrote ${result.proofMarkdownPath}\n`);
  io.stdout.write(`Verdict: ${result.proof.verdict.status}\n`);
  return result.exitCode;
}

async function reportCommand(args: readonly string[], io: CliIO): Promise<number> {
  const parsed = parseArgs(args, {
    flags: [],
    values: ["format", "proof"]
  });
  const format = parsed.values.format ?? "markdown";
  if (format !== "json" && format !== "markdown") {
    throw new Error("--format must be json or markdown");
  }

  const proofPath = resolve(process.cwd(), parsed.values.proof ?? ".patchproof/proof.json");
  if (!existsSync(proofPath)) {
    throw new Error(`Proof file not found: ${proofPath}`);
  }

  const proof = await loadProof(proofPath);
  io.stdout.write(format === "json" ? renderJsonReport(proof) : renderMarkdownReport(proof));
  return 0;
}

interface ParsedArgs {
  flags: Set<string>;
  values: Record<string, string | undefined>;
}

function parseArgs(
  args: readonly string[],
  schema: { flags: readonly string[]; values: readonly string[] }
): ParsedArgs {
  const flags = new Set<string>();
  const values: Record<string, string | undefined> = {};
  const allowedFlags = new Set(schema.flags);
  const allowedValues = new Set(schema.values);

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg?.startsWith("--")) {
      throw new Error(`Unexpected argument: ${arg ?? ""}`);
    }

    const name = arg.slice(2);
    if (allowedFlags.has(name)) {
      flags.add(name);
      continue;
    }

    if (allowedValues.has(name)) {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`Missing value for ${arg}`);
      }
      values[name] = value;
      index += 1;
      continue;
    }

    throw new Error(`Unknown option: ${arg}`);
  }

  return { flags, values };
}

function requiredValue(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(`Missing required option ${name}`);
  }

  return value;
}

function helpText(): string {
  return `PatchProof

Commands:
  patchproof init [--config patchproof.yml]
  patchproof verify --base <ref> --head <ref> [--config patchproof.yml]
  patchproof report --format json|markdown [--proof .patchproof/proof.json]

Exit codes:
  0  verified
  1  evidence failed
  2  configuration or runtime error
`;
}
