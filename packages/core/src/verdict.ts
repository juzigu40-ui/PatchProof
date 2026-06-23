import type { CommandResult } from "@patchproof/runner";
import type { CommandEvidence, Proof, ReproductionStatus, StructuredResult } from "./schema.js";

export interface Determinations {
  reproduced_on_base: boolean;
  fixed_on_head: boolean;
  tests_passed: boolean;
  dependency_files_changed: boolean;
  public_api_files_changed: boolean;
  policy_changed: boolean;
  harness_changed: boolean;
  infrastructure_error: boolean;
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
  expectedExitCode: number,
  options: {
    cwd?: string;
    infrastructureErrorReason?: string | null;
    passOverride?: boolean;
    redactedValues?: readonly string[];
    structuredResult?: StructuredResult | null;
  } = {}
): CommandEvidence {
  const infrastructureErrorReason =
    classifyInfrastructureError(result) ?? options.infrastructureErrorReason ?? null;
  const passed =
    infrastructureErrorReason === null &&
    !result.timedOut &&
    (options.passOverride ?? result.exitCode === expectedExitCode);

  return {
    name,
    command: result.command,
    cwd: options.cwd ?? result.cwd,
    commit_sha: commitSha,
    expected_exit_code: expectedExitCode,
    exit_code: result.exitCode,
    signal: result.signal,
    duration_ms: result.durationMs,
    stdout: redactText(result.stdout, [...(options.redactedValues ?? []), result.cwd]),
    stderr: redactText(result.stderr, [...(options.redactedValues ?? []), result.cwd]),
    stdout_truncated: result.stdoutTruncated,
    stderr_truncated: result.stderrTruncated,
    timed_out: result.timedOut,
    structured_result: options.structuredResult ?? null,
    infrastructure_error: infrastructureErrorReason !== null,
    infrastructure_error_reason: infrastructureErrorReason,
    passed
  };
}

export function evaluateDeterminations(input: {
  baseReproduction: CommandEvidence;
  headReproduction: CommandEvidence;
  headTests: CommandEvidence;
  dependencyChangedFiles: readonly string[];
  harnessChanged: boolean;
  publicApiChangedFiles: readonly string[];
  policyChanged: boolean;
}): Determinations {
  const infrastructure_error =
    input.baseReproduction.infrastructure_error ||
    input.headReproduction.infrastructure_error ||
    input.headTests.infrastructure_error;

  return {
    reproduced_on_base: input.baseReproduction.passed,
    fixed_on_head: input.headReproduction.passed,
    tests_passed: input.headTests.passed,
    dependency_files_changed: input.dependencyChangedFiles.length > 0,
    public_api_files_changed: input.publicApiChangedFiles.length > 0,
    policy_changed: input.policyChanged,
    harness_changed: input.harnessChanged,
    infrastructure_error
  };
}

export function evaluateVerdict(determinations: Determinations): Verdict {
  if (
    determinations.reproduced_on_base &&
    determinations.fixed_on_head &&
    determinations.tests_passed &&
    !determinations.harness_changed &&
    !determinations.infrastructure_error
  ) {
    return {
      status: "verified",
      reason: "base reproduction matched, head reproduction matched, and head tests passed",
      exit_code: 0
    };
  }

  const failed: string[] = [];
  if (determinations.infrastructure_error) {
    failed.push("one or more commands ended with an infrastructure error");
  }
  if (determinations.harness_changed) {
    failed.push("trusted reproduction harness changed on head");
  }
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

export function parseStructuredReproductionResult(
  result: CommandResult | string,
  expectedNonce: string
): { infrastructureErrorReason: string | null; structuredResult: StructuredResult | null } {
  const text = typeof result === "string" ? result : `${result.stdout}\n${result.stderr}`;
  const candidates = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("{") && line.endsWith("}"))
    .map(parseStructuredResultLine)
    .filter((candidate): candidate is StructuredResult => candidate !== null);

  if (candidates.length === 0) {
    return {
      infrastructureErrorReason: "structured_result_missing",
      structuredResult: null
    };
  }
  if (candidates.length > 1) {
    return {
      infrastructureErrorReason: "structured_result_ambiguous",
      structuredResult: null
    };
  }

  const structuredResult = candidates[0];
  if (!structuredResult) {
    return {
      infrastructureErrorReason: "structured_result_missing",
      structuredResult: null
    };
  }
  if (structuredResult.nonce !== expectedNonce) {
    return {
      infrastructureErrorReason: "structured_result_nonce_mismatch",
      structuredResult
    };
  }
  if (structuredResult.status === "setup_error") {
    return {
      infrastructureErrorReason: "structured_result_setup_error",
      structuredResult
    };
  }

  return {
    infrastructureErrorReason: null,
    structuredResult
  };
}

export function expectedReproductionStatus(stage: "base" | "head"): ReproductionStatus {
  return stage === "base" ? "assertion_failed" : "assertion_passed";
}

function classifyInfrastructureError(result: CommandResult): string | null {
  const combined = `${result.stderr}\n${result.stdout}`;

  if (result.timedOut) {
    return "timeout";
  }
  if (result.signal !== null) {
    return `signal:${result.signal}`;
  }
  if (result.exitCode === 126 || result.exitCode === 127) {
    return `command_exit_${result.exitCode}`;
  }
  if (/MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND|Cannot find module/.test(combined)) {
    return "missing_module_or_script";
  }
  if (/ModuleNotFoundError|ImportError:|No module named/.test(combined)) {
    return "missing_python_module";
  }
  if (/Missing script:|command not found|No such file or directory|ENOENT/i.test(combined)) {
    return "missing_command_or_file";
  }

  return null;
}

function parseStructuredResultLine(line: string): StructuredResult | null {
  try {
    const parsed = JSON.parse(line) as Partial<StructuredResult>;
    if (
      typeof parsed.nonce === "string" &&
      (parsed.status === "assertion_failed" ||
        parsed.status === "assertion_passed" ||
        parsed.status === "setup_error")
    ) {
      return {
        nonce: parsed.nonce,
        status: parsed.status
      };
    }
  } catch {
    return null;
  }

  return null;
}

function redactText(text: string, redactedValues: readonly string[]): string {
  let redacted = text.replace(
    /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|sk-[A-Za-z0-9_-]{20,}|[A-Za-z0-9+/]{32,}={0,2})\b/g,
    "[REDACTED]"
  );

  for (const value of redactedValues) {
    if (value.length >= 4) {
      redacted = redacted.split(value).join("[REDACTED]");
    }
  }

  return redacted;
}
