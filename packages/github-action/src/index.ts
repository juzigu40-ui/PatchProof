import { appendFileSync } from "node:fs";
import { nodeAdapter } from "@patchproof/adapters-node";
import { pythonAdapter } from "@patchproof/adapters-python";
import { DEFAULT_CONFIG_FILE } from "@patchproof/config";
import { verifyPatchProof } from "@patchproof/core";

export async function runAction(): Promise<number> {
  const workspace = process.env.GITHUB_WORKSPACE ?? process.cwd();
  const baseRef = inputEnv("base-ref", "BASE_REF") ?? requiredEnv("PATCHPROOF_BASE_REF");
  const headRef = inputEnv("head-ref", "HEAD_REF") ?? requiredEnv("PATCHPROOF_HEAD_REF");
  const configPath =
    inputEnv("config", "CONFIG") ?? process.env.PATCHPROOF_CONFIG ?? DEFAULT_CONFIG_FILE;

  const result = await verifyPatchProof({
    adapters: [nodeAdapter, pythonAdapter],
    baseRef,
    configPath,
    headRef,
    repoPath: workspace
  });

  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    appendFileSync(
      summaryPath,
      [
        "## PatchProof",
        "",
        `Verdict: **${result.proof.verdict.status}**`,
        "",
        `Reason: ${result.proof.verdict.reason}`,
        ""
      ].join("\n"),
      "utf8"
    );
  }

  return result.exitCode;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable ${name}`);
  }

  return value;
}

function inputEnv(inputName: string, fallbackName: string): string | undefined {
  const canonicalName = `INPUT_${inputName.replace(/ /g, "_").toUpperCase()}`;
  const fallback = `INPUT_${fallbackName}`;
  return nonEmpty(process.env[canonicalName]) ?? nonEmpty(process.env[fallback]);
}

function nonEmpty(value: string | undefined): string | undefined {
  return value && value.length > 0 ? value : undefined;
}

void runAction()
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 2;
  });
