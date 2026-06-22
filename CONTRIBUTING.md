# Contributing

Thanks for helping build PatchProof.

## Development

Requirements:

- Node.js 22 or newer
- pnpm 10
- git

Install dependencies:

```sh
pnpm install
```

Run the full local check:

```sh
pnpm check
```

## Review expectations

- Keep changes small and reviewable.
- Add tests for behavior changes.
- Maintain at least 90% coverage for `packages/core` and `packages/config`.
- Preserve deterministic verdict behavior.
- Keep optional LLM functionality out of the pass/fail path.
