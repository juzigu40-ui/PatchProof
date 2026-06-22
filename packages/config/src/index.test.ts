import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ConfigError,
  createDefaultConfig,
  formatDefaultConfig,
  loadPatchProofConfig,
  PatchProofConfigSchema,
  resolveConfigPath,
  writeInitialConfig
} from "./index.js";

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
