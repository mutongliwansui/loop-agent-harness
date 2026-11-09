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

Current test scale: **unit layer 157 test files / 1919 cases (parallel) + integration layer 8 test files / 17 cases (real PTY and other slow cases, serial)**. Before committing, run both `npm run typecheck` and `npm test` — both must report zero errors; run `npm run test:full` for a full regression before pushing or in CI.
