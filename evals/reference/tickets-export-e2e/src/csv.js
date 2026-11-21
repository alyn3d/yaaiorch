/** A field as CSV: quoted (with doubled quotes) only when it contains a comma, a quote, CR or LF. */
export function csvField(value) {
  const s = value === null || value === undefined ? "" : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Keep spreadsheets from running a cell as a formula. */
export const defuse = (s) => (/^[=+\-@]/.test(s) ? `'${s}` : s);

/** Rows of objects as CSV: a header of `columns`, CRLF after every line, the last included. */
export function toCsv(rows, columns) {
  return [columns, ...rows.map((r) => columns.map((c) => r[c]))].map((cells) => cells.map(csvField).join(",") + "\r\n").join("");
}
