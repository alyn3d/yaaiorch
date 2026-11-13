# API

All bodies are JSON. Errors are `{ "error": "<message>" }` with a 4xx status.

| Method | Path | Description |
| --- | --- | --- |
| GET | /health | Liveness check: `{ ok: true }` |
| GET | /todos | All todos, as `[{ id, title, done }]` |
| PATCH | /todos/:id | Update `title` (1 to 200 characters after trimming) and/or `done` (boolean); 200 with the todo, 404 for an unknown id, 400 for bad input |
