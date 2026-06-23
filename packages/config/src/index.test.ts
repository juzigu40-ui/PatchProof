import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import {
  ConfigError,
  createDefaultConfig,
  DEFAULT_HARNESS_ENTRYPOINT,
  DEFAULT_HARNESS_ROOT,
  DEFAULT_REPRO_TARGET,
  DEFAULT_TEST_TARGET,
  formatDefaultConfig,
  getGitBlobSha,
  getGitTreeSha,
  listGitTreeFiles,
  loadPatchProofConfigFromGit,
  loadPatchProofConfig,
  normalizeRelativePath,
  PatchProofConfigSchema,
  readGitFile,
  resolveConfigPath,
  tryGetGitBlobSha,
  writeInitialConfig
} from "./index.js";

const execFileAsync = promisify(execFile);

describe("config", () => {
  it("creates a default config that validates", () => {
    const config = createDefaultConfig();
    expect(PatchProofConfigSchema.parse(config).version).toBe(1);
    expect(config.commands.reproduce.runtime).toBe("node");
    expect(config.commands.reproduce.harness_root).toBe(DEFAULT_HARNESS_ROOT);
    expect(config.commands.reproduce.entrypoint).toBe(DEFAULT_HARNESS_ENTRYPOINT);
    expect(config.commands.reproduce.args).toEqual(["node", DEFAULT_REPRO_TARGET]);
    expect(config.commands.reproduce.expected_exit_code.base).toBe(1);
    expect(config.commands.reproduce.expected_exit_code.head).toBe(0);
    expect(config.commands.test.expected_exit_code).toBe(0);
    expect(config.commands.test.run).toBe(`node ${DEFAULT_TEST_TARGET}`);
  });

  it("loads yaml and applies defaults", async () => {
    const dir = await temporaryDirectory();
    await writeFile(
      join(dir, "patchproof.yml"),
      [
        "version: 1",
        "commands:",
        "  reproduce:",
        "    runtime: node",
        "    harness_root: .patchproof/harness",
        "    entrypoint: reproduce.mjs",
        "  test:",
        "    run: node test.js"
      ].join("\n"),
      "utf8"
    );

    const loaded = await loadPatchProofConfig(dir);

    expect(loaded.config.output.limit_bytes).toBe(1_000_000);
    expect(loaded.config.commands.reproduce.timeout_ms).toBe(30_000);
    expect(loaded.config.commands.test.timeout_ms).toBe(120_000);
    await rm(dir, { recursive: true, force: true });
  });

  it("rejects invalid config", async () => {
    const dir = await temporaryDirectory();
    await writeFile(join(dir, "patchproof.yml"), "version: 2\n", "utf8");

    await expect(loadPatchProofConfig(dir)).rejects.toBeInstanceOf(ConfigError);
    await rm(dir, { recursive: true, force: true });
  });

  it("rejects environment passthrough in policy config", async () => {
    const dir = await temporaryDirectory();
    await writeFile(
      join(dir, "patchproof.yml"),
      [
        "version: 1",
        "commands:",
        "  reproduce:",
        "    runtime: node",
        "    harness_root: .patchproof/harness",
        "    entrypoint: reproduce.mjs",
        "  test:",
        "    run: node test.js",
        "runtime:",
        "  env_passthrough:",
        "    - TOP_SECRET"
      ].join("\n"),
      "utf8"
    );

    await expect(loadPatchProofConfig(dir)).rejects.toMatchObject({
      name: "ConfigError"
    });
    await rm(dir, { recursive: true, force: true });
  });

  it("loads trusted config from a git commit and records its blob", async () => {
    const dir = await temporaryDirectory();
    await execFileAsync("git", ["init", "--initial-branch=main"], { cwd: dir });
    await execFileAsync("git", ["config", "user.name", "PatchProof Test"], { cwd: dir });
    await execFileAsync("git", ["config", "user.email", "test@patchproof.local"], { cwd: dir });
    await writeFile(
      join(dir, "patchproof.yml"),
      [
        "version: 1",
        "commands:",
        "  reproduce:",
        "    runtime: node",
        "    harness_root: .patchproof/harness",
        "    entrypoint: reproduce.mjs",
        "  test:",
        "    run: node test.js"
      ].join("\n"),
      "utf8"
    );
    await mkdir(join(dir, ".patchproof/harness"), { recursive: true });
    await writeFile(join(dir, ".patchproof/harness/reproduce.mjs"), "process.exit(0);\n", "utf8");
    await execFileAsync("git", ["add", "patchproof.yml", ".patchproof/harness/reproduce.mjs"], {
      cwd: dir
    });
    await execFileAsync("git", ["commit", "-m", "config"], { cwd: dir });
    const sha = await revParse(dir, "HEAD");

    const loaded = await loadPatchProofConfigFromGit(dir, sha);

    expect(loaded.path).toBe("patchproof.yml");
    expect(loaded.sourceSha).toBe(sha);
    expect(loaded.blobSha).toMatch(/^[0-9a-f]{40,64}$/);
    await expect(getGitBlobSha(dir, sha)).resolves.toBe(loaded.blobSha);
    expect((await readGitFile(dir, sha, "patchproof.yml")).toString("utf8")).toContain(
      "version: 1"
    );
    await expect(tryGetGitBlobSha(dir, sha, "missing.yml")).resolves.toBeNull();
    expect(loaded.config.commands.reproduce.entrypoint).toBe("reproduce.mjs");
    await expect(getGitTreeSha(dir, sha, ".patchproof/harness")).resolves.toMatch(
      /^[0-9a-f]{40,64}$/
    );
    await expect(listGitTreeFiles(dir, sha, ".patchproof/harness")).resolves.toEqual([
      ".patchproof/harness/reproduce.mjs"
    ]);
    await rm(dir, { recursive: true, force: true });
  });

  it("wraps git errors when trusted config cannot be read", async () => {
    const dir = await temporaryDirectory();
    await execFileAsync("git", ["init", "--initial-branch=main"], { cwd: dir });

    await expect(loadPatchProofConfigFromGit(dir, "missing-ref")).rejects.toMatchObject({
      message: "Could not read trusted patchproof.yml from missing-ref"
    });
    await rm(dir, { recursive: true, force: true });
  });

  it("preserves config validation errors when loading from git", async () => {
    const dir = await temporaryDirectory();
    await execFileAsync("git", ["init", "--initial-branch=main"], { cwd: dir });
    await execFileAsync("git", ["config", "user.name", "PatchProof Test"], { cwd: dir });
    await execFileAsync("git", ["config", "user.email", "test@patchproof.local"], { cwd: dir });
    await writeFile(join(dir, "patchproof.yml"), "version: 2\n", "utf8");
    await execFileAsync("git", ["add", "patchproof.yml"], { cwd: dir });
    await execFileAsync("git", ["commit", "-m", "invalid config"], { cwd: dir });
    const sha = await revParse(dir, "HEAD");

    await expect(loadPatchProofConfigFromGit(dir, sha)).rejects.toMatchObject({
      message: expect.stringContaining("Invalid patchproof.yml")
    });
    await rm(dir, { recursive: true, force: true });
  });

  it("normalizes and rejects unsafe repository relative paths", () => {
    expect(normalizeRelativePath("dir/../reproduce.js")).toBe("reproduce.js");
    expect(() => normalizeRelativePath(".")).toThrow("Path must name a file");
    expect(() =>
      PatchProofConfigSchema.parse({
        version: 1,
        commands: {
          reproduce: {
            runtime: "node",
            harness_root: "../harness",
            entrypoint: "reproduce.mjs"
          },
          test: {
            run: "node test.js"
          }
        }
      })
    ).toThrow("Path must stay inside the repository");
  });

  it("rejects unsafe git config paths before reading repository content", async () => {
    const dir = await temporaryDirectory();

    await expect(loadPatchProofConfigFromGit(dir, "HEAD", "/tmp/patchproof.yml")).rejects.toThrow(
      "Path must be relative"
    );
    await expect(loadPatchProofConfigFromGit(dir, "HEAD", "../patchproof.yml")).rejects.toThrow(
      "Path must stay inside the repository"
    );
    await rm(dir, { recursive: true, force: true });
  });

  it("reports missing config files", async () => {
    const dir = await temporaryDirectory();

    await expect(loadPatchProofConfig(dir)).rejects.toMatchObject({
      message: "Could not read patchproof.yml"
    });
    await rm(dir, { recursive: true, force: true });
  });

  it("reports yaml parse errors", async () => {
    const dir = await temporaryDirectory();
    await writeFile(join(dir, "patchproof.yml"), "version: [\n", "utf8");

    await expect(loadPatchProofConfig(dir)).rejects.toMatchObject({
      message: "Could not parse patchproof.yml as YAML"
    });
    await rm(dir, { recursive: true, force: true });
  });

  it("writes initial config without overwriting", async () => {
    const dir = await temporaryDirectory();

    const written = await writeInitialConfig(dir);
    const raw = await readFile(written, "utf8");
    const harness = await readFile(
      join(dir, DEFAULT_HARNESS_ROOT, DEFAULT_HARNESS_ENTRYPOINT),
      "utf8"
    );
    const target = await readFile(join(dir, DEFAULT_REPRO_TARGET), "utf8");
    const testTarget = await readFile(join(dir, DEFAULT_TEST_TARGET), "utf8");

    expect(raw).toBe(formatDefaultConfig());
    expect(harness).toContain("readFileSync(3");
    expect(harness).toContain("writeFileSync(4");
    expect(target).toContain("Configure .patchproof/repro-target.mjs");
    expect(testTarget).toContain("Configure .patchproof/test-target.mjs");
    await expect(writeInitialConfig(dir)).rejects.toBeInstanceOf(ConfigError);
    await rm(dir, { recursive: true, force: true });
  });

  it("resolves config paths", () => {
    expect(resolveConfigPath("/repo")).toBe(join("/repo", "patchproof.yml"));
    expect(resolveConfigPath("/repo", "config/patchproof.yml")).toBe(
      join("/repo", "config/patchproof.yml")
    );
  });
});

async function temporaryDirectory(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "patchproof-config-"));
}

async function revParse(cwd: string, ref: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["rev-parse", ref], { cwd });
  return stdout.trim();
}
