# Contributing

```bash
npm ci
npm run typecheck && npm test && npm run build
npm run redteam      # must leave RESULTS.md unchanged unless you changed the corpus or the gate
```

Ground rules, in order of importance:

1. **Fail closed.** If a change makes any call go from `deny` or `require_approval` to `allow`, say so in the PR and justify it.
2. **Every security claim has a test, and the test must be able to fail.** Break the code the test is meant to protect and confirm it goes red before you submit.
3. **No runtime dependencies.** The gate has to be small enough to read in one sitting.
4. **Say what was not checked.** README and RESULTS.md state limits plainly; keep it that way. No claim of "first", "unbreakable" or "prevents prompt injection".
5. Detection heuristics (`text.ts` flags) are telemetry. Never let a decision depend on them.

Wanted most: adapters for other open agent frameworks, attack cases that get through, non-English test material written by native readers, and real-model red-team runs with confidence intervals.
