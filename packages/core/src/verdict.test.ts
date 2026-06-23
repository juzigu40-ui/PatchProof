import type { CommandResult } from "@patchproof/runner";
import {
  evaluateDeterminations,
  evaluateVerdict,
  expectedReproductionStatus,
  parseStructuredReproductionResult,
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
      harnessChanged: false,
      policyChanged: false,
      publicApiChangedFiles: ["index.ts"]
    });

    expect(determinations).toEqual({
      reproduced_on_base: true,
      fixed_on_head: true,
      harness_changed: false,
      infrastructure_error: false,
      tests_passed: true,
      dependency_files_changed: false,
      policy_changed: false,
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
      harness_changed: false,
      infrastructure_error: false,
      policy_changed: false,
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
      harness_changed: false,
      infrastructure_error: false,
      policy_changed: false,
      public_api_files_changed: false
    });

    expect(verdict.reason).toContain("base reproduction");
    expect(verdict.reason).toContain("head reproduction");
    expect(verdict.reason).toContain("head tests");
  });

  it("fails when an infrastructure error is present", () => {
    const verdict = evaluateVerdict({
      reproduced_on_base: true,
      fixed_on_head: true,
      tests_passed: true,
      dependency_files_changed: false,
      harness_changed: false,
      infrastructure_error: true,
      policy_changed: false,
      public_api_files_changed: false
    });

    expect(verdict.status).toBe("failed");
    expect(verdict.reason).toContain("infrastructure error");
  });

  it("fails when the trusted harness changed", () => {
    const verdict = evaluateVerdict({
      reproduced_on_base: true,
      fixed_on_head: true,
      tests_passed: true,
      dependency_files_changed: false,
      harness_changed: true,
      infrastructure_error: false,
      policy_changed: false,
      public_api_files_changed: false
    });

    expect(verdict.status).toBe("failed");
    expect(verdict.reason).toContain("trusted reproduction harness changed");
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
      infrastructure_error: false,
      passed: true
    });
    expect(toCommandEvidence("test:head", commandResult, "abc", 1).passed).toBe(false);
  });

  it("classifies missing harness files as infrastructure errors", () => {
    const commandResult: CommandResult = {
      command: "node reproduce.js",
      cwd: "/repo",
      durationMs: 12,
      exitCode: 1,
      signal: null,
      stderr: "Error: Cannot find module '/repo/reproduce.js'",
      stderrTruncated: false,
      stdout: "",
      stdoutTruncated: false,
      timedOut: false
    };

    expect(toCommandEvidence("reproduce:base", commandResult, "abc", 1)).toMatchObject({
      infrastructure_error: true,
      infrastructure_error_reason: "missing_module_or_script",
      passed: false,
      stderr: "Error: Cannot find module '[REDACTED]/reproduce.js'"
    });
  });

  it("classifies infrastructure failures deterministically", () => {
    expect(
      toCommandEvidence("test:head", commandResult({ timedOut: true, exitCode: null }), "abc", 0)
        .infrastructure_error_reason
    ).toBe("timeout");
    expect(
      toCommandEvidence("test:head", commandResult({ signal: "SIGTERM", exitCode: null }), "abc", 0)
        .infrastructure_error_reason
    ).toBe("signal:SIGTERM");
    expect(
      toCommandEvidence("test:head", commandResult({ exitCode: 127 }), "abc", 0)
    ).toMatchObject({
      infrastructure_error_reason: "command_exit_127",
      passed: false
    });
    expect(
      toCommandEvidence(
        "test:head",
        commandResult({ stderr: "ModuleNotFoundError: No module named 'demo'" }),
        "abc",
        1
      ).infrastructure_error_reason
    ).toBe("missing_python_module");
    expect(
      toCommandEvidence(
        "test:head",
        commandResult({ stderr: "sh: missing-tool: command not found" }),
        "abc",
        1
      ).infrastructure_error_reason
    ).toBe("missing_command_or_file");
  });

  it("redacts token-like values and ignores short redaction values", () => {
    const evidence = toCommandEvidence(
      "test:head",
      commandResult({
        stdout: "abc ghp_abcdefghijklmnopqrstuvwxyz123456"
      }),
      "abc",
      0,
      { redactedValues: ["abc"] }
    );

    expect(evidence.stdout).toBe("abc [REDACTED]");
  });

  it("parses nonce-bound structured reproduction results", () => {
    expect(
      parseStructuredReproductionResult(
        commandResult({
          stdout: JSON.stringify({ nonce: "n1", status: "assertion_failed" })
        }),
        "n1"
      )
    ).toEqual({
      infrastructureErrorReason: null,
      structuredResult: { nonce: "n1", status: "assertion_failed" }
    });
    expect(expectedReproductionStatus("base")).toBe("assertion_failed");
    expect(expectedReproductionStatus("head")).toBe("assertion_passed");
  });

  it("treats missing or mismatched structured results as infrastructure errors", () => {
    expect(
      parseStructuredReproductionResult(commandResult({ stdout: "" }), "n1")
        .infrastructureErrorReason
    ).toBe("structured_result_missing");
    expect(
      parseStructuredReproductionResult(commandResult({ stdout: "plain output" }), "n1")
        .infrastructureErrorReason
    ).toBe("structured_result_invalid");
    expect(
      parseStructuredReproductionResult(
        `${JSON.stringify({ nonce: "n1", status: "assertion_failed" })}\ntrailing garbage`,
        "n1"
      ).infrastructureErrorReason
    ).toBe("structured_result_ambiguous");
    expect(parseStructuredReproductionResult("", "n1", "structured_result_too_large")).toEqual({
      infrastructureErrorReason: "structured_result_too_large",
      structuredResult: null
    });
    expect(
      parseStructuredReproductionResult(
        commandResult({ stdout: JSON.stringify({ nonce: "wrong", status: "assertion_passed" }) }),
        "n1"
      ).infrastructureErrorReason
    ).toBe("structured_result_nonce_mismatch");
    expect(
      parseStructuredReproductionResult(
        commandResult({ stdout: JSON.stringify({ nonce: "n1", status: "setup_error" }) }),
        "n1"
      ).infrastructureErrorReason
    ).toBe("structured_result_setup_error");
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
    infrastructure_error: false,
    infrastructure_error_reason: null,
    name: "test",
    passed,
    signal: null,
    stderr: "",
    stderr_truncated: false,
    stdout: "",
    stdout_truncated: false,
    structured_result: null,
    timed_out: false
  };
}

function commandResult(overrides: Partial<CommandResult> = {}): CommandResult {
  return {
    command: "node test.js",
    cwd: "/repo",
    durationMs: 12,
    exitCode: 0,
    signal: null,
    stderr: "",
    stderrTruncated: false,
    stdout: "ok",
    stdoutTruncated: false,
    timedOut: false,
    ...overrides
  };
}
