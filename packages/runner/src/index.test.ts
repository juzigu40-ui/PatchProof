import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

  it("passes verifier-owned file descriptors to commands", async () => {
    const dir = await temporaryDirectory();
    const challenge = join(dir, "challenge.json");
    const resultPath = join(dir, "result.json");
    await writeFile(challenge, '{"nonce":"n1"}\n', "utf8");
    await writeFile(resultPath, "", "utf8");

    const result = await runCommand({
      command:
        "node -e \"const fs=require('node:fs'); const c=JSON.parse(fs.readFileSync(3,'utf8')); fs.writeFileSync(4, JSON.stringify({ nonce: c.nonce, status: 'assertion_passed' }) + '\\n');\"",
      cwd: dir,
      extraFiles: [
        { fd: 3, flags: "r", path: challenge },
        { fd: 4, flags: "w", path: resultPath }
      ],
      outputLimitBytes: 1024,
      timeoutMs: 5000
    });

    await expect(readFile(resultPath, "utf8")).resolves.toContain('"nonce":"n1"');
    expect(result.exitCode).toBe(0);
    await rm(dir, { recursive: true, force: true });
  });

  it("runs direct commands with arguments without invoking a shell", async () => {
    const dir = await temporaryDirectory();
    const challenge = join(dir, "challenge.json");
    const resultPath = join(dir, "result.json");
    await writeFile(challenge, '{"nonce":"n2"}\n', "utf8");
    await writeFile(resultPath, "", "utf8");

    const script = [
      "const fs = require('node:fs');",
      "const c = JSON.parse(fs.readFileSync(3, 'utf8'));",
      "process.stdout.write(process.argv.at(-1));",
      "fs.writeFileSync(4, JSON.stringify({ nonce: c.nonce, status: 'assertion_passed' }) + '\\n');"
    ].join("\n");
    const result = await runCommand({
      args: ["-e", script, "literal arg"],
      command: process.execPath,
      cwd: dir,
      displayCommand: "node direct-test",
      extraFiles: [
        { fd: 3, flags: "r", path: challenge },
        { fd: 4, flags: "w", path: resultPath }
      ],
      outputLimitBytes: 1024,
      shell: false,
      timeoutMs: 5000
    });

    expect(result.command).toBe("node direct-test");
    expect(result.stdout).toBe("literal arg");
    await expect(readFile(resultPath, "utf8")).resolves.toContain('"nonce":"n2"');
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
