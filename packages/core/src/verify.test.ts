import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { nodeAdapter } from "@patchproof/adapters-node";
import { pythonAdapter } from "@patchproof/adapters-python";
import { writeInitialConfig } from "@patchproof/config";
import { loadProof, VerificationRuntimeError, verifyPatchProof } from "./verify.js";

const execFileAsync = promisify(execFile);
const fixturesRoot = resolve(process.cwd(), "fixtures/repositories");

describe("verifyPatchProof", () => {
  it("verifies a genuine bug fix and writes proof files", async () => {
    const repo = await createFixtureRepository("genuine-bug-fix");

    const result = await verifyPatchProof({
      adapters: [nodeAdapter],
      baseRef: repo.baseSha,
      headRef: repo.headSha,
      proofDir: join(repo.path, ".custom-proof"),
      repoPath: repo.path
    });

    expect(result.exitCode).toBe(0);
    expect(result.proofJsonPath).toContain(".custom-proof");
    expect(result.proof.determinations).toMatchObject({
      fixed_on_head: true,
      infrastructure_error: false,
      policy_changed: false,
      public_api_files_changed: true,
      reproduced_on_base: true,
      tests_passed: true
    });
    await expect(loadProof(result.proofJsonPath)).resolves.toMatchObject({
      verdict: { status: "verified" }
    });
    await rm(repo.path, { recursive: true, force: true });
  });

  it("verifies after patchproof init creates the default fd-aware harness", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "patchproof-init-flow-"));
    await execFileAsync("git", ["init", "--initial-branch=main"], { cwd: repoPath });
    await execFileAsync("git", ["config", "user.name", "PatchProof Test"], { cwd: repoPath });
    await execFileAsync("git", ["config", "user.email", "test@patchproof.local"], {
      cwd: repoPath
    });
    await writeInitialConfig(repoPath);
    await writeFile(join(repoPath, "app.mjs"), "export const fixed = () => false;\n", "utf8");
    await writeFile(
      join(repoPath, ".patchproof/repro-target.mjs"),
      "import { fixed } from '../app.mjs';\nprocess.exit(fixed() ? 0 : 1);\n",
      "utf8"
    );
    await writeFile(
      join(repoPath, ".patchproof/test-target.mjs"),
      "import { fixed } from '../app.mjs';\nprocess.exit(fixed() ? 0 : 1);\n",
      "utf8"
    );
    await execFileAsync("git", ["add", "."], { cwd: repoPath });
    await execFileAsync("git", ["commit", "-m", "base"], { cwd: repoPath });
    const baseSha = await revParse(repoPath, "HEAD");

    await writeFile(join(repoPath, "app.mjs"), "export const fixed = () => true;\n", "utf8");
    await execFileAsync("git", ["add", "."], { cwd: repoPath });
    await execFileAsync("git", ["commit", "-m", "head"], { cwd: repoPath });
    const headSha = await revParse(repoPath, "HEAD");

    const result = await verifyPatchProof({
      baseRef: baseSha,
      headRef: headSha,
      repoPath
    });

    expect(result.exitCode).toBe(0);
    expect(result.proof.verdict.status).toBe("verified");
    expect(result.proof.commands.reproduction.base.command).toContain(
      ".patchproof/harness/reproduce.mjs"
    );
    await rm(repoPath, { recursive: true, force: true });
  });

  it("wraps runtime failures as configuration or runtime errors", async () => {
    const repo = await createFixtureRepository("genuine-bug-fix");

    await expect(
      verifyPatchProof({
        baseRef: "missing-base-ref",
        headRef: repo.headSha,
        repoPath: repo.path
      })
    ).rejects.toBeInstanceOf(VerificationRuntimeError);
    await rm(repo.path, { recursive: true, force: true });
  });

  it("fails when the base behavior is not reproduced", async () => {
    const repo = await createFixtureRepository("test-passes-before-after");

    const result = await verifyPatchProof({
      adapters: [nodeAdapter],
      baseRef: repo.baseSha,
      headRef: repo.headSha,
      repoPath: repo.path
    });

    expect(result.exitCode).toBe(1);
    expect(result.proof.determinations.reproduced_on_base).toBe(false);
    expect(result.proof.verdict.status).toBe("failed");
    await rm(repo.path, { recursive: true, force: true });
  });

  it("reports dependency risk changes without changing the deterministic verdict", async () => {
    const repo = await createFixtureRepository("dependency-risk-change");

    const result = await verifyPatchProof({
      adapters: [nodeAdapter],
      baseRef: repo.baseSha,
      headRef: repo.headSha,
      repoPath: repo.path
    });

    expect(result.exitCode).toBe(0);
    expect(result.proof.determinations.dependency_files_changed).toBe(true);
    expect(result.proof.changed_files.dependency).toEqual(["package.json"]);
    await rm(repo.path, { recursive: true, force: true });
  });

  it("verifies a Python bug fix with the Python adapter", async () => {
    const repo = await createFixtureRepository("python-genuine-bug-fix");

    const result = await verifyPatchProof({
      adapters: [pythonAdapter],
      baseRef: repo.baseSha,
      headRef: repo.headSha,
      repoPath: repo.path
    });

    expect(result.exitCode).toBe(0);
    expect(result.proof.adapters).toEqual(["python"]);
    expect(result.proof.determinations.public_api_files_changed).toBe(true);
    await rm(repo.path, { recursive: true, force: true });
  });

  it("uses trusted base policy when head tampers with expected exit codes", async () => {
    const repo = await createRepositoryFromFiles(
      {
        "patchproof.yml": trustedConfig(),
        ".patchproof/harness/reproduce.js": stateFileHarness("console.error('bug reproduced');"),
        "state.txt": "broken\n",
        "test.js": "console.log('tests pass'); process.exit(0);\n"
      },
      {
        "patchproof.yml": trustedConfig({ headExpectedExitCode: 1 }),
        ".patchproof/harness/reproduce.js": stateFileHarness("console.error('bug reproduced');"),
        "state.txt": "broken\n",
        "test.js": "console.log('tests pass'); process.exit(0);\n"
      }
    );

    const result = await verifyPatchProof({
      baseRef: repo.baseSha,
      headRef: repo.headSha,
      repoPath: repo.path
    });

    expect(result.exitCode).toBe(1);
    expect(result.proof.config.policy_changed).toBe(true);
    expect(result.proof.determinations.policy_changed).toBe(true);
    expect(result.proof.determinations.harness_changed).toBe(false);
    expect(result.proof.commands.reproduction.head.expected_exit_code).toBe(0);
    expect(result.proof.determinations.fixed_on_head).toBe(false);
    expect(result.proof.verdict.status).toBe("failed");
    await rm(repo.path, { recursive: true, force: true });
  });

  it("treats missing trusted harness files as configuration errors", async () => {
    const repo = await createRepositoryFromFiles(
      {
        "patchproof.yml": trustedConfig(),
        "test.js": "console.log('tests pass'); process.exit(0);\n"
      },
      {
        "patchproof.yml": trustedConfig(),
        ".patchproof/harness/reproduce.js": "console.log('pretend fixed'); process.exit(0);\n",
        "test.js": "console.log('tests pass'); process.exit(0);\n"
      }
    );

    await expect(
      verifyPatchProof({
        baseRef: repo.baseSha,
        headRef: repo.headSha,
        repoPath: repo.path
      })
    ).rejects.toBeInstanceOf(VerificationRuntimeError);
    await rm(repo.path, { recursive: true, force: true });
  });

  it("uses the immutable base harness when head tampers with reproduction logic", async () => {
    const repo = await createRepositoryFromFiles(
      {
        "patchproof.yml": trustedConfig(),
        "app.js": "exports.fixed = () => false;\n",
        ".patchproof/harness/reproduce.js": subprocessFixedHarness(),
        "test.js": "console.log('tests pass'); process.exit(0);\n"
      },
      {
        "patchproof.yml": trustedConfig(),
        "app.js": "exports.fixed = () => false;\n",
        ".patchproof/harness/reproduce.js": fdStructuredReproduce(
          "assertion_passed",
          "console.log('pretend fixed without testing app.js');"
        ),
        "test.js": "console.log('tests pass'); process.exit(0);\n"
      }
    );

    const result = await verifyPatchProof({
      baseRef: repo.baseSha,
      headRef: repo.headSha,
      repoPath: repo.path
    });

    expect(result.exitCode).toBe(1);
    expect(result.proof.determinations.harness_changed).toBe(true);
    expect(result.proof.determinations.fixed_on_head).toBe(false);
    expect(result.proof.commands.reproduction.head.stdout).not.toContain("pretend fixed");
    expect(result.proof.verdict.reason).toContain("trusted reproduction harness changed");
    await rm(repo.path, { recursive: true, force: true });
  });

  it("does not execute a head-controlled launcher outside the trusted harness entrypoint", async () => {
    const repo = await createRepositoryFromFiles(
      {
        "patchproof.yml": trustedConfig(),
        "app.js": "exports.fixed = () => false;\n",
        ".patchproof/harness/reproduce.js": subprocessFixedHarness(),
        "launcher.js": "console.log('base launcher should not run'); process.exit(1);\n",
        "test.js": "console.log('tests pass'); process.exit(0);\n"
      },
      {
        "patchproof.yml": trustedConfig(),
        "app.js": "exports.fixed = () => false;\n",
        ".patchproof/harness/reproduce.js": subprocessFixedHarness(),
        "launcher.js": fdStructuredReproduce(
          "assertion_passed",
          "console.log('head launcher forged success');"
        ),
        "test.js": "console.log('tests pass'); process.exit(0);\n"
      }
    );

    const result = await verifyPatchProof({
      baseRef: repo.baseSha,
      headRef: repo.headSha,
      repoPath: repo.path
    });

    expect(result.exitCode).toBe(1);
    expect(result.proof.commands.reproduction.head.command).toContain(
      ".patchproof/harness/reproduce.js"
    );
    expect(result.proof.commands.reproduction.head.stdout).not.toContain("head launcher");
    expect(result.proof.determinations.fixed_on_head).toBe(false);
    await rm(repo.path, { recursive: true, force: true });
  });

  it("treats missing structured reproduction output as an infrastructure error", async () => {
    const repo = await createRepositoryFromFiles(
      {
        "patchproof.yml": trustedConfig(),
        ".patchproof/harness/reproduce.js": "process.exit(1);\n",
        "app.js": "export const value = 1;\n",
        "test.js": "console.log('tests pass'); process.exit(0);\n"
      },
      {
        "patchproof.yml": trustedConfig(),
        ".patchproof/harness/reproduce.js": "process.exit(1);\n",
        "app.js": "export const value = 2;\n",
        "test.js": "console.log('tests pass'); process.exit(0);\n"
      }
    );

    const result = await verifyPatchProof({
      baseRef: repo.baseSha,
      headRef: repo.headSha,
      repoPath: repo.path
    });

    expect(result.exitCode).toBe(1);
    expect(result.proof.commands.reproduction.base.infrastructure_error).toBe(true);
    expect(result.proof.commands.reproduction.base.infrastructure_error_reason).toBe(
      "structured_result_missing"
    );
    expect(result.proof.verdict.reason).toContain("infrastructure error");
    await rm(repo.path, { recursive: true, force: true });
  });

  it("requires structured reproduction status and expected exit code to match", async () => {
    const reproduce = stateFileHarness("", "1");
    const repo = await createRepositoryFromFiles(
      {
        "patchproof.yml": trustedConfig(),
        "state.txt": "broken\n",
        ".patchproof/harness/reproduce.js": reproduce,
        "test.js": "console.log('tests pass'); process.exit(0);\n"
      },
      {
        "patchproof.yml": trustedConfig(),
        "state.txt": "fixed\n",
        ".patchproof/harness/reproduce.js": reproduce,
        "test.js": "console.log('tests pass'); process.exit(0);\n"
      }
    );

    const result = await verifyPatchProof({
      baseRef: repo.baseSha,
      headRef: repo.headSha,
      repoPath: repo.path
    });

    expect(result.exitCode).toBe(1);
    expect(result.proof.determinations.harness_changed).toBe(false);
    expect(result.proof.commands.reproduction.head.structured_result?.status).toBe(
      "assertion_passed"
    );
    expect(result.proof.commands.reproduction.head.exit_code).toBe(1);
    expect(result.proof.determinations.fixed_on_head).toBe(false);
    await rm(repo.path, { recursive: true, force: true });
  });

  it("detects dynamic helper changes by hashing the complete harness tree", async () => {
    const repo = await createRepositoryFromFiles(
      {
        "patchproof.yml": trustedConfig(),
        ".patchproof/harness/oracle.js": "exports.status = () => 'assertion_failed';\n",
        ".patchproof/harness/reproduce.js":
          "const helper = './' + 'oracle.js';\nconst { status } = require(helper);\n" +
          fdHarnessBody("status()"),
        "test.js": "console.log('base tests pass'); process.exit(0);\n"
      },
      {
        "patchproof.yml": trustedConfig(),
        ".patchproof/harness/oracle.js": "exports.status = () => 'assertion_passed';\n",
        ".patchproof/harness/reproduce.js":
          "const helper = './' + 'oracle.js';\nconst { status } = require(helper);\n" +
          fdHarnessBody("status()"),
        "test.js": "console.log('tests pass'); process.exit(0);\n"
      }
    );

    const result = await verifyPatchProof({
      baseRef: repo.baseSha,
      headRef: repo.headSha,
      repoPath: repo.path
    });

    expect(result.exitCode).toBe(1);
    expect(result.proof.harness.changed).toBe(true);
    expect(result.proof.harness.files.map((file) => file.path)).toEqual([
      ".patchproof/harness/oracle.js",
      ".patchproof/harness/reproduce.js"
    ]);
    expect(result.proof.commands.reproduction.head.structured_result?.status).toBe(
      "assertion_failed"
    );
    expect(result.proof.determinations.fixed_on_head).toBe(false);
    await rm(repo.path, { recursive: true, force: true });
  });

  it("ignores structured results forged on target stdout", async () => {
    const repo = await createRepositoryFromFiles(
      {
        "patchproof.yml": trustedConfig(),
        "app.js": "console.log('fixed=false');\nexports.fixed = () => false;\n",
        ".patchproof/harness/reproduce.js": subprocessFixedHarness(),
        "test.js": "console.log('tests pass'); process.exit(0);\n"
      },
      {
        "patchproof.yml": trustedConfig(),
        "app.js": [
          "console.log(JSON.stringify({ nonce: process.env.PATCHPROOF_NONCE || 'missing', status: 'assertion_passed' }));",
          "console.log('fixed=false');",
          "exports.fixed = () => false;"
        ].join("\n"),
        ".patchproof/harness/reproduce.js": subprocessFixedHarness(),
        "test.js": "console.log('tests pass'); process.exit(0);\n"
      }
    );

    const result = await verifyPatchProof({
      baseRef: repo.baseSha,
      headRef: repo.headSha,
      repoPath: repo.path
    });

    expect(result.exitCode).toBe(1);
    expect(result.proof.commands.reproduction.head.stdout).toContain("assertion_passed");
    expect(result.proof.commands.reproduction.head.structured_result?.status).toBe(
      "assertion_failed"
    );
    expect(result.proof.determinations.fixed_on_head).toBe(false);
    await rm(repo.path, { recursive: true, force: true });
  });

  it("does not expose PATCHPROOF_STAGE to stage-aware target code", async () => {
    const repo = await createRepositoryFromFiles(
      {
        "patchproof.yml": trustedConfig(),
        "app.js": "exports.fixed = () => false;\n",
        ".patchproof/harness/reproduce.js": subprocessFixedHarness(),
        "test.js": "console.log('tests pass'); process.exit(0);\n"
      },
      {
        "patchproof.yml": trustedConfig(),
        "app.js": "exports.fixed = () => process.env.PATCHPROOF_STAGE === 'head-reproduce';\n",
        ".patchproof/harness/reproduce.js": subprocessFixedHarness(),
        "test.js": "console.log('tests pass'); process.exit(0);\n"
      }
    );

    const result = await verifyPatchProof({
      baseRef: repo.baseSha,
      headRef: repo.headSha,
      repoPath: repo.path
    });

    expect(result.exitCode).toBe(1);
    expect(result.proof.commands.reproduction.head.structured_result?.status).toBe(
      "assertion_failed"
    );
    expect(result.proof.determinations.fixed_on_head).toBe(false);
    await rm(repo.path, { recursive: true, force: true });
  });

  it("does not let head-controlled env_passthrough leak environment values", async () => {
    const previousSecret = process.env.TOP_SECRET;
    process.env.TOP_SECRET = "SENSITIVE_TEST_VALUE_42";
    const repo = await createRepositoryFromFiles(
      {
        "patchproof.yml": trustedConfig(),
        "state.txt": "broken\n",
        ".patchproof/harness/reproduce.js": stateFileHarness(
          "console.log('head secret=' + (process.env.TOP_SECRET || 'unset'));"
        ),
        "test.js": "console.log('test secret=' + (process.env.TOP_SECRET || 'unset'));\n"
      },
      {
        "patchproof.yml": trustedConfig({
          extraLines: ["runtime:", "  env_passthrough:", "    - TOP_SECRET"]
        }),
        "state.txt": "fixed\n",
        ".patchproof/harness/reproduce.js": stateFileHarness(
          "console.log('head secret=' + (process.env.TOP_SECRET || 'unset'));"
        ),
        "test.js": "console.log('test secret=' + (process.env.TOP_SECRET || 'unset'));\n"
      }
    );

    try {
      const result = await verifyPatchProof({
        baseRef: repo.baseSha,
        headRef: repo.headSha,
        repoPath: repo.path
      });
      const proofJson = await readFile(result.proofJsonPath, "utf8");

      expect(proofJson).not.toContain("SENSITIVE_TEST_VALUE_42");
      expect(result.proof.commands.reproduction.head.stdout).toContain("head secret=unset");
      expect(result.proof.commands.tests.head.stdout).toContain("test secret=unset");
    } finally {
      if (previousSecret === undefined) {
        delete process.env.TOP_SECRET;
      } else {
        process.env.TOP_SECRET = previousSecret;
      }
      await rm(repo.path, { recursive: true, force: true });
    }
  });
});

