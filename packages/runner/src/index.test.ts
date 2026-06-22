import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCommandEnvironment, runCommand } from "./index.js";

describe("runner", () => {
  it("captures output with byte limits", async () => {
    const dir = await temporaryDirectory();
    const result = await runCommand({
      command: "node -e \"process.stdout.write('abcdef')\"",
      cwd: dir,
      outputLimitBytes: 3,
      timeoutMs: 5000
    });

    expect(result.stdout).toBe("abc");
    expect(result.stdoutTruncated).toBe(true);
    expect(result.exitCode).toBe(0);
    await rm(dir, { recursive: true, force: true });
  });

  it("marks timed out commands", async () => {
    const dir = await temporaryDirectory();
    const result = await runCommand({
      command: 'node -e "setTimeout(() => {}, 1000)"',
      cwd: dir,
      outputLimitBytes: 1024,
      timeoutMs: 50
    });

    expect(result.timedOut).toBe(true);
    await rm(dir, { recursive: true, force: true });
  });

  it("creates a restricted environment with explicit passthrough", () => {
    const env = createCommandEnvironment(
      {
        PATH: "/bin",
        SECRET_TOKEN: "no",
        CUSTOM: "yes"
      },
      ["CUSTOM"]
    );

    expect(env).toEqual({
      CUSTOM: "yes",
      PATH: "/bin"
    });
  });
});

async function temporaryDirectory(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "patchproof-runner-"));
}
