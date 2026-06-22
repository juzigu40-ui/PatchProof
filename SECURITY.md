# Security Policy

## Supported versions

PatchProof is pre-1.0. Security fixes target the latest `main` branch until the first stable
release.

## Reporting a vulnerability

Please report suspected vulnerabilities privately to the maintainers. Do not open a public issue
with exploit details.

## GitHub Action security model

PatchProof is designed to run on `pull_request` with `contents: read`. It must not require
`pull_request_target` for verification. Commands configured by a repository run against pull request
code, so workflows must not expose secrets to the verification job. Do not run untrusted pull
request verification on persistent self-hosted runners.

PatchProof does not interpolate pull request titles or bodies into shell scripts. Codex integration,
when enabled, redacts environment values and secret-like strings before sending context outside the
local process.

PatchProof reads policy from the trusted base commit and records the config blob SHA in the proof.
`runtime.env_passthrough` is disabled for untrusted verification; command phases run with a
temporary `HOME` and restricted environment.
