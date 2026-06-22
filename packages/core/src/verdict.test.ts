import type { CommandResult } from "@patchproof/runner";
import {
  evaluateDeterminations,
  evaluateVerdict,
  proofExitCode,
  toCommandEvidence
} from "./verdict.js";

describe("verdict", () => {
  it("requires reproduction on base, fix on head, and passing tests", () => {
    const determinations = evaluateDeterminations({
      baseReproduction: evidence(true),
      headReproduction: evidence(true),
      headTests: evidence(true),
      dependencyChangedFiles: [],
      publicApiChangedFiles: ["index.ts"]
    });

    expect(determinations).toEqual({
      reproduced_on_base: true,
      fixed_on_head: true,
      tests_passed: true,
      dependency_files_changed: false,
      public_api_files_changed: true
    });
    expect(evaluateVerdict(determinations)).toMatchObject({
      status: "verified",
      exit_code: 0
    });
  });

  it("fails when deterministic evidence is missing", () => {
    const verdict = evaluateVerdict({
      reproduced_on_base: false,
      fixed_on_head: true,
      tests_passed: true,
      dependency_files_changed: false,
      public_api_files_changed: false
    });

    expect(verdict.status).toBe("failed");
    expect(verdict.exit_code).toBe(1);
    expect(verdict.reason).toContain("base reproduction");
  });

  it("lists every missing deterministic signal", () => {
    const verdict = evaluateVerdict({
      reproduced_on_base: false,
      fixed_on_head: false,
      tests_passed: false,
      dependency_files_changed: false,
      public_api_files_changed: false
    });

    expect(verdict.reason).toContain("base reproduction");
    expect(verdict.reason).toContain("head reproduction");
    expect(verdict.reason).toContain("head tests");
  });

  it("converts command result to evidence", () => {
    const commandResult: CommandResult = {
      command: "node test.js",
      cwd: "/repo",
      durationMs: 12,
      exitCode: 0,
      signal: null,
      stderr: "",
      stderrTruncated: false,
      stdout: "ok",
      stdoutTruncated: false,
      timedOut: false
    };

    expect(toCommandEvidence("test:head", commandResult, "abc", 0)).toMatchObject({
      commit_sha: "abc",
      passed: true
    });
    expect(toCommandEvidence("test:head", commandResult, "abc", 1).passed).toBe(false);
  });

  it("reads proof exit codes", () => {
    expect(proofExitCode({ verdict: { exit_code: 1 } } as never)).toBe(1);
  });
});

function evidence(passed: boolean) {
  return {
    command: "node test.js",
    commit_sha: "abc",
    cwd: "/repo",
    duration_ms: 1,
    exit_code: passed ? 0 : 1,
    expected_exit_code: 0,
    name: "test",
    passed,
    signal: null,
    stderr: "",
    stderr_truncated: false,
    stdout: "",
    stdout_truncated: false,
    timed_out: false
  };
}