function trustedConfig(
  options: {
    extraLines?: string[];
    headExpectedExitCode?: number;
    reproduceArgs?: string[];
    runtime?: "node" | "python";
  } = {}
): string {
  const reproduceArgs = options.reproduceArgs ?? [];
  return [
    "version: 1",
    "commands:",
    "  reproduce:",
    `    runtime: ${options.runtime ?? "node"}`,
    "    harness_root: .patchproof/harness",
    "    entrypoint: reproduce.js",
    ...(reproduceArgs.length > 0
      ? ["    args:", ...reproduceArgs.map((arg) => `      - ${JSON.stringify(arg)}`)]
      : []),
    "    expected_exit_code:",
    "      base: 1",
    `      head: ${options.headExpectedExitCode ?? 0}`,
    "  test:",
    "    run: node test.js",
    ...(options.extraLines ?? [])
  ].join("\n");
}

function fdStructuredReproduce(
  status: "assertion_failed" | "assertion_passed",
  prefix = ""
): string {
  return [prefix, fdHarnessBody(JSON.stringify(status))].filter(Boolean).join("\n");
}

function stateFileHarness(
  prefix = "",
  exitCodeExpression = "patchproofStatus === 'assertion_passed' ? 0 : 1"
): string {
  return [
    prefix,
    fdHarnessBody(
      "readFileSync('state.txt', 'utf8').trim() === 'fixed' ? 'assertion_passed' : 'assertion_failed'",
      exitCodeExpression
    )
  ]
    .filter(Boolean)
    .join("\n");
}

