import { test } from "node:test";
import assert from "node:assert/strict";
import { withApp, json } from "../helpers.js";

const HEADER = "id,title,priority,status,assignee,createdAt\r\n";
const T = "2026-03-02T10:00:00.000Z";

test("export: header, CRLF after every line, empty assignee, content type", () =>
  withApp(async (base) => {
    let res = await fetch(`${base}/tickets/export`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /^text\/csv;\s*charset=utf-8$/i);
    assert.equal(await res.text(), HEADER);
    await fetch(`${base}/tickets`, json("POST", { title: "VPN down", priority: "high", assignee: "ana" }));
    await fetch(`${base}/tickets`, json("POST", { title: "Printer" }));
    res = await fetch(`${base}/tickets/export`);
    assert.equal(await res.text(), `${HEADER}1,VPN down,high,open,ana,${T}\r\n2,Printer,normal,open,,${T}\r\n`);
  }));

test("export quotes fields with commas, quotes and line breaks, and nothing else", () =>
  withApp(async (base) => {
    await fetch(`${base}/tickets`, json("POST", { title: 'Say "hi", then\nleave' }));
    await fetch(`${base}/tickets`, json("POST", { title: "a\r\nb" }));
    await fetch(`${base}/tickets`, json("POST", { title: "plain title" }));
    const text = await (await fetch(`${base}/tickets/export`)).text();
    assert.equal(
      text,
      `${HEADER}1,"Say ""hi"", then\nleave",normal,open,,${T}\r\n` + `2,"a\r\nb",normal,open,,${T}\r\n` + `3,plain title,normal,open,,${T}\r\n`,
    );
  }));

test("export defuses titles that a spreadsheet would run as a formula", () =>
  withApp(async (base) => {
    for (const title of ["=SUM(A1:A2)", "+1", "-2", "@cmd", "a=b", "=x,y"]) await fetch(`${base}/tickets`, json("POST", { title }));
    const rows = (await (await fetch(`${base}/tickets/export`)).text()).split("\r\n").slice(1, -1);
    assert.deepEqual(
      rows.map((r) => r.split(",normal,")[0]),
      ["1,'=SUM(A1:A2)", "2,'+1", "3,'-2", "4,'@cmd", "5,a=b", `6,"'=x,y"`],
    );
  }));

test("export filters like the list, in id order; a bad status is a 400 JSON error", () =>
  withApp(async (base) => {
    await fetch(`${base}/tickets`, json("POST", { title: "one", assignee: "ana" }));
    await fetch(`${base}/tickets`, json("POST", { title: "two", assignee: "bob" }));
    await fetch(`${base}/tickets`, json("POST", { title: "three", assignee: "ana" }));
    await fetch(`${base}/tickets/3/close`, { method: "POST" });
    const ids = async (q) =>
      (await (await fetch(`${base}/tickets/export${q}`)).text())
        .split("\r\n")
        .slice(1, -1)
        .map((r) => Number(r.split(",")[0]));
    assert.deepEqual(await ids(""), [1, 2, 3]);
    assert.deepEqual(await ids("?assignee=ana"), [1, 3]);
    assert.deepEqual(await ids("?status=open&assignee=ana"), [1]);
    assert.deepEqual(await ids("?status=closed"), [3]);
    assert.deepEqual(await ids("?assignee=nobody"), []);
    const bad = await fetch(`${base}/tickets/export?status=done`);
    assert.equal(bad.status, 400);
    assert.equal(typeof (await bad.json()).error, "string");
  }));

test("the other ticket routes still work", () =>
  withApp(async (base) => {
    await fetch(`${base}/tickets`, json("POST", { title: "x" }));
    assert.equal((await fetch(`${base}/tickets/1`)).status, 200);
    assert.equal((await fetch(`${base}/tickets/exports`)).status, 400);
  }));
