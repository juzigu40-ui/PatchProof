export type { PatchProofConfig } from "@patchproof/config";
export type { CommandResult } from "@patchproof/runner";
export type {
  CommandEvidence,
  HarnessFileEvidence,
  Proof,
  ReproductionStatus,
  StructuredResult
} from "./schema.js";
export {
  CommandEvidenceSchema,
  HarnessFileSchema,
  ProofSchema,
  ReproductionStatusSchema,
  StructuredResultSchema,
  validateProof
} from "./schema.js";
export { renderJsonReport, renderMarkdownReport } from "./report.js";
export type { RepositoryAdapter, RiskPatterns } from "./risk.js";
export { collectRiskPatterns, matchChangedFiles } from "./risk.js";
export type { Determinations, Verdict } from "./verdict.js";
export {
  evaluateDeterminations,
  evaluateVerdict,
  expectedReproductionStatus,
  parseStructuredReproductionResult,
  proofExitCode,
  toCommandEvidence
} from "./verdict.js";
export type { VerifyOptions, VerifyResult } from "./verify.js";
export {
  PATCHPROOF_VERSION,
  VerificationRuntimeError,
  loadProof,
  verifyPatchProof,
  writeProofFiles
} from "./verify.js";
