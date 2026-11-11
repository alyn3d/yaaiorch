# node-api

Tiny JSON API on `node:http`, no dependencies, Node 20+. `createServer(options)` in `src/server.js` builds a server with its own in-memory store (`options.todos` seeds it), so tests can run servers side by side. A todo is `{ id, title, done }`. Errors are JSON `{ "error": "<message>" }`. Run `npm test`.