function subprocessFixedHarness(): string {
  return [
    "const { spawnSync } = require('node:child_process');",
    'const targetScript = "const target = require(" + JSON.stringify(\'./app.js\') + "); process.exit(target.fixed() ? 0 : 1);";',
    "const target = spawnSync(process.execPath, ['-e', targetScript], {",
    "  cwd: process.cwd(),",
    "  encoding: 'utf8',",
    "  env: { PATH: process.env.PATH || '' }",
    "});",
    "process.stdout.write(target.stdout || '');",
    "process.stderr.write(target.stderr || '');",
    "const status = target.status === 0 ? 'assertion_passed' : 'assertion_failed';",
    fdHarnessBody("status")
  ]
    .filter(Boolean)
    .join("\n");
}

function fdHarnessBody(
  statusExpression: string,
  exitCodeExpression = "patchproofStatus === 'assertion_passed' ? 0 : 1"
): string {
  return [
    "const { readFileSync, writeFileSync } = require('node:fs');",
    "const challenge = JSON.parse(readFileSync(3, 'utf8'));",
    `const patchproofStatus = ${statusExpression};`,
    "writeFileSync(4, `${JSON.stringify({ nonce: challenge.nonce, status: patchproofStatus })}\\n`);",
    `process.exit(${exitCodeExpression});`
  ].join("\n");
}

