# node-tickets

A small support-ticket service with three layers. ESM, no dependencies, Node 20+. Run `npm test`.

| layer | file | what |
|---|---|---|
| store | `src/store.js` | `createStore(seed)`: in-memory tickets (`all`, `get`, `insert`, `update`) |
| service | `src/tickets.js` | `createTicketService({ store, clock })`: business rules and validation |
| errors | `src/errors.js` | `ValidationError` (400), `NotFoundError` (404), `ConflictError` (409) |
| HTTP | `src/http.js` | `createApp({ service })`: a `node:http` server with a tiny router; maps errors to statuses |
| clock | `src/clock.js` | `systemClock`; tests pass a fixed clock (`{ now: () => new Date(...) }`) |
| entry | `src/index.js` | wires the default app |

A ticket is `{ id, title, priority, status, assignee, createdAt }`: `priority` is `low`, `normal`,
`high` or `urgent`; `status` is `open` or `closed`; `createdAt` is an ISO string from the clock.
Errors go out as JSON `{ "error": "<message>" }` with the error's status.

## API

| method and path | body | result |
|---|---|---|
| `GET /tickets?status=&assignee=` | | 200, array in id order |
| `POST /tickets` | `{ title, priority?, assignee? }` | 201, the ticket |
| `GET /tickets/:id` | | 200, the ticket |
| `PATCH /tickets/:id` | `{ assignee }` | 200, the ticket |
| `POST /tickets/:id/close` | | 200, the ticket |
