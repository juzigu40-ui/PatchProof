import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  createCommandEnvironment,
  createWorktree,
  listChangedFiles,
  removeWorktree,
  resolveCommit,
  runCommand
} from "@patchproof/runner";
import type { PatchProofConfig } from "@patchproof/config";
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

export interface VerifyOptions {
  repoPath: string;
  baseRef: string;
  headRef: string;
  config: PatchProofConfig;
  configPath: string;
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

  let baseWorktree: { path: string } | undefined;
  let headWorktree: { path: string } | undefined;

  try {
    const [baseSha, headSha] = await Promise.all([
      resolveCommit(repoPath, options.baseRef),
      resolveCommit(repoPath, options.headRef)
    ]);
    const changedFiles = await listChangedFiles(repoPath, baseSha, headSha);
    const riskPatterns = await collectRiskPatterns(
      repoPath,
      options.adapters ?? [],
      options.config.risk.dependency_files,
      options.config.risk.public_api_files
    );
    const dependencyChangedFiles = matchChangedFiles(changedFiles, riskPatterns.dependency);
    const publicApiChangedFiles = matchChangedFiles(changedFiles, riskPatterns.publicApi);

    baseWorktree = await createWorktree(repoPath, worktreeRoot, "base", options.baseRef, baseSha);
    headWorktree = await createWorktree(repoPath, worktreeRoot, "head", options.headRef, headSha);

    const env = createCommandEnvironment(process.env, options.config.runtime.env_passthrough);
    const baseReproductionResult = await runCommand({
      command: options.config.commands.reproduce.run,
      cwd: baseWorktree.path,
      env,
      outputLimitBytes: options.config.output.limit_bytes,
      timeoutMs: options.config.commands.reproduce.timeout_ms
    });
    const headReproductionResult = await runCommand({
      command: options.config.commands.reproduce.run,
      cwd: headWorktree.path,
      env,
      outputLimitBytes: options.config.output.limit_bytes,
      timeoutMs: options.config.commands.reproduce.timeout_ms
    });
    const headTestResult = await runCommand({
      command: options.config.commands.test.run,
      cwd: headWorktree.path,
      env,
      outputLimitBytes: options.config.output.limit_bytes,
      timeoutMs: options.config.commands.test.timeout_ms
    });

    const baseReproduction = toCommandEvidence(
      "reproduce:base",
      baseReproductionResult,
      baseSha,
      options.config.commands.reproduce.expected_exit_code.base
    );
    const headReproduction = toCommandEvidence(
      "reproduce:head",
      headReproductionResult,
      headSha,
      options.config.commands.reproduce.expected_exit_code.head
    );
    const headTests = toCommandEvidence(
      "test:head",
      headTestResult,
      headSha,
      options.config.commands.test.expected_exit_code
    );

    const determinations = evaluateDeterminations({
      baseReproduction,
      dependencyChangedFiles,
      headReproduction,
      headTests,
      publicApiChangedFiles
    });
    const verdict = evaluateVerdict(determinations);

    const proof = validateProof({
      schema_version: 1,
      patchproof_version: PATCHPROOF_VERSION,
      generated_at: new Date().toISOString(),
      repository: {
        root: repoPath,
        base_ref: options.baseRef,
        head_ref: options.headRef,
        base_sha: baseSha,
        head_sha: headSha
      },
      config_path: resolve(options.configPath),
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
        enabled: options.config.codex.enabled,
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
    await Promise.allSettled([
      baseWorktree ? removeWorktree(repoPath, baseWorktree.path) : Promise.resolve(),
      headWorktree ? removeWorktree(repoPath, headWorktree.path) : Promise.resolve()
    ]);
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
