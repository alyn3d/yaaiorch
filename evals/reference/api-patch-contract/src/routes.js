/**
 * Every route the API answers. test/contract.test.js checks that each one is served, listed in docs/API.md and
 * has a test named after it ("GET /todos ..."); keep the three in step when you add or change a route.
 */
export const ROUTES = [
  { method: "GET", path: "/health", description: "Liveness check: { ok: true }" },
  { method: "GET", path: "/todos", description: "All todos" },
  { method: "PATCH", path: "/todos/:id", description: "Update a todo's title and/or done" },
];
