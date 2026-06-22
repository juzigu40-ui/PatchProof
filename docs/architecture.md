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

The v0.1 verifier reads `patchproof.yml` from the trusted base commit, not from the pull request
head. The proof records the trusted config path, source commit, blob SHA, and whether the head
commit changed the policy file.

It then runs:

1. the reproduction command in a base-only disposable worktree,
2. the reproduction command in a head-only disposable worktree,
3. the test command in a separate head-only disposable worktree.

By default, reproduction is considered successful when the configured command exits with code `1` on
base and `0` on head. Tests are considered successful when the configured test command exits with
code `0` on head. Repositories may configure different expected exit codes explicitly in
`patchproof.yml`.

The final verdict is verified only when:

- the bug is reproduced on base,
- the reproduction no longer fails on head,
- tests pass on head,
- no command ended in a classified infrastructure error.

Infrastructure errors include timeouts, signals, missing commands or files, missing Node modules,
and missing Python modules. Infrastructure errors are never accepted as successful bug reproduction,
even when the exit code matches the configured expectation.

Dependency-file and public-API changes are reported as risk signals. They do not automatically fail
v0.1 verification.

## Trust boundaries

Configured commands execute repository code and are treated as untrusted in pull request contexts.
The GitHub Action is designed for `pull_request` workflows with `contents: read`; workflows must not
pass secrets into the verification job. `runtime.env_passthrough` is disabled for untrusted
verification. Each command runs with a temporary `HOME` and a restricted environment.

PatchProof sends timeout signals to the command process group and follows with `SIGKILL` after a
short grace period. This is process isolation, not a sandbox. Do not run untrusted pull request
verification on persistent self-hosted runners.

Codex integration can summarize already captured evidence and suggest missing tests, but it cannot
change deterministic verdict fields or exit codes.
