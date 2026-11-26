# shop-api

The shop's JSON API on `node:http`, no dependencies, Node 20+. `createServer(options)` in `src/server.js` builds a
server with its own in-memory store (`options.products` seeds it), so tests can run servers side by side.
`node src/index.js <port>` starts it with demo data. The conventions every endpoint follows are at the top of
`src/server.js`. Run `npm test`.

The web shop (a separate repo) talks to this API.
