// Graded in a real browser (evals/lib/page.mjs): no sideways scroll and a visible Export button at 375px, readable
// table headers in dark mode, and the desktop light layout unchanged.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const { startSite, openBrowser } = await import(pathToFileURL(join(process.env.YAAIORCH_EVALS, "lib", "page.mjs")).href);
let site;
let b;
before(async () => {
  site = await startSite(process.cwd());
  b = await openBrowser();
});
after(async () => {
  await b?.close();
  site?.stop();
});
const at = (width, theme, expr) => b.evaluate(`${site.url}/dashboard`, { width, theme }, expr);

for (const theme of ["light", "dark"])
  test(`375px ${theme}: no sideways scroll, Export fully on screen`, async () => {
    const v = await at(375, theme, `({ over: overflowX(375), exp: rect("#export") })`);
    assert.equal(v.over, 0, `the page is ${v.over}px wider than the screen`);
    assert.ok(v.exp, "#export is missing");
    assert.ok(v.exp.left >= 0 && v.exp.right <= 375 && v.exp.width > 0, `#export is at ${Math.round(v.exp.left)}..${Math.round(v.exp.right)}px`);
  });

for (const width of [375, 1280])
  test(`dark at ${width}px: every table header is readable`, async () => {
    const ratios = await at(width, "dark", `[...document.querySelectorAll(".data-table th")].map((_, i) => contrast(".data-table th:nth-child(" + (i + 1) + ")"))`);
    assert.equal(ratios.length, 4);
    for (const r of ratios) assert.ok(r >= 4.5, `header contrast ${r.toFixed(2)} (need 4.5)`);
  });

test("1280px light: unchanged desktop layout", async () => {
  const v = await at(
    1280,
    "light",
    `({ over: overflowX(1280), tools: rects(".toolbar button"), stats: rects(".stat"), thBg: colorOf(".data-table th", "backgroundColor"), th: contrast(".data-table th") })`,
  );
  assert.equal(v.over, 0);
  assert.equal(v.tools.length, 4);
  assert.ok(
    v.tools.every((t) => Math.abs(t.top - v.tools[0].top) < 2),
    "toolbar buttons are not on one row",
  );
  assert.equal(v.stats.length, 4);
  assert.ok(
    v.stats.every((s) => Math.abs(s.top - v.stats[0].top) < 2),
    "the four stats are not on one row",
  );
  assert.equal(v.thBg, "rgb(233, 237, 242)", "table headers lost their light gray background");
  assert.ok(v.th >= 4.5);
});
