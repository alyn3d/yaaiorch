# node-api-strict

Tiny JSON API on `node:http`, no dependencies, Node 20+. `createServer(options)` in `src/server.js` builds a server
with its own in-memory store (`options.todos` seeds it), so tests can run servers side by side. A todo is
`{ id, title, done }`. Errors are JSON `{ "error": "<message>" }`. Run `npm test`.

The API contract (`test/contract.test.js`, part of `npm test`): every route is registered in `src/routes.js`,
documented in `docs/API.md`, and has a test named after it.
