import { z } from "zod";

export const CommandEvidenceSchema = z
  .object({
    name: z.string(),
    command: z.string(),
    cwd: z.string(),
    commit_sha: z.string(),
    expected_exit_code: z.number().int().min(0).max(255),
    exit_code: z.number().int().min(0).max(255).nullable(),
    signal: z.string().nullable(),
    duration_ms: z.number().int().nonnegative(),
    stdout: z.string(),
    stderr: z.string(),
    stdout_truncated: z.boolean(),
    stderr_truncated: z.boolean(),
    timed_out: z.boolean(),
    infrastructure_error: z.boolean(),
    infrastructure_error_reason: z.string().nullable(),
    passed: z.boolean()
  })
  .strict();

export const ProofSchema = z
  .object({
    schema_version: z.literal(1),
    patchproof_version: z.string(),
    generated_at: z.string().datetime(),
    repository: z
      .object({
        root: z.string(),
        base_ref: z.string(),
        head_ref: z.string(),
        base_sha: z.string(),
        head_sha: z.string()
      })
      .strict(),
    config: z
      .object({
        path: z.string(),
        source_ref: z.string(),
        source_sha: z.string(),
        blob_sha: z.string(),
        policy_changed: z.boolean()
      })
      .strict(),
    config_path: z.string(),
    environment: z
      .object({
        platform: z.string(),
        node_version: z.string()
      })
      .strict(),
    adapters: z.array(z.string()),
    commands: z
      .object({
        reproduction: z
          .object({
            base: CommandEvidenceSchema,
            head: CommandEvidenceSchema
          })
          .strict(),
        tests: z
          .object({
            head: CommandEvidenceSchema
          })
          .strict()
      })
      .strict(),
    changed_files: z
      .object({
        all: z.array(z.string()),
        dependency: z.array(z.string()),
        public_api: z.array(z.string())
      })
      .strict(),
    determinations: z
      .object({
        reproduced_on_base: z.boolean(),
        fixed_on_head: z.boolean(),
        tests_passed: z.boolean(),
        dependency_files_changed: z.boolean(),
        public_api_files_changed: z.boolean(),
        policy_changed: z.boolean(),
        infrastructure_error: z.boolean()
      })
      .strict(),
    verdict: z
      .object({
        status: z.enum(["verified", "failed"]),
        reason: z.string(),
        exit_code: z.union([z.literal(0), z.literal(1)])
      })
      .strict(),
    codex: z
      .object({
        enabled: z.boolean(),
        verdict_influence: z.literal("none")
      })
      .strict()
  })
  .strict();

export type CommandEvidence = z.infer<typeof CommandEvidenceSchema>;
export type Proof = z.infer<typeof ProofSchema>;

export function validateProof(proof: unknown): Proof {
  return ProofSchema.parse(proof);
}
