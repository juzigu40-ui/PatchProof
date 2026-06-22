import { execFile } from "node:child_process";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { nodeAdapter } from "@patchproof/adapters-node";
import { loadPatchProofConfig } from "@patchproof/config";
import { loadProof, VerificationRuntimeError, verifyPatchProof } from "./verify.js";

const execFileAsync = promisify(execFile);
const fixturesRoot = resolve(process.cwd(), "fixtures/repositories");

describe("verifyPatchProof", () => {
  it("verifies a genuine bug fix and writes proof files", async () => {
    const repo = await createFixtureRepository("genuine-bug-fix");
    const loaded = await loadPatchProofConfig(repo.path);

    const result = await verifyPatchProof({
      adapters: [nodeAdapter],
      baseRef: repo.baseSha,
      config: loaded.config,
      configPath: loaded.path,
      headRef: repo.headSha,
      proofDir: join(repo.path, ".custom-proof"),
      repoPath: repo.path
    });

    expect(result.exitCode).toBe(0);
    expect(result.proofJsonPath).toContain(".custom-proof");
    expect(result.proof.determinations).toMatchObject({
      fixed_on_head: true,
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
    const loaded = await loadPatchProofConfig(repo.path);

    await expect(
      verifyPatchProof({
        baseRef: "missing-base-ref",
        config: loaded.config,
        configPath: loaded.path,
        headRef: repo.headSha,
        repoPath: repo.path
      })
    ).rejects.toBeInstanceOf(VerificationRuntimeError);
    await rm(repo.path, { recursive: true, force: true });
  });

  it("fails when the base behavior is not reproduced", async () => {
    const repo = await createFixtureRepository("test-passes-before-after");
    const loaded = await loadPatchProofConfig(repo.path);

    const result = await verifyPatchProof({
      adapters: [nodeAdapter],
      baseRef: repo.baseSha,
      config: loaded.config,
      configPath: loaded.path,
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
    const loaded = await loadPatchProofConfig(repo.path);

    const result = await verifyPatchProof({
      adapters: [nodeAdapter],
      baseRef: repo.baseSha,
      config: loaded.config,
      configPath: loaded.path,
      headRef: repo.headSha,
      repoPath: repo.path
    });

    expect(result.exitCode).toBe(0);
    expect(result.proof.determinations.dependency_files_changed).toBe(true);
    expect(result.proof.changed_files.dependency).toEqual(["package.json"]);
    await rm(repo.path, { recursive: true, force: true });
  });
});

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

async function revParse(cwd: string, ref: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["rev-parse", ref], { cwd });
  return stdout.trim();
}
