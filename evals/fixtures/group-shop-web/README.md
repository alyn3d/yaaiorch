# shop-web

The web shop's client side, no dependencies, Node 20+: `src/api.js` (the client for the shop API, a separate repo;
`createApi(baseUrl)`), `src/money.js` (prices in cents to and from what people type and read) and `src/render.js`
(HTML for the pages). Tests use a fake `fetch`. Run `npm test`.
