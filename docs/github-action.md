# GitHub Action

PatchProof verification should run on `pull_request`, not `pull_request_target`. The verification
job requires only `contents: read` and must not receive secrets, because configured commands execute
pull request code. Use GitHub-hosted runners for untrusted pull requests; persistent self-hosted
runners can retain attacker-controlled state after a job ends.

```yaml
name: PatchProof

on:
  pull_request:

permissions:
  contents: read

jobs:
  verify:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@93cb6efe18208431cddfb8368fd83d5badbf9bfd # v5
        with:
          fetch-depth: 0
          persist-credentials: false

      - uses: actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e # v6
        with:
          node-version: 22
          cache: pnpm

      - run: corepack enable
      - run: pnpm install --frozen-lockfile

      - name: PatchProof verify
        uses: ./.github/actions/patchproof
        with:
          base-ref: ${{ github.event.pull_request.base.sha }}
          head-ref: ${{ github.event.pull_request.head.sha }}
```

Do not interpolate pull request titles or bodies into shell scripts. The action produces GitHub
Check output through its normal logs and step summary, and it does not post comments by default.
PatchProof reads `patchproof.yml` from the base commit for the current verdict and records the
trusted config blob SHA in `proof.json`; policy edits in the pull request are reported as
`policy_changed`.

## Optional summary job

Posting a summary can be separated into a distinct job with explicitly scoped permissions. Keep it
independent from the untrusted verification commands.

```yaml
jobs:
  summarize:
    needs: verify
    if: always()
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    steps:
      - name: Post summary
        run: echo "Use a repository-approved summary publisher here."
```
