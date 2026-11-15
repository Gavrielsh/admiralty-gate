# Security policy

This library is a security boundary, so bypasses matter more than ordinary bugs.

**In scope:** any input (tool call, tool name, argument shape, text encoding, MCP message sequence, policy file that validates) that makes the gate return `allow` or forward a call where the documented rules say `require_approval` or `deny`; anything that lets untrusted text become trusted provenance; an audit chain that verifies after being altered.

**Out of scope (documented limits, see README "What it does not do"):** a model being talked into proposing a call; false statements in prose; untraceable passive infra lookups under the default (non-strict) policy; evasion of the telemetry flags in `text.ts`.

**Reporting:** use GitHub's private vulnerability reporting on this repository ("Security" tab, "Report a vulnerability"). Please include a failing test in the style of `test/hardening.test.ts` if you can. Do not open a public issue for a bypass.

Every confirmed bypass gets a regression test and a line in `CHANGELOG.md`.
