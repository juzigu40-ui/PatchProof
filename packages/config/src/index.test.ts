import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import {
  ConfigError,
  createDefaultConfig,
  formatDefaultConfig,
  getGitBlobSha,
  loadPatchProofConfigFromGit,
  loadPatchProofConfig,
  PatchProofConfigSchema,
  resolveConfigPath,
  tryGetGitBlobSha,
  writeInitialConfig
} from "./index.js";

const execFileAsync = promisify(execFile);

describe("config", () => {
  it("creates a default config that validates", () => {
    const config = createDefaultConfig();
    expect(PatchProofConfigSchema.parse(config).version).toBe(1);
    expect(config.commands.reproduce.expected_exit_code.base).toBe(1);
    expect(config.commands.reproduce.expected_exit_code.head).toBe(0);
    expect(config.commands.test.expected_exit_code).toBe(0);
  });

  it("loads yaml and applies defaults", async () => {
    const dir = await temporaryDirectory();
    await writeFile(
      join(dir, "patchproof.yml"),
      [
        "version: 1",
        "commands:",
        "  reproduce:",
        "    run: node reproduce.js",
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
        "    run: node reproduce.js",
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
        "    run: node reproduce.js",
        "  test:",
        "    run: node test.js"
      ].join("\n"),
      "utf8"
    );
    await execFileAsync("git", ["add", "patchproof.yml"], { cwd: dir });
    await execFileAsync("git", ["commit", "-m", "config"], { cwd: dir });
    const sha = await revParse(dir, "HEAD");

    const loaded = await loadPatchProofConfigFromGit(dir, sha);

    expect(loaded.path).toBe("patchproof.yml");
    expect(loaded.sourceSha).toBe(sha);
    expect(loaded.blobSha).toMatch(/^[0-9a-f]{40,64}$/);
    await expect(getGitBlobSha(dir, sha)).resolves.toBe(loaded.blobSha);
    await expect(tryGetGitBlobSha(dir, sha, "missing.yml")).resolves.toBeNull();
    expect(loaded.config.commands.reproduce.run).toBe("node reproduce.js");
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

  it("rejects unsafe git config paths before reading repository content", async () => {
    const dir = await temporaryDirectory();

    await expect(loadPatchProofConfigFromGit(dir, "HEAD", "/tmp/patchproof.yml")).rejects.toThrow(
      "Config path must be relative"
    );
    await expect(loadPatchProofConfigFromGit(dir, "HEAD", "../patchproof.yml")).rejects.toThrow(
      "Config path must stay inside the repository"
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

    expect(raw).toBe(formatDefaultConfig());
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
