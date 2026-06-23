import type { Proof } from "./schema.js";
import { validateProof } from "./schema.js";

export function renderJsonReport(proof: Proof): string {
  return `${JSON.stringify(validateProof(proof), null, 2)}\n`;
}

export function renderMarkdownReport(proof: Proof): string {
  const validProof = validateProof(proof);
  const lines = [
    "# PatchProof Report",
    "",
    `Verdict: **${validProof.verdict.status}**`,
    "",
    `Reason: ${validProof.verdict.reason}`,
    "",
    "## Determinations",
    "",
    `- reproduced_on_base: ${validProof.determinations.reproduced_on_base}`,
    `- fixed_on_head: ${validProof.determinations.fixed_on_head}`,
    `- tests_passed: ${validProof.determinations.tests_passed}`,
    `- dependency_files_changed: ${validProof.determinations.dependency_files_changed}`,
    `- public_api_files_changed: ${validProof.determinations.public_api_files_changed}`,
    `- policy_changed: ${validProof.determinations.policy_changed}`,
    `- harness_changed: ${validProof.determinations.harness_changed}`,
    `- infrastructure_error: ${validProof.determinations.infrastructure_error}`,
    "",
    "## Repository",
    "",
    `- base_ref: ${validProof.repository.base_ref}`,
    `- base_sha: ${validProof.repository.base_sha}`,
    `- head_ref: ${validProof.repository.head_ref}`,
    `- head_sha: ${validProof.repository.head_sha}`,
    "",
    "## Config",
    "",
    `- path: ${validProof.config.path}`,
    `- source_ref: ${validProof.config.source_ref}`,
    `- source_sha: ${validProof.config.source_sha}`,
    `- blob_sha: ${validProof.config.blob_sha}`,
    `- policy_changed: ${validProof.config.policy_changed}`,
    "",
    "## Harness",
    "",
    `- changed: ${validProof.harness.changed}`,
    ...validProof.harness.files.map(
      (file) =>
        `- ${file.path}: base=${file.base_blob_sha}, head=${file.head_blob_sha ?? "null"}, changed=${file.changed}`
    ),
    "",
    "## Commands",
    "",
    commandSummary("base reproduction", validProof.commands.reproduction.base),
    commandSummary("head reproduction", validProof.commands.reproduction.head),
    commandSummary("head tests", validProof.commands.tests.head),
    "",
    "## Changed Files",
    "",
    `Dependency files: ${validProof.changed_files.dependency.length === 0 ? "none" : validProof.changed_files.dependency.join(", ")}`,
    "",
    `Public API files: ${validProof.changed_files.public_api.length === 0 ? "none" : validProof.changed_files.public_api.join(", ")}`,
    ""
  ];

  return `${lines.join("\n")}\n`;
}

function commandSummary(label: string, command: Proof["commands"]["tests"]["head"]): string {
  return [
    `### ${label}`,
    "",
    `- command: \`${command.command}\``,
    `- commit_sha: ${command.commit_sha}`,
    `- expected_exit_code: ${command.expected_exit_code}`,
    `- exit_code: ${command.exit_code ?? "null"}`,
    `- duration_ms: ${command.duration_ms}`,
    `- timed_out: ${command.timed_out}`,
    `- structured_result: ${command.structured_result ? JSON.stringify(command.structured_result) : "null"}`,
    `- infrastructure_error: ${command.infrastructure_error}`,
    `- infrastructure_error_reason: ${command.infrastructure_error_reason ?? "null"}`,
    `- passed: ${command.passed}`,
    ""
  ].join("\n");
}
