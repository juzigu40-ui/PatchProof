import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
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

  it("kills child processes when a command times out", async () => {
    const dir = await temporaryDirectory();
    const marker = join(dir, "orphan-evidence");
    const childScript = [
      "const fs = require('node:fs');",
      `setTimeout(() => fs.writeFileSync(${JSON.stringify(marker)}, 'survived'), 700);`,
      "setTimeout(() => {}, 5000);"
    ].join("\n");
    const parentScript = [
      "const { spawn } = require('node:child_process');",
      `spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}], { stdio: 'ignore' });`,
      "setTimeout(() => {}, 5000);"
    ].join("\n");

    const result = await runCommand({
      command: `node -e ${JSON.stringify(parentScript)}`,
      cwd: dir,
      outputLimitBytes: 1024,
      timeoutMs: 50
    });
    await delay(1000);

    expect(result.timedOut).toBe(true);
    await expect(access(marker)).rejects.toThrow();
    await rm(dir, { recursive: true, force: true });
  });

  it("creates a restricted environment with explicit passthrough", () => {
    const env = createCommandEnvironment(
      {
        GITHUB_WORKSPACE: "/repo",
        LOGNAME: "person",
        PATH: "/bin",
        SECRET_TOKEN: "no",
        USER: "person",
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
