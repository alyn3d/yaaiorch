const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

function compareValues(a, b) {
  if (typeof a === "number" && typeof b === "number") return a - b;
  return collator.compare(String(a), String(b));
}

/** Stable multi-key sort: spec like "lastName,age:desc"; null/undefined always last. */
export function sortBy(items, spec) {
  const keys = (spec ?? "").split(",").map((part) => part.trim()).filter(Boolean).map((part) => {
    const [key, dir = "asc"] = part.split(":");
    if (dir !== "asc" && dir !== "desc") throw new Error(`bad direction: ${dir}`);
    return { key, sign: dir === "asc" ? 1 : -1 };
  });
  if (!keys.length) throw new Error("empty sort spec");

  return items
    .map((item, index) => ({ item, index }))
    .sort((x, y) => {
      for (const { key, sign } of keys) {
        const a = x.item[key];
        const b = y.item[key];
        const aMissing = a === null || a === undefined;
        const bMissing = b === null || b === undefined;
        if (aMissing || bMissing) {
          if (aMissing && bMissing) continue;
          return aMissing ? 1 : -1;
        }
        const c = compareValues(a, b);
        if (c !== 0) return sign * c;
      }
      return x.index - y.index;
    })
    .map(({ item }) => item);
}
