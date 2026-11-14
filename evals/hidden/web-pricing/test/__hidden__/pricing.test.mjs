// Graded in a real browser (evals/lib/page.mjs): three .plan cards side by side on desktop and stacked on phones,
// a dark theme for the whole site with readable text, and a Pricing link in every page's header.
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
const at = (path, width, theme, expr) => b.evaluate(`${site.url}${path}`, { width, theme }, expr);

test("desktop: three cards side by side", async () => {
  const v = await at("/pricing", 1280, "light", `({ over: overflowX(1280), cards: rects(".plan"), names: [...document.querySelectorAll(".plan h2")].map((h) => h.textContent.trim()) })`);
  assert.deepEqual(v.names, ["Free", "Pro", "Team"]);
  assert.equal(v.cards.length, 3);
  assert.ok(
    v.cards.every((c) => Math.abs(c.top - v.cards[0].top) < 2),
    "cards are not on one row",
  );
  assert.ok(v.cards[0].left < v.cards[1].left && v.cards[1].left < v.cards[2].left);
  assert.equal(v.over, 0);
});

for (const theme of ["light", "dark"])
  test(`375px ${theme}: cards stacked in one column, nothing wider than the screen`, async () => {
    const v = await at("/pricing", 375, theme, `({ over: overflowX(375), cards: rects(".plan") })`);
    assert.equal(v.cards.length, 3);
    assert.ok(
      v.cards.every((c) => Math.abs(c.left - v.cards[0].left) < 2),
      "cards are not in one column",
    );
    assert.ok(v.cards[0].top < v.cards[1].top && v.cards[1].top < v.cards[2].top);
    for (const c of v.cards) assert.ok(c.left >= 0 && c.right <= 375, `a card spans ${Math.round(c.left)}..${Math.round(c.right)}px`);
    assert.equal(v.over, 0, `the page is ${v.over}px wider than the screen`);
  });

for (const path of ["/", "/about", "/pricing"])
  test(`dark theme on ${path}: dark background, readable heading, Pricing in the header`, async () => {
    const heading = path === "/pricing" ? ".plan h2" : "h1";
    const v = await at(path, 375, "dark", `({ bg: luminance("body"), text: contrast(${JSON.stringify(heading)}), link: !!document.querySelector('header a[href="/pricing"]') })`);
    assert.ok(v.bg < 0.2, `background luminance ${v.bg.toFixed(2)}: not dark`);
    assert.ok(v.text >= 4.5, `${heading} contrast ${v.text.toFixed(2)} (need 4.5)`);
    assert.ok(v.link, "no Pricing link in the header");
  });

test("light theme stays light", async () => {
  const v = await at("/", 1280, "light", `({ bg: luminance("body"), text: contrast("h1") })`);
  assert.ok(v.bg > 0.8);
  assert.ok(v.text >= 4.5);
});