async function createFixtureRepository(
  name: string
): Promise<{ path: string; baseSha: string; headSha: string }> {
  const path = await mkdtemp(join(tmpdir(), `patchproof-${name}-`));
  await execFileAsync("git", ["init", "--initial-branch=main"], { cwd: path });
  await execFileAsync("git", ["config", "user.name", "PatchProof Test"], { cwd: path });
  await execFileAsync("git", ["config", "user.email", "test@patchproof.local"], { cwd: path });

  await cp(join(fixturesRoot, name, "base"), path, { recursive: true });
  await execFileAsync("git", ["add", "."], { cwd: path });
  await execFileAsync("git", ["commit", "-m", "base"], { cwd: path });
  const baseSha = await revParse(path, "HEAD");

  await cp(join(fixturesRoot, name, "head"), path, { recursive: true });
  await execFileAsync("git", ["add", "."], { cwd: path });
  await execFileAsync("git", ["commit", "-m", "head"], { cwd: path });
  const headSha = await revParse(path, "HEAD");

  return { path, baseSha, headSha };
}

async function createRepositoryFromFiles(
  baseFiles: Record<string, string>,
  headFiles: Record<string, string>
): Promise<{ path: string; baseSha: string; headSha: string }> {
  const path = await mkdtemp(join(tmpdir(), "patchproof-adversarial-"));
  await execFileAsync("git", ["init", "--initial-branch=main"], { cwd: path });
  await execFileAsync("git", ["config", "user.name", "PatchProof Test"], { cwd: path });
  await execFileAsync("git", ["config", "user.email", "test@patchproof.local"], { cwd: path });

  await writeFiles(path, baseFiles);
  await execFileAsync("git", ["add", "."], { cwd: path });
  await execFileAsync("git", ["commit", "-m", "base"], { cwd: path });
  const baseSha = await revParse(path, "HEAD");

  await execFileAsync("git", ["rm", "-r", "."], { cwd: path });
  await writeFiles(path, headFiles);
  await execFileAsync("git", ["add", "."], { cwd: path });
  await execFileAsync("git", ["commit", "-m", "head"], { cwd: path });
  const headSha = await revParse(path, "HEAD");

  return { path, baseSha, headSha };
}

async function writeFiles(root: string, files: Record<string, string>): Promise<void> {
  await Promise.all(
    Object.entries(files).map(async ([relativePath, content]) => {
      const absolutePath = join(root, relativePath);
      await mkdir(dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, content, "utf8");
    })
  );
}

async function revParse(cwd: string, ref: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["rev-parse", ref], { cwd });
  return stdout.trim();
}
