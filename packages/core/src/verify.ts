import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
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
  getGitBlobSha,
  getGitTreeSha,
  listGitTreeFiles,
  loadPatchProofConfigFromGit,
  normalizeRelativePath,
  readGitFile,
  tryGetGitBlobSha,
  tryGetGitTreeSha
} from "@patchproof/config";
import type { PatchProofConfig } from "@patchproof/config";
import type { HarnessFileEvidence, Proof } from "./schema.js";
import { validateProof } from "./schema.js";
import { renderJsonReport, renderMarkdownReport } from "./report.js";
import type { RepositoryAdapter, RiskPatterns } from "./risk.js";
import { collectRiskPatterns, matchChangedFiles } from "./risk.js";
import {
  evaluateDeterminations,
  evaluateVerdict,
  expectedReproductionStatus,
  parseStructuredReproductionResult,
  proofExitCode,
  toCommandEvidence
} from "./verdict.js";

export const PATCHPROOF_VERSION = "0.1.0";
const SECRET_ENV_NAME_PATTERN = /(TOKEN|SECRET|PASSWORD|KEY|CREDENTIAL|AUTH|COOKIE|SESSION)/i;
const SECRET_VALUE_PATTERN =
  /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|sk-[A-Za-z0-9_-]{20,}|[A-Za-z0-9+/]{32,}={0,2})\b/;
