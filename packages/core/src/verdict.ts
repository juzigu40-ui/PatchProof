import type { CommandResult } from "@patchproof/runner";
import type { CommandEvidence, Proof } from "./schema.js";

export interface Determinations {
  reproduced_on_base: boolean;
  fixed_on_head: boolean;
  tests_passed: boolean;
  dependency_files_changed: boolean;
  public_api_files_changed: boolean;
}

export interface Verdict {
  status: "verified" | "failed";
  reason: string;
  exit_code: 0 | 1;
}

export function toCommandEvidence(
  name: string,
  result: CommandResult,
  commitSha: string,
  expectedExitCode: number
): CommandEvidence {
  const passed = !result.timedOut && result.exitCode === expectedExitCode;

  return {
    name,
    command: result.command,
    cwd: result.cwd,
    commit_sha: commitSha,
    expected_exit_code: expectedExitCode,
    exit_code: result.exitCode,
    signal: result.signal,
    duration_ms: result.durationMs,
    stdout: result.stdout,
    stderr: result.stderr,
    stdout_truncated: result.stdoutTruncated,
    stderr_truncated: result.stderrTruncated,
    timed_out: result.timedOut,
    passed
  };
}

export function evaluateDeterminations(input: {
  baseReproduction: CommandEvidence;
  headReproduction: CommandEvidence;
  headTests: CommandEvidence;
  dependencyChangedFiles: readonly string[];
  publicApiChangedFiles: readonly string[];
}): Determinations {
  return {
    reproduced_on_base: input.baseReproduction.passed,
    fixed_on_head: input.headReproduction.passed,
    tests_passed: input.headTests.passed,
    dependency_files_changed: input.dependencyChangedFiles.length > 0,
    public_api_files_changed: input.publicApiChangedFiles.length > 0
  };
}

export function evaluateVerdict(determinations: Determinations): Verdict {
  if (
    determinations.reproduced_on_base &&
    determinations.fixed_on_head &&
    determinations.tests_passed
  ) {
    return {
      status: "verified",
      reason: "base reproduction matched, head reproduction matched, and head tests passed",
      exit_code: 0
    };
  }

  const failed: string[] = [];
  if (!determinations.reproduced_on_base) {
    failed.push("base reproduction did not match the expected exit code");
  }
  if (!determinations.fixed_on_head) {
    failed.push("head reproduction did not match the expected exit code");
  }
  if (!determinations.tests_passed) {
    failed.push("head tests did not match the expected exit code");
  }

  return {
    status: "failed",
    reason: failed.join("; "),
    exit_code: 1
  };
}

export function proofExitCode(proof: Proof): 0 | 1 {
  return proof.verdict.exit_code;
}
