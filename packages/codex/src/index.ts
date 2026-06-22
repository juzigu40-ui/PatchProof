import type { Proof } from "@patchproof/core";

const SECRET_NAME_PATTERN = /(TOKEN|SECRET|PASSWORD|KEY|CREDENTIAL|AUTH|COOKIE|SESSION)/i;
const SECRET_VALUE_PATTERN =
  /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|sk-[A-Za-z0-9_-]{20,}|[A-Za-z0-9+/]{32,}={0,2})\b/g;

export interface CodexEvidenceContext {
  deterministic_verdict: Proof["verdict"];
  determinations: Proof["determinations"];
  commands: {
    base_reproduction: string;
    head_reproduction: string;
    head_tests: string;
  };
  changed_files: Proof["changed_files"];
}

export function redactSecrets(text: string, env: NodeJS.ProcessEnv = process.env): string {
  let redacted = text.replace(SECRET_VALUE_PATTERN, "[REDACTED]");

  for (const [key, value] of Object.entries(env)) {
    if (!value || value.length < 4) {
      continue;
    }

    if (SECRET_NAME_PATTERN.test(key) || text.includes(value)) {
      redacted = redacted.split(value).join("[REDACTED]");
    }
  }

  return redacted;
}

export function createCodexEvidenceContext(
  proof: Proof,
  maxContextBytes = 32_000,
  env: NodeJS.ProcessEnv = process.env
): CodexEvidenceContext {
  const context: CodexEvidenceContext = {
    deterministic_verdict: proof.verdict,
    determinations: proof.determinations,
    commands: {
      base_reproduction: clipAndRedact(
        `${proof.commands.reproduction.base.stdout}\n${proof.commands.reproduction.base.stderr}`,
        maxContextBytes,
        env
      ),
      head_reproduction: clipAndRedact(
        `${proof.commands.reproduction.head.stdout}\n${proof.commands.reproduction.head.stderr}`,
        maxContextBytes,
        env
      ),
      head_tests: clipAndRedact(
        `${proof.commands.tests.head.stdout}\n${proof.commands.tests.head.stderr}`,
        maxContextBytes,
        env
      )
    },
    changed_files: proof.changed_files
  };

  return context;
}

function clipAndRedact(text: string, maxBytes: number, env: NodeJS.ProcessEnv): string {
  const clipped = Buffer.from(text).subarray(0, maxBytes).toString("utf8");
  return redactSecrets(clipped, env);
}