const PROTOCOL_RESULT_LIMIT_BYTES = 16 * 1024;

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
  let proof: Proof;

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
    const harness = await collectHarnessEvidence(
      repoPath,
      baseSha,
      headSha,
      config.commands.reproduce.harness_root
    );
    const harnessChanged = harness.changed;
    const trustedHarness = {
      args: config.commands.reproduce.args,
      baseSha,
      entrypoint: config.commands.reproduce.entrypoint,
      files: harness.files,
      repoPath,
      root: config.commands.reproduce.harness_root,
      runtime: config.commands.reproduce.runtime
    };

    const baseNonce = randomUUID();
    const baseReproductionStage = await runStage({
      repoPath,
      proofDir,
      ref: options.baseRef,
      sha: baseSha,
      label: "base-reproduce",
      trustedHarness,
      outputLimitBytes: config.output.limit_bytes,
      timeoutMs: config.commands.reproduce.timeout_ms,
      challengeNonce: baseNonce
    });
    const baseStructured = parseStructuredReproductionResult(
      baseReproductionStage.structuredResultText,
      baseNonce,
      baseReproductionStage.structuredResultErrorReason
    );

    const headNonce = randomUUID();
    const headReproductionStage = await runStage({
      repoPath,
      proofDir,
      ref: options.headRef,
      sha: headSha,
      label: "head-reproduce",
      trustedHarness,
      outputLimitBytes: config.output.limit_bytes,
      timeoutMs: config.commands.reproduce.timeout_ms,
      challengeNonce: headNonce
    });
    const headStructured = parseStructuredReproductionResult(
      headReproductionStage.structuredResultText,
      headNonce,
      headReproductionStage.structuredResultErrorReason
    );

    let riskPatterns: RiskPatterns | undefined;
    const headTestStage = await runStage({
      repoPath,
      proofDir,
      ref: options.headRef,
      sha: headSha,
      label: "head-test",
      command: config.commands.test.run,
      outputLimitBytes: config.output.limit_bytes,
      timeoutMs: config.commands.test.timeout_ms,
      beforeRun: async (worktreePath) => {
        riskPatterns = await collectRiskPatterns(
          worktreePath,
          options.adapters ?? [],
          config.risk.dependency_files,
          config.risk.public_api_files
        );
      }
    });
    if (!riskPatterns) {
      throw new VerificationRuntimeError("Could not collect risk patterns from head worktree");
    }

    const dependencyChangedFiles = matchChangedFiles(changedFiles, riskPatterns.dependency);
    const publicApiChangedFiles = matchChangedFiles(changedFiles, riskPatterns.publicApi);

    const baseReproduction = toCommandEvidence(
      "reproduce:base",
      baseReproductionStage.result,
      baseSha,
      config.commands.reproduce.expected_exit_code.base,
      {
        cwd: ".",
        infrastructureErrorReason: baseStructured.infrastructureErrorReason,
        passOverride:
          baseStructured.structuredResult?.status === expectedReproductionStatus("base") &&
          baseReproductionStage.result.exitCode ===
            config.commands.reproduce.expected_exit_code.base,
        redactedValues: baseReproductionStage.redactedValues,
        structuredResult: baseStructured.structuredResult
      }
    );
    const headReproduction = toCommandEvidence(
      "reproduce:head",
      headReproductionStage.result,
      headSha,
      config.commands.reproduce.expected_exit_code.head,
      {
        cwd: ".",
        infrastructureErrorReason: headStructured.infrastructureErrorReason,
        passOverride:
          headStructured.structuredResult?.status === expectedReproductionStatus("head") &&
          headReproductionStage.result.exitCode ===
            config.commands.reproduce.expected_exit_code.head,
        redactedValues: headReproductionStage.redactedValues,
        structuredResult: headStructured.structuredResult
      }
    );
    const headTests = toCommandEvidence(
      "test:head",
      headTestStage.result,
      headSha,
      config.commands.test.expected_exit_code,
      { cwd: ".", redactedValues: headTestStage.redactedValues }
    );

    const determinations = evaluateDeterminations({
      baseReproduction,
      dependencyChangedFiles,
      harnessChanged,
      headReproduction,
      headTests,
      policyChanged,
      publicApiChangedFiles
    });
    const verdict = evaluateVerdict(determinations);

    proof = validateProof({
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
      harness: {
        root: harness.root,
        base_tree_sha: harness.baseTreeSha,
        head_tree_sha: harness.headTreeSha,
        files: harness.files,
        changed: harnessChanged
      },
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
  } catch (error) {
    throw new VerificationRuntimeError("PatchProof verification failed at runtime", error);
  }

  const paths = await writeProofFiles(proof, proofDir);
  return {
    proof,
    ...paths,
    exitCode: proofExitCode(proof)
  };
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

interface StageRunOptions {
  repoPath: string;
  proofDir: string;
  ref: string;
  sha: string;
  label: string;
  command?: string;
  trustedHarness?: TrustedHarnessRun;
  timeoutMs: number;
  outputLimitBytes: number;
  challengeNonce?: string;
  beforeRun?(worktreePath: string): Promise<void>;
}

interface StageRunResult {
  result: Awaited<ReturnType<typeof runCommand>>;
  redactedValues: string[];
  structuredResultText: string;
  structuredResultErrorReason: string | null;
}

interface TrustedHarnessRun {
  repoPath: string;
  baseSha: string;
  root: string;
  files: readonly HarnessFileEvidence[];
  runtime: PatchProofConfig["commands"]["reproduce"]["runtime"];
  entrypoint: string;
  args: readonly string[];
}

interface StageCommand {
  command: string;
  args?: readonly string[];
  displayCommand?: string;
  shell?: boolean;
}

async function runStage(options: StageRunOptions): Promise<StageRunResult> {
  const stageRoot = await mkdtemp(join(tmpdir(), `patchproof-${options.label}-`));
  let worktreePath: string | undefined;

  try {
    const worktree = await createWorktree(
      options.repoPath,
      stageRoot,
      options.label,
      options.ref,
      options.sha
    );
    worktreePath = worktree.path;
    await options.beforeRun?.(worktree.path);
    const stageCommand =
      options.trustedHarness === undefined
        ? shellStageCommand(options.command)
        : await prepareTrustedHarnessCommand(stageRoot, options.trustedHarness);
    const protocolFiles =
      options.challengeNonce === undefined
        ? undefined
        : await createProtocolFiles(stageRoot, options.challengeNonce);
    const stageEnvironment = await createStageEnvironment(stageRoot, options.label, [
      options.proofDir,
      options.repoPath,
      stageRoot,
      worktree.path,
      ...(protocolFiles ? [protocolFiles.challengePath, protocolFiles.resultPath] : [])
    ]);
    const result = await runCommand({
      command: stageCommand.command,
      args: stageCommand.args,
      cwd: worktree.path,
      displayCommand: stageCommand.displayCommand,
      env: stageEnvironment.env,
      extraFiles: protocolFiles
        ? [
            { fd: 3, flags: "r", path: protocolFiles.challengePath },
            { fd: 4, flags: "w", path: protocolFiles.resultPath }
          ]
        : undefined,
      outputLimitBytes: options.outputLimitBytes,
      shell: stageCommand.shell,
      timeoutMs: options.timeoutMs
    });
    const protocolResult = protocolFiles
      ? await readProtocolResult(protocolFiles.resultPath)
      : { errorReason: null, text: "" };

    return {
      result,
      redactedValues: stageEnvironment.redactedValues,
      structuredResultErrorReason: protocolResult.errorReason,
      structuredResultText: protocolResult.text
    };
  } finally {
    if (worktreePath) {
      await removeWorktree(options.repoPath, worktreePath);
    }
    await rm(stageRoot, { force: true, recursive: true });
  }
}

async function createStageEnvironment(
  stageRoot: string,
  stageName: string,
  additionalRedactedValues: readonly string[]
): Promise<{ env: NodeJS.ProcessEnv; redactedValues: string[] }> {
  const stageTmp = join(stageRoot, `${stageName}-${randomUUID()}`);
  await mkdir(stageTmp, { recursive: true });
  const env = createCommandEnvironment(process.env, {
    overrides: {
      HOME: stageTmp,
      TEMP: stageTmp,
      TMP: stageTmp,
      TMPDIR: stageTmp
    }
  });
  return {
    env,
    redactedValues: [
      ...collectRedactedValues(env),
      stageRoot,
      stageTmp,
      ...additionalRedactedValues
    ]
  };
}

async function createProtocolFiles(
  stageRoot: string,
  nonce: string
): Promise<{ challengePath: string; resultPath: string }> {
  const protocolRoot = join(stageRoot, "protocol");
  await mkdir(protocolRoot, { recursive: true });
  const challengePath = join(protocolRoot, "challenge.json");
  const resultPath = join(protocolRoot, "result.jsonl");
  await writeFile(challengePath, `${JSON.stringify({ nonce })}\n`, "utf8");
  await writeFile(resultPath, "", "utf8");
  return { challengePath, resultPath };
}

async function readProtocolResult(
  resultPath: string
): Promise<{ errorReason: string | null; text: string }> {
  try {
    const resultStat = await stat(resultPath);
    if (resultStat.size > PROTOCOL_RESULT_LIMIT_BYTES) {
      return {
        errorReason: "structured_result_too_large",
        text: ""
      };
    }
    return {
      errorReason: null,
      text: await readFile(resultPath, "utf8")
    };
  } catch {
    return {
      errorReason: "structured_result_unreadable",
      text: ""
    };
  }
}

function shellStageCommand(command: string | undefined): StageCommand {
  if (!command) {
    throw new VerificationRuntimeError("Stage command was not configured");
  }
  return {
    command,
    shell: true
  };
}

async function prepareTrustedHarnessCommand(
  stageRoot: string,
  harness: TrustedHarnessRun
): Promise<StageCommand> {
  const executionRoot = join(stageRoot, "trusted-harness");
  await exportBaseHarnessTree(
    harness.repoPath,
    harness.baseSha,
    executionRoot,
    harness.root,
    harness.files
  );
  const entrypoint = resolveHarnessEntrypoint(executionRoot, harness.entrypoint);
  const displayEntrypoint = `${harness.root}/${harness.entrypoint}`.replaceAll(/\/+/g, "/");

  if (harness.runtime === "node") {
    return {
      args: [entrypoint, ...harness.args],
      command: process.execPath,
      displayCommand: formatDisplayCommand("node", [displayEntrypoint, ...harness.args]),
      shell: false
    };
  }

  return {
    args: [entrypoint, ...harness.args],
    command: "python3",
    displayCommand: formatDisplayCommand("python3", [displayEntrypoint, ...harness.args]),
    shell: false
  };
}

async function exportBaseHarnessTree(
  repoPath: string,
  baseSha: string,
  executionRoot: string,
  harnessRoot: string,
  files: readonly HarnessFileEvidence[]
): Promise<void> {
  await mkdir(executionRoot, { recursive: true });
  await Promise.all(
    files.map(async (file) => {
      const relativePath = relativeToHarnessRoot(harnessRoot, file.path);
      const target = join(executionRoot, relativePath);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, await readGitFile(repoPath, baseSha, file.path));
    })
  );
}

