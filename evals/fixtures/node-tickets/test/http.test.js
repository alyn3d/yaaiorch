import { test } from "node:test";
import assert from "node:assert/strict";
import { withApp, json } from "./helpers.js";

test("create, read, list, assign, close over HTTP", () =>
  withApp(async (base) => {
    let res = await fetch(`${base}/tickets`, json("POST", { title: "VPN down", priority: "high" }));
    assert.equal(res.status, 201);
    assert.equal((await res.json()).id, 1);
    res = await fetch(`${base}/tickets/1`);
    assert.equal((await res.json()).title, "VPN down");
    res = await fetch(`${base}/tickets/1`, json("PATCH", { assignee: "ana" }));
    assert.equal((await res.json()).assignee, "ana");
    res = await fetch(`${base}/tickets?assignee=ana`);
    assert.equal((await res.json()).length, 1);
    res = await fetch(`${base}/tickets/1/close`, { method: "POST" });
    assert.equal((await res.json()).status, "closed");
  }));

test("errors map to statuses", () =>
  withApp(async (base) => {
    assert.equal((await fetch(`${base}/tickets`, json("POST", { title: "" }))).status, 400);
    assert.equal((await fetch(`${base}/tickets`, { method: "POST", body: "{nope" })).status, 400);
    assert.equal((await fetch(`${base}/tickets/7`)).status, 404);
    assert.equal((await fetch(`${base}/tickets/abc`)).status, 400);
    assert.equal((await fetch(`${base}/nothing`)).status, 404);
    await fetch(`${base}/tickets`, json("POST", { title: "x" }));
    await fetch(`${base}/tickets/1/close`, { method: "POST" });
    const again = await fetch(`${base}/tickets/1/close`, { method: "POST" });
    assert.equal(again.status, 409);
    assert.equal(typeof (await again.json()).error, "string");
  }));
