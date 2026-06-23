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

The base config must name a trusted reproduction harness tree with `commands.reproduce.harness_root`
and an `entrypoint` inside that tree. PatchProof records the base and head Git tree SHA for the
harness root and each file's Git blob SHA. Head changes anywhere in the harness tree set
`harness_changed` and block a verified verdict. For reproduction stages, PatchProof exports the base
commit's complete harness tree to a verifier-owned directory outside the worktree and directly
launches the configured entrypoint without a shell.

It then runs each stage in sequence:

1. the trusted harness entrypoint in a base-only disposable worktree,
2. the trusted harness entrypoint in a head-only disposable worktree,
3. the test command in a separate head-only disposable worktree.

Later worktrees are not created until earlier command processes have exited and their temporary
worktree roots have been removed.

Reproduction commands read a verifier challenge from file descriptor 3 and write exactly one line of
JSON to file descriptor 4:

```json
{ "nonce": "...", "status": "assertion_failed" }
```

`stdout` and `stderr` are logs only; structured JSON printed there is not authoritative. PatchProof
does not set `PATCHPROOF_NONCE` or `PATCHPROOF_STAGE` in the command environment.

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

Trusted harnesses should call hostile target code through a subprocess or RPC boundary with a
sanitized environment. Running target code in the same language process as the harness can still
allow semantic bypasses, so it is not a stable hostile-code boundary.

PatchProof sends timeout signals to the command process group and follows with `SIGKILL` after a
short grace period. This is process isolation, not a sandbox. Do not run untrusted pull request
verification on persistent self-hosted runners. Container or cgroup-backed isolation is still
required before treating v0.1 as stable for hostile code.

Codex integration can summarize already captured evidence and suggest missing tests, but it cannot
change deterministic verdict fields or exit codes.
