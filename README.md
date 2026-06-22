# PatchProof

PatchProof is a provider-neutral CLI and GitHub Action for verifying whether a pull request has
reproducible evidence for its claimed fix.

The core rule is proof, not prose: LLM output can summarize evidence, infer claimed intent, and
suggest missing tests, but it never determines pass or fail. Verdicts come from deterministic
command execution and explicit rules.

## Status

PatchProof is pre-1.0 software. v0.1 focuses on Linux and macOS support for Node.js and Python
repositories.

## Commands

```sh
patchproof init
patchproof verify --base <ref> --head <ref>
patchproof report --format json
patchproof report --format markdown
```

`verify` reads the trusted base commit's `patchproof.yml`, creates isolated git worktrees for the
base reproduction, head reproduction, and head test phases, executes the configured commands with
timeouts, and writes:

- `.patchproof/proof.json`
- `.patchproof/proof.md`

## Non-goals for v0.1

PatchProof v0.1 does not include a web dashboard, database, billing, authentication, or automatic
merging.
