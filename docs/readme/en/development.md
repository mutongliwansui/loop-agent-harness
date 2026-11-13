# 🏗️ Development

> [⬅ Back to README](../../../README.md)

```bash
# Dev mode (hot reload)
npm run dev

# Build
npm run build

# Type check
npm run typecheck

# Run tests (unit layer, parallel execution)
npm test

# Integration tests (real PTY and other slow cases, serial execution)
npm run test:integration

# Full test suite (unit + integration)
npm run test:full

# Watch-mode tests
npm run test:watch

# Run only tests related to changed files
npm run test:related
```

Current test scale: **unit layer 161 test files / 2020 cases (parallel) + integration layer 8 test files / 17 cases (real PTY and other slow cases, serial)**. Before committing, run both `npm run typecheck` and `npm test` — both must report zero errors; run `npm run test:full` for a full regression before pushing or in CI.

> **Live-model cases are skipped by default**: six cases in `tests/integration/` (a/b/c/d/f/g) call a real LLM, and their credentials come from outside the test's temporary home, so they always fail in routine regressions (connection timeout when offline, 401 when online). They are now gated by `LOOP_AGENT_LIVE_MODEL` (implementation: `tests/integration/live-model-gate.ts`): **not set means the whole group is skipped**, with the reason appended to each case name. For real end-to-end checks:

```bash
# Confirm OPENAI_API_KEY and OPENAI_BASE_URL / MODEL_NAME belong to the same provider first.
# If OPENAI_API_KEY is unset, the gate falls back to model.apiKey in ~/.loop-agent/config.json.
LOOP_AGENT_LIVE_MODEL=1 npm run test:integration
```
