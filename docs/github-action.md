# GitHub Action

PatchProof verification should run on `pull_request`, not `pull_request_target`. The verification
job requires only `contents: read` and must not receive secrets, because configured commands execute
pull request code.

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
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
          persist-credentials: false

      - uses: actions/setup-node@v4
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
