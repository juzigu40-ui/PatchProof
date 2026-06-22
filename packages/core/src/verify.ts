import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  createCommandEnvironment,
  createWorktree,
  listChangedFiles,
  removeWorktree,
  resolveCommit,
  runCommand
} from "@patchproof/runner";
import {
  DEFAULT_CONFIG_FILE,
  loadPatchProofConfigFromGit,
  tryGetGitBlobSha
} from "@patchproof/config";
import type { Proof } from "./schema.js";
import { validateProof } from "./schema.js";
import { renderJsonReport, renderMarkdownReport } from "./report.js";
import type { RepositoryAdapter } from "./risk.js";
import { collectRiskPatterns, matchChangedFiles } from "./risk.js";
import {
  evaluateDeterminations,
  evaluateVerdict,
  proofExitCode,
  toCommandEvidence
} from "./verdict.js";

export const PATCHPROOF_VERSION = "0.1.0";
const SECRET_ENV_NAME_PATTERN = /(TOKEN|SECRET|PASSWORD|KEY|CREDENTIAL|AUTH|COOKIE|SESSION)/i;
const SECRET_VALUE_PATTERN =
  /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|sk-[A-Za-z0-9_-]{20,}|[A-Za-z0-9+/]{32,}={0,2})\b/;

export interface VerifyOptions {
  repoPath: string;
  baseRef: string;
  headRef: string;
  configPath?: string;
  adapters?: readonly RepositoryAdapter[];
  proofDir?: string;
}

export interface VerifyResult {
  proof: Proof;
  proofJsonPath: string;
  proofMarkdownPath: string;
  exitCode: 0 | 1;
}

export class VerificationRuntimeError extends Error {
  public constructor(
    message: string,
    public readonly originalError?: unknown
  ) {
    super(message);
    this.name = "VerificationRuntimeError";
  }
}

