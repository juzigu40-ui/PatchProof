import { renderJsonReport, renderMarkdownReport } from "./report.js";
import type { Proof } from "./schema.js";
import { validateProof } from "./schema.js";

describe("reports", () => {
  it("renders valid json and markdown reports", () => {
    const proof = sampleProof();

    expect(validateProof(JSON.parse(renderJsonReport(proof))).verdict.status).toBe("verified");
    expect(renderMarkdownReport(proof)).toContain("Verdict: **verified**");
  });

  it("renders non-empty dependency and empty public API risk lists", () => {
    const proof = sampleProof();
    proof.changed_files.dependency = ["package.json"];
    proof.changed_files.public_api = [];
    proof.commands.tests.head.exit_code = null;

    const markdown = renderMarkdownReport(proof);

    expect(markdown).toContain("Dependency files: package.json");
    expect(markdown).toContain("Public API files: none");
    expect(markdown).toContain("- exit_code: null");
  });
});

function sampleProof(): Proof {
  return {
    adapters: ["node"],
    changed_files: {
      all: ["index.ts"],
      dependency: [],
      public_api: ["index.ts"]
    },
    codex: {
      enabled: false,
      verdict_influence: "none"
    },
    commands: {
      reproduction: {
        base: command("reproduce:base", 1, 1),
        head: command("reproduce:head", 0, 0)
      },
      tests: {
        head: command("test:head", 0, 0)
      }
    },
    config: {
      blob_sha: "config-blob",
      path: "patchproof.yml",
      policy_changed: false,
      source_ref: "base",
      source_sha: "a"
    },
    config_path: "patchproof.yml",
    determinations: {
      dependency_files_changed: false,
      fixed_on_head: true,
      harness_changed: false,
      infrastructure_error: false,
      policy_changed: false,
      public_api_files_changed: true,
      reproduced_on_base: true,
      tests_passed: true
    },
    harness: {
      changed: false,
      files: [
        {
          base_blob_sha: "base-harness",
          changed: false,
          head_blob_sha: "base-harness",
          path: "reproduce.js"
        }
      ]
    },
    environment: {
      node_version: "v22.0.0",
      platform: "linux"
    },
    generated_at: new Date("2026-01-01T00:00:00.000Z").toISOString(),
    patchproof_version: "0.1.0",
    repository: {
      base_ref: "base",
      base_sha: "a",
      head_ref: "head",
      head_sha: "b",
      root: "."
    },
    schema_version: 1,
    verdict: {
      exit_code: 0,
      reason: "ok",
      status: "verified"
    }
  };
}

function command(name: string, exitCode: number, expectedExitCode: number) {
  return {
    command: "node test.js",
    commit_sha: "a",
    cwd: "/repo",
    duration_ms: 1,
    exit_code: exitCode,
    expected_exit_code: expectedExitCode,
    name,
    infrastructure_error: false,
    infrastructure_error_reason: null,
    passed: exitCode === expectedExitCode,
    signal: null,
    stderr: "",
    stderr_truncated: false,
    stdout: "",
    stdout_truncated: false,
    structured_result: null,
    timed_out: false
  };
}
