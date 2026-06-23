import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { nodeAdapter } from "@patchproof/adapters-node";
import { pythonAdapter } from "@patchproof/adapters-python";
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
        "reproduce.js": structuredReproduce("assertion_failed", "console.error('bug reproduced');"),
        "test.js": "console.log('tests pass'); process.exit(0);\n"
      },
      {
        "patchproof.yml": trustedConfig({ headExpectedExitCode: 1 }),
        "reproduce.js": structuredReproduce(
          "assertion_failed",
          "console.error('bug still present');"
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
    expect(result.proof.config.policy_changed).toBe(true);
    expect(result.proof.determinations.policy_changed).toBe(true);
    expect(result.proof.determinations.harness_changed).toBe(true);
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
        "reproduce.js": "console.log('pretend fixed'); process.exit(0);\n",
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
        "app.js": "export function fixed() { return false; }\n",
        "reproduce.js": [
          "import { fixed } from './app.js';",
          "const status = fixed() ? 'assertion_passed' : 'assertion_failed';",
          "console.log(JSON.stringify({ nonce: process.env.PATCHPROOF_NONCE, status }));",
          "process.exit(status === 'assertion_passed' ? 0 : 1);"
        ].join("\n"),
        "test.js": "console.log('tests pass'); process.exit(0);\n"
      },
      {
        "patchproof.yml": trustedConfig(),
        "app.js": "export function fixed() { return false; }\n",
        "reproduce.js": [
          "console.log('pretend fixed without testing app.js');",
          "console.log(JSON.stringify({ nonce: process.env.PATCHPROOF_NONCE, status: 'assertion_passed' }));",
          "process.exit(0);"
        ].join("\n"),
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

  it("treats missing structured reproduction output as an infrastructure error", async () => {
    const repo = await createRepositoryFromFiles(
      {
        "patchproof.yml": trustedConfig({
          reproduceRun: "npm run repro",
          harnessFiles: ["package.json"]
        }),
        "package.json": JSON.stringify({ type: "module", scripts: {} }, null, 2),
        "app.js": "export const value = 1;\n",
        "test.js": "console.log('tests pass'); process.exit(0);\n"
      },
      {
        "patchproof.yml": trustedConfig({
          reproduceRun: "npm run repro",
          harnessFiles: ["package.json"]
        }),
        "package.json": JSON.stringify({ type: "module", scripts: {} }, null, 2),
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
      "missing_command_or_file"
    );
    expect(result.proof.verdict.reason).toContain("infrastructure error");
    await rm(repo.path, { recursive: true, force: true });
  });

  it("requires structured reproduction status and expected exit code to match", async () => {
    const reproduce = [
      "import { fixed } from './app.js';",
      "const status = fixed() ? 'assertion_passed' : 'assertion_failed';",
      "console.log(JSON.stringify({ nonce: process.env.PATCHPROOF_NONCE, status }));",
      "process.exit(1);"
    ].join("\n");
    const repo = await createRepositoryFromFiles(
      {
        "patchproof.yml": trustedConfig(),
        "app.js": "export function fixed() { return false; }\n",
        "reproduce.js": reproduce,
        "test.js": "console.log('tests pass'); process.exit(0);\n"
      },
      {
        "patchproof.yml": trustedConfig(),
        "app.js": "export function fixed() { return true; }\n",
        "reproduce.js": reproduce,
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

  it("does not precreate sibling head test worktrees for reproduction to mutate", async () => {
    const repo = await createRepositoryFromFiles(
      {
        "patchproof.yml": trustedConfig(),
        "attack.js": "export function attack() {}\nexport function fixed() { return false; }\n",
        "reproduce.js": [
          "import { attack, fixed } from './attack.js';",
          "attack();",
          "const status = fixed() ? 'assertion_passed' : 'assertion_failed';",
          "console.log(JSON.stringify({ nonce: process.env.PATCHPROOF_NONCE, status }));",
          "process.exit(status === 'assertion_passed' ? 0 : 1);"
        ].join("\n"),
        "test.js": "console.log('base tests pass'); process.exit(0);\n"
      },
      {
        "patchproof.yml": trustedConfig(),
        "attack.js": [
          "import { readdirSync, writeFileSync } from 'node:fs';",
          "import { dirname, join } from 'node:path';",
          "export function attack() {",
          "  const root = dirname(process.cwd());",
          "  for (const entry of readdirSync(root)) {",
          "    if (entry.startsWith('head-test-')) {",
          "      writeFileSync(join(root, entry, 'test.js'), \"console.log('cross-worktree mutation passed'); process.exit(0);\\n\");",
          "    }",
          "  }",
          "}",
          "export function fixed() { return true; }"
        ].join("\n"),
        "reproduce.js": [
          "import { attack, fixed } from './attack.js';",
          "attack();",
          "const status = fixed() ? 'assertion_passed' : 'assertion_failed';",
          "console.log(JSON.stringify({ nonce: process.env.PATCHPROOF_NONCE, status }));",
          "process.exit(status === 'assertion_passed' ? 0 : 1);"
        ].join("\n"),
        "test.js": "console.error('committed head test fails'); process.exit(1);\n"
      }
    );

    const result = await verifyPatchProof({
      baseRef: repo.baseSha,
      headRef: repo.headSha,
      repoPath: repo.path
    });

    expect(result.exitCode).toBe(1);
    expect(result.proof.determinations.fixed_on_head).toBe(true);
    expect(result.proof.determinations.tests_passed).toBe(false);
    expect(result.proof.commands.tests.head.stderr).toContain("committed head test fails");
    expect(result.proof.commands.tests.head.stdout).not.toContain("cross-worktree mutation passed");
    await rm(repo.path, { recursive: true, force: true });
  });

  it("does not let head-controlled env_passthrough leak environment values", async () => {
    const previousSecret = process.env.TOP_SECRET;
    process.env.TOP_SECRET = "SENSITIVE_TEST_VALUE_42";
    const repo = await createRepositoryFromFiles(
      {
        "patchproof.yml": trustedConfig(),
        "reproduce.js": stageStructuredReproduce(
          "console.log('head secret=' + (process.env.TOP_SECRET || 'unset'));"
        ),
        "test.js": "console.log('test secret=' + (process.env.TOP_SECRET || 'unset'));\n"
      },
      {
        "patchproof.yml": trustedConfig({
          extraLines: ["runtime:", "  env_passthrough:", "    - TOP_SECRET"]
        }),
        "reproduce.js": stageStructuredReproduce(
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
    harnessFiles?: string[];
    headExpectedExitCode?: number;
    reproduceRun?: string;
  } = {}
): string {
  return [
    "version: 1",
    "commands:",
    "  reproduce:",
    `    run: ${options.reproduceRun ?? "node reproduce.js"}`,
    "    harness_files:",
    ...(options.harnessFiles ?? ["reproduce.js"]).map((file) => `      - ${file}`),
    "    expected_exit_code:",
    "      base: 1",
    `      head: ${options.headExpectedExitCode ?? 0}`,
    "  test:",
    "    run: node test.js",
    ...(options.extraLines ?? [])
  ].join("\n");
}

function structuredReproduce(status: "assertion_failed" | "assertion_passed", prefix = ""): string {
  return [
    prefix,
    `console.log(JSON.stringify({ nonce: process.env.PATCHPROOF_NONCE, status: "${status}" }));`,
    `process.exit(${status === "assertion_passed" ? 0 : 1});`
  ]
    .filter(Boolean)
    .join("\n");
}

function stageStructuredReproduce(prefix = ""): string {
  return [
    prefix,
    "const status = process.env.PATCHPROOF_STAGE === 'base-reproduce' ? 'assertion_failed' : 'assertion_passed';",
    "console.log(JSON.stringify({ nonce: process.env.PATCHPROOF_NONCE, status }));",
    "process.exit(status === 'assertion_passed' ? 0 : 1);"
  ]
    .filter(Boolean)
    .join("\n");
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
