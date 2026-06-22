# Architecture

PatchProof separates deterministic verification from optional explanation.

## Packages

- `apps/cli`: command-line entry point for `patchproof`.
- `packages/config`: `patchproof.yml` parsing, defaults, and validation.
- `packages/runner`: process execution and git worktree management.
- `packages/core`: proof orchestration, verdict rules, proof schema validation, and report
  rendering.
- `packages/adapters-node`: Node.js repository detection and default file risk patterns.
- `packages/adapters-python`: Python repository detection and default file risk patterns.
- `packages/github-action`: comment-free GitHub Action wrapper.
- `packages/codex`: optional redacted evidence summarization helpers.

## Verdict model

The v0.1 verifier runs:

1. the reproduction command on the base worktree,
2. the reproduction command on the head worktree,
3. the test command on the head worktree.

By default, reproduction is considered successful when the configured command exits with code `1` on
base and `0` on head. Tests are considered successful when the configured test command exits with
code `0` on head. Repositories may configure different expected exit codes explicitly in
`patchproof.yml`.

The final verdict is verified only when:

- the bug is reproduced on base,
- the reproduction no longer fails on head,
- tests pass on head.

Dependency-file and public-API changes are reported as risk signals. They do not automatically fail
v0.1 verification.

## Trust boundaries

Configured commands execute repository code and are treated as untrusted in pull request contexts.
The GitHub Action is designed for `pull_request` workflows with `contents: read`; workflows must not
pass secrets into the verification job.

Codex integration can summarize already captured evidence and suggest missing tests, but it cannot
change deterministic verdict fields or exit codes.
