import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
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
  loadPatchProofConfigFromGit,
  normalizeRelativePath,
  readGitFile,
  tryGetGitBlobSha
} from "@patchproof/config";
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
    const harnessFiles = await collectHarnessEvidence(
      repoPath,
      baseSha,
      headSha,
      config.commands.reproduce.harness_files
    );
    await validateHarnessClosure(repoPath, baseSha, harnessFiles);
    const harnessChanged = harnessFiles.some((file) => file.changed);

    const baseNonce = randomUUID();
    const baseReproductionStage = await runStage({
      repoPath,
      proofDir,
      ref: options.baseRef,
      sha: baseSha,
      label: "base-reproduce",
      command: config.commands.reproduce.run,
      outputLimitBytes: config.output.limit_bytes,
      timeoutMs: config.commands.reproduce.timeout_ms,
      challengeNonce: baseNonce
    });
    const baseStructured = parseStructuredReproductionResult(
      baseReproductionStage.structuredResultText,
      baseNonce
    );

    const headNonce = randomUUID();
    const headReproductionStage = await runStage({
      repoPath,
      proofDir,
      ref: options.headRef,
      sha: headSha,
      label: "head-reproduce",
      command: config.commands.reproduce.run,
      outputLimitBytes: config.output.limit_bytes,
      timeoutMs: config.commands.reproduce.timeout_ms,
      challengeNonce: headNonce,
      beforeRun: async (worktreePath) => {
        await writeBaseHarnessFiles(repoPath, baseSha, worktreePath, harnessFiles);
      }
    });
    const headStructured = parseStructuredReproductionResult(
      headReproductionStage.structuredResultText,
      headNonce
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
        files: harnessFiles,
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
  command: string;
  timeoutMs: number;
  outputLimitBytes: number;
  challengeNonce?: string;
  beforeRun?(worktreePath: string): Promise<void>;
}

interface StageRunResult {
  result: Awaited<ReturnType<typeof runCommand>>;
  redactedValues: string[];
  structuredResultText: string;
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
      command: options.command,
      cwd: worktree.path,
      env: stageEnvironment.env,
      extraFiles: protocolFiles
        ? [
            { fd: 3, flags: "r", path: protocolFiles.challengePath },
            { fd: 4, flags: "w", path: protocolFiles.resultPath }
          ]
        : undefined,
      outputLimitBytes: options.outputLimitBytes,
      timeoutMs: options.timeoutMs
    });

    return {
      result,
      redactedValues: stageEnvironment.redactedValues,
      structuredResultText: protocolFiles ? await readProtocolResult(protocolFiles.resultPath) : ""
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

async function readProtocolResult(resultPath: string): Promise<string> {
  try {
    return await readFile(resultPath, "utf8");
  } catch {
    return "";
  }
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
  files: readonly string[]
): Promise<HarnessFileEvidence[]> {
  return await Promise.all(
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
}

async function validateHarnessClosure(
  repoPath: string,
  baseSha: string,
  files: readonly HarnessFileEvidence[]
): Promise<void> {
  const harnessPaths = new Set(files.map((file) => file.path));
  const missing: string[] = [];

  for (const file of files) {
    const content = (await readGitFile(repoPath, baseSha, file.path)).toString("utf8");
    const dependencies = await collectHarnessDependencies(repoPath, baseSha, file.path, content);
    for (const dependency of dependencies) {
      if (!harnessPaths.has(dependency)) {
        missing.push(`${file.path} -> ${dependency}`);
      }
    }
  }

  if (missing.length > 0) {
    throw new VerificationRuntimeError(
      `Trusted harness manifest is incomplete; add these dependencies to commands.reproduce.harness_files: ${missing.join(", ")}`
    );
  }
}

async function collectHarnessDependencies(
  repoPath: string,
  baseSha: string,
  filePath: string,
  content: string
): Promise<string[]> {
  if (/\.[cm]?[jt]sx?$/.test(filePath)) {
    return await collectJavaScriptHarnessDependencies(repoPath, baseSha, filePath, content);
  }
  if (filePath.endsWith(".py")) {
    return await collectPythonHarnessDependencies(repoPath, baseSha, filePath, content);
  }
  return [];
}

async function collectJavaScriptHarnessDependencies(
  repoPath: string,
  baseSha: string,
  filePath: string,
  content: string
): Promise<string[]> {
  const dependencies = new Set<string>();
  const importPattern =
    /\b(?:import\s+(?:[^'"]+\s+from\s+)?|export\s+[^'"]+\s+from\s+|import\s*\(|require\s*\()\s*["'](\.{1,2}\/[^"']+)["']/g;
  for (const match of content.matchAll(importPattern)) {
    const specifier = match[1];
    if (!specifier) {
      continue;
    }
    const resolved = await resolveJavaScriptSpecifier(repoPath, baseSha, filePath, specifier);
    if (resolved) {
      dependencies.add(resolved);
    }
  }
  return [...dependencies].sort();
}

async function resolveJavaScriptSpecifier(
  repoPath: string,
  baseSha: string,
  importerPath: string,
  specifier: string
): Promise<string | null> {
  const basePath = normalizeRelativePath(join(dirname(importerPath), specifier));
  const candidates =
    extname(basePath) === ""
      ? [
          basePath,
          `${basePath}.js`,
          `${basePath}.mjs`,
          `${basePath}.cjs`,
          `${basePath}.ts`,
          `${basePath}.tsx`,
          `${basePath}.jsx`,
          `${basePath}.json`,
          `${basePath}/index.js`,
          `${basePath}/index.mjs`,
          `${basePath}/index.cjs`,
          `${basePath}/index.ts`
        ]
      : [basePath];

  return await firstExistingGitPath(repoPath, baseSha, candidates);
}

async function collectPythonHarnessDependencies(
  repoPath: string,
  baseSha: string,
  filePath: string,
  content: string
): Promise<string[]> {
  const dependencies = new Set<string>();
  const importPattern = /^\s*(?:from\s+([A-Za-z_][\w.]*)\s+import|import\s+([A-Za-z_][\w.]*))/gm;
  for (const match of content.matchAll(importPattern)) {
    const moduleName = match[1] ?? match[2];
    if (!moduleName) {
      continue;
    }
    const resolved = await resolvePythonModule(repoPath, baseSha, filePath, moduleName);
    if (resolved) {
      dependencies.add(resolved);
    }
  }
  return [...dependencies].sort();
}

async function resolvePythonModule(
  repoPath: string,
  baseSha: string,
  importerPath: string,
  moduleName: string
): Promise<string | null> {
  const modulePath = moduleName.replaceAll(".", "/");
  const importerDir = dirname(importerPath);
  const candidates = [
    `${modulePath}.py`,
    `${modulePath}/__init__.py`,
    normalizeRelativePath(join(importerDir, `${modulePath}.py`)),
    normalizeRelativePath(join(importerDir, modulePath, "__init__.py"))
  ];

  return await firstExistingGitPath(repoPath, baseSha, candidates);
}

async function firstExistingGitPath(
  repoPath: string,
  baseSha: string,
  candidates: readonly string[]
): Promise<string | null> {
  for (const candidate of candidates) {
    if ((await tryGetGitBlobSha(repoPath, baseSha, candidate)) !== null) {
      return candidate;
    }
  }
  return null;
}

async function writeBaseHarnessFiles(
  repoPath: string,
  baseSha: string,
  worktreePath: string,
  files: readonly HarnessFileEvidence[]
): Promise<void> {
  await Promise.all(
    files.map(async (file) => {
      const target = join(worktreePath, file.path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, await readGitFile(repoPath, baseSha, file.path));
    })
  );
}
