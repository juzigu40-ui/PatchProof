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

The base config must list `commands.reproduce.harness_files`. PatchProof records each trusted
harness file's base and head Git blob SHA. Head changes to those files set `harness_changed` and
block a verified verdict. For head reproduction, PatchProof overwrites the listed harness files with
the base commit versions before executing the command.

It then runs each stage in sequence:

1. the reproduction command in a base-only disposable worktree,
2. the reproduction command in a head-only disposable worktree,
3. the test command in a separate head-only disposable worktree.

Later worktrees are not created until earlier command processes have exited and their temporary
worktree roots have been removed.

Reproduction commands must emit exactly one line of JSON with the nonce PatchProof supplies in
`PATCHPROOF_NONCE`:

```json
{ "nonce": "...", "status": "assertion_failed" }
```

Allowed statuses are `assertion_failed`, `assertion_passed`, and `setup_error`. Base reproduction
requires `assertion_failed`; head reproduction requires `assertion_passed`. Missing JSON, invalid
JSON, multiple structured results, nonce mismatch, or `setup_error` are infrastructure errors.
Configured reproduction exit codes must also match the base policy expectations; the structured
result distinguishes assertion state from setup failure, and the exit code remains an explicit rule.
Tests are considered successful when the configured test command exits with its expected code on
head.

The final verdict is verified only when:

- the bug is reproduced on base,
- the reproduction no longer fails on head,
- tests pass on head,
- the trusted harness did not change on head,
- no command ended in a classified infrastructure error.

Infrastructure errors include structured-protocol failures, timeouts, signals, missing commands or
files, missing Node modules, and missing Python modules. Infrastructure errors are never accepted as
successful bug reproduction, even when an exit code matches the configured expectation.

Dependency-file and public-API changes are reported as risk signals. They do not automatically fail
v0.1 verification.

## Trust boundaries

Configured commands execute repository code and are treated as untrusted in pull request contexts.
The GitHub Action is designed for `pull_request` workflows with `contents: read`; workflows must not
pass secrets into the verification job. `runtime.env_passthrough` is disabled for untrusted
verification. Each command runs with a temporary `HOME` and a restricted environment.

PatchProof sends timeout signals to the command process group and follows with `SIGKILL` after a
short grace period. This is process isolation, not a sandbox. Do not run untrusted pull request
verification on persistent self-hosted runners. Container or cgroup-backed isolation is still
required before treating v0.1 as stable for hostile code.

Codex integration can summarize already captured evidence and suggest missing tests, but it cannot
change deterministic verdict fields or exit codes.
