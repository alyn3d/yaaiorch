# API

All bodies are JSON. Errors are `{ "error": "<message>" }` with a 4xx status.

| Method | Path | Description |
| --- | --- | --- |
| GET | /health | Liveness check: `{ ok: true }` |
| GET | /todos | All todos, as `[{ id, title, done }]` |
