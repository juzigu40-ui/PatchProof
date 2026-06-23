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

PatchProof is currently a cooperative alpha. It does not yet provide a security boundary against
malicious pull-request code. Run it only on ephemeral GitHub-hosted runners with read-only
permissions and no secrets.

Minimal reproduction commands must use a trusted harness file listed in base config. The harness
reads a verifier challenge from file descriptor 3 and writes exactly one nonce-bound structured
result line to file descriptor 4. `stdout` and `stderr` are captured only as logs:

```yaml
version: 1
commands:
  reproduce:
    run: node reproduce.js
    harness_files:
      - reproduce.js
    expected_exit_code:
      base: 1
      head: 0
  test:
    run: node test.js
```

```js
const { readFileSync, writeFileSync } = require("node:fs");
const challenge = JSON.parse(readFileSync(3, "utf8"));
const status = bugStillPresent() ? "assertion_failed" : "assertion_passed";

writeFileSync(4, `${JSON.stringify({ nonce: challenge.nonce, status })}\n`);
process.exit(status === "assertion_passed" ? 0 : 1);
```

PatchProof requires both the structured status and the configured exit code to match.

## Non-goals for v0.1

PatchProof v0.1 does not include a web dashboard, database, billing, authentication, or automatic
merging.
