import type { Proof } from "@patchproof/core";
import { createCodexEvidenceContext, redactSecrets } from "./index.js";

describe("codex", () => {
  it("redacts secret-like values and environment values", () => {
    expect(
      redactSecrets("token ghp_abcdefghijklmnopqrstuvwxyz123456 and literal", {
        API_TOKEN: "literal"
      })
    ).toBe("token [REDACTED] and [REDACTED]");
  });

  it("creates context without changing deterministic verdict", () => {
    const context = createCodexEvidenceContext(sampleProof(), 1024, {
      SECRET_TOKEN: "secret-value"
    });

    expect(context.deterministic_verdict.status).toBe("failed");
    expect(context.commands.head_tests).toContain("[REDACTED]");
  });
});

function sampleProof(): Proof {
  const command = {
    command: "node test.js",
    commit_sha: "a",
    cwd: "/repo",
    duration_ms: 1,
    exit_code: 1,
    expected_exit_code: 0,
    infrastructure_error: false,
    infrastructure_error_reason: null,
    name: "test",
    passed: false,
    signal: null,
    stderr: "secret-value",
    stderr_truncated: false,
    stdout: "",
    stdout_truncated: false,
    structured_result: null,
    timed_out: false
  };

  return {
    adapters: [],
    changed_files: {
      all: [],
      dependency: [],
      public_api: []
    },
    codex: {
      enabled: true,
      verdict_influence: "none"
    },
    commands: {
      reproduction: {
        base: command,
        head: command
      },
      tests: {
        head: command
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
      fixed_on_head: false,
      harness_changed: false,
      infrastructure_error: false,
      policy_changed: false,
      public_api_files_changed: false,
      reproduced_on_base: false,
      tests_passed: false
    },
    harness: {
      base_tree_sha: "base-tree",
      changed: false,
      head_tree_sha: "base-tree",
      root: ".patchproof/harness",
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
      exit_code: 1,
      reason: "failed",
      status: "failed"
    }
  };
}
