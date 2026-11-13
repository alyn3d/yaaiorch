# node-lib-strict

Small utility library. ESM, no dependencies, Node 20+. Modules live in `src/`, tests in `test/` (`node:test` +
`node:assert/strict`). Run `npm test` and `npm run lint`.

House rules, checked by `npm run lint` (`scripts/lint.mjs`):

- Every exported function has a JSDoc block right above it with an `@param` for each parameter and an `@returns`.
- Named exports only, and no `console` calls in `src/`.
- Every `src/<name>.js` has a `test/<name>.test.js`.
