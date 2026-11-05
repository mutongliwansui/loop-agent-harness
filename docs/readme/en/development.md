# 🏗️ Development

> [⬅ Back to README](../../../README.md)

```bash
# Dev mode (hot reload)
npm run dev

# Build
npm run build

# Type check
npm run typecheck

# Run tests
npm test

# Watch-mode tests
npm run test:watch
```

Current test scale: **142 test files / 1788 cases** (vitest, run serially so integration cases stay under API rate limits). Before committing, run both `npm run typecheck` and `npm test` — both must report zero errors.
