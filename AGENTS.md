# AGENTS.md

PatchProof agents must preserve the project principle: proof, not prose.

- Do not make LLM output the basis for pass or fail.
- Keep core verification deterministic and provider-neutral.
- Keep Codex integration optional and redacted.
- Treat pull request code as untrusted in GitHub Action contexts.
- Do not use `pull_request_target` in workflow examples.
- Do not expose secrets to commands run from untrusted pull requests.
- Do not interpolate pull request titles or bodies into shell scripts.
- Prefer small, reviewable commits.
- Run lint, typecheck, tests, and builds before declaring work complete.