export async function verifyPatchProof(options: VerifyOptions): Promise<VerifyResult> {
  const repoPath = resolve(options.repoPath);
  const proofDir = options.proofDir ?? join(repoPath, ".patchproof");
  const worktreeRoot = join(proofDir, "worktrees", `${Date.now()}-${process.pid}`);
  const tmpRoot = join(proofDir, "tmp", `${Date.now()}-${process.pid}`);
  const worktrees: { path: string }[] = [];

  try {
    const [baseSha, headSha] = await Promise.all([
      resolveCommit(repoPath, options.baseRef),
      resolveCommit(repoPath, options.headRef)
    ]);
    const configPath = options.configPath ?? DEFAULT_CONFIG_FILE;
    const loadedConfig = await loadPatchProofConfigFromGit(repoPath, baseSha, configPath);
    const config = loadedConfig.config;
    const headConfigBlobSha = await tryGetGitBlobSha(repoPath, headSha, configPath);
    const policyChanged = headConfigBlobSha !== loadedConfig.blobSha;
    const changedFiles = await listChangedFiles(repoPath, baseSha, headSha);

    const baseReproductionWorktree = await createWorktree(
      repoPath,
      worktreeRoot,
      "base-reproduce",
      options.baseRef,
      baseSha
    );
    const headReproductionWorktree = await createWorktree(
      repoPath,
      worktreeRoot,
      "head-reproduce",
      options.headRef,
      headSha
    );
    const headTestWorktree = await createWorktree(
      repoPath,
      worktreeRoot,
      "head-test",
      options.headRef,
      headSha
    );
    worktrees.push(baseReproductionWorktree, headReproductionWorktree, headTestWorktree);

    const riskPatterns = await collectRiskPatterns(
      headTestWorktree.path,
      options.adapters ?? [],
      config.risk.dependency_files,
      config.risk.public_api_files
    );
    const dependencyChangedFiles = matchChangedFiles(changedFiles, riskPatterns.dependency);
    const publicApiChangedFiles = matchChangedFiles(changedFiles, riskPatterns.publicApi);
    const redactedValues = collectRedactedValues(process.env);

    const baseReproductionResult = await runCommand({
      command: config.commands.reproduce.run,
      cwd: baseReproductionWorktree.path,
      env: await createStageEnvironment(tmpRoot, "base-reproduce"),
      outputLimitBytes: config.output.limit_bytes,
      timeoutMs: config.commands.reproduce.timeout_ms
    });
    const headReproductionResult = await runCommand({
      command: config.commands.reproduce.run,
      cwd: headReproductionWorktree.path,
      env: await createStageEnvironment(tmpRoot, "head-reproduce"),
      outputLimitBytes: config.output.limit_bytes,
      timeoutMs: config.commands.reproduce.timeout_ms
    });
    const headTestResult = await runCommand({
      command: config.commands.test.run,
      cwd: headTestWorktree.path,
      env: await createStageEnvironment(tmpRoot, "head-test"),
      outputLimitBytes: config.output.limit_bytes,
      timeoutMs: config.commands.test.timeout_ms
    });

    const baseReproduction = toCommandEvidence(
      "reproduce:base",
      baseReproductionResult,
      baseSha,
      config.commands.reproduce.expected_exit_code.base,
      { cwd: ".", redactedValues }
    );
    const headReproduction = toCommandEvidence(
      "reproduce:head",
      headReproductionResult,
      headSha,
      config.commands.reproduce.expected_exit_code.head,
      { cwd: ".", redactedValues }
    );
    const headTests = toCommandEvidence(
      "test:head",
      headTestResult,
      headSha,
      config.commands.test.expected_exit_code,
      { cwd: ".", redactedValues }
    );

    const determinations = evaluateDeterminations({
      baseReproduction,
      dependencyChangedFiles,
      headReproduction,
      headTests,
      policyChanged,
      publicApiChangedFiles
    });
    const verdict = evaluateVerdict(determinations);

    const proof = validateProof({
      schema_version: 1,
      patchproof_version: PATCHPROOF_VERSION,
      generated_at: new Date().toISOString(),
      repository: {
        root: ".",
        base_ref: options.baseRef,
        head_ref: options.headRef,
        base_sha: baseSha,
        head_sha: headSha
      },
      config: {
        path: loadedConfig.path,
        source_ref: loadedConfig.sourceRef,
        source_sha: loadedConfig.sourceSha,
        blob_sha: loadedConfig.blobSha,
        policy_changed: policyChanged
      },
      config_path: loadedConfig.path,
      environment: {
        platform: process.platform,
        node_version: process.version
      },
      adapters: riskPatterns.adapters,
      commands: {
        reproduction: {
          base: baseReproduction,
          head: headReproduction
        },
        tests: {
          head: headTests
        }
      },
      changed_files: {
        all: changedFiles,
        dependency: dependencyChangedFiles,
        public_api: publicApiChangedFiles
      },
      determinations,
      verdict,
      codex: {
        enabled: config.codex.enabled,
        verdict_influence: "none"
      }
    });

    const paths = await writeProofFiles(proof, proofDir);
    return {
      proof,
      ...paths,
      exitCode: proofExitCode(proof)
    };
  } catch (error) {
    throw new VerificationRuntimeError("PatchProof verification failed at runtime", error);
  } finally {
    await Promise.allSettled(worktrees.map((worktree) => removeWorktree(repoPath, worktree.path)));
    await rm(tmpRoot, { force: true, recursive: true });
  }
}

export async function writeProofFiles(
  proof: Proof,
  proofDir: string
): Promise<{ proofJsonPath: string; proofMarkdownPath: string }> {
  await mkdir(proofDir, { recursive: true });
  const proofJsonPath = join(proofDir, "proof.json");
  const proofMarkdownPath = join(proofDir, "proof.md");
  await writeFile(proofJsonPath, renderJsonReport(proof), "utf8");
  await writeFile(proofMarkdownPath, renderMarkdownReport(proof), "utf8");
  return { proofJsonPath, proofMarkdownPath };
}

export async function loadProof(proofPath: string): Promise<Proof> {
  const raw = await readFile(proofPath, "utf8");
  return validateProof(JSON.parse(raw));
}

async function createStageEnvironment(
  tmpRoot: string,
  stageName: string
): Promise<NodeJS.ProcessEnv> {
  const stageTmp = join(tmpRoot, `${stageName}-${randomUUID()}`);
  await mkdir(stageTmp, { recursive: true });
  return createCommandEnvironment(process.env, {
    overrides: {
      HOME: stageTmp,
      TEMP: stageTmp,
      TMP: stageTmp,
      TMPDIR: stageTmp
    }
  });
}

function collectRedactedValues(env: NodeJS.ProcessEnv): string[] {
  return Object.entries(env)
    .filter((entry): entry is [string, string] => {
      const [key, value] = entry;
      return (
        value !== undefined &&
        value.length >= 4 &&
        (SECRET_ENV_NAME_PATTERN.test(key) || SECRET_VALUE_PATTERN.test(value))
      );
    })
    .map(([, value]) => value);
}