function resolveHarnessEntrypoint(executionRoot: string, entrypoint: string): string {
  const safeEntrypoint = normalizeRelativePath(entrypoint);
  return join(executionRoot, safeEntrypoint);
}

function formatDisplayCommand(command: string, args: readonly string[]): string {
  return [command, ...args]
    .map((part) =>
      /^[A-Za-z0-9_./:=@+-]+$/.test(part) ? part : `'${part.replaceAll("'", "'\\''")}'`
    )
    .join(" ");
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

async function collectHarnessEvidence(
  repoPath: string,
  baseSha: string,
  headSha: string,
  root: string
): Promise<{
  root: string;
  baseTreeSha: string;
  headTreeSha: string | null;
  files: HarnessFileEvidence[];
  changed: boolean;
}> {
  const safeRoot = normalizeRelativePath(root);
  const [baseTreeSha, headTreeSha, files] = await Promise.all([
    getGitTreeSha(repoPath, baseSha, safeRoot),
    tryGetGitTreeSha(repoPath, headSha, safeRoot),
    listGitTreeFiles(repoPath, baseSha, safeRoot)
  ]);

  if (files.length === 0) {
    throw new VerificationRuntimeError(`Trusted harness root is empty: ${safeRoot}`);
  }

  const evidence = await Promise.all(
    files.map(async (path) => {
      const baseBlobSha = await getGitBlobSha(repoPath, baseSha, path);
      const headBlobSha = await tryGetGitBlobSha(repoPath, headSha, path);
      return {
        path,
        base_blob_sha: baseBlobSha,
        head_blob_sha: headBlobSha,
        changed: headBlobSha !== baseBlobSha
      };
    })
  );

  return {
    root: safeRoot,
    baseTreeSha,
    headTreeSha,
    files: evidence,
    changed: headTreeSha !== baseTreeSha || evidence.some((file) => file.changed)
  };
}

function relativeToHarnessRoot(root: string, filePath: string): string {
  const safeRoot = normalizeRelativePath(root);
  const safePath = normalizeRelativePath(filePath);
  if (safePath === safeRoot) {
    throw new VerificationRuntimeError("Trusted harness root must be a directory");
  }
  if (!safePath.startsWith(`${safeRoot}/`)) {
    throw new VerificationRuntimeError(`Harness file is outside trusted root: ${safePath}`);
  }
  return safePath.slice(safeRoot.length + 1);
}
