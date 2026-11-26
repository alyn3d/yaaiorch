// SPDX-FileCopyrightText: 2026 alyn3d and contributors
// SPDX-License-Identifier: GPL-3.0-only

import qrcode from "qrcode-generator";
import { useMemo } from "react";

/** A QR code as SVG squares (no HTML from the library), dark on white so every phone camera reads it. */
export function Qr({ text, size = 220, label }: { text: string; size?: number; label: string }) {
  const cells = useMemo(() => {
    const qr = qrcode(0, "M");
    qr.addData(text);
    qr.make();
    const n = qr.getModuleCount();
    const dark: [number, number][] = [];
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) dark.push([c, r]);
    return { n, dark };
  }, [text]);
  const m = 4; // the quiet zone, in cells
  const span = cells.n + 2 * m;
  return (
    <svg className="qr" role="img" aria-label={label} width={size} height={size} viewBox={`0 0 ${span} ${span}`} shapeRendering="crispEdges">
      <rect width={span} height={span} fill="#fff" />
      <path fill="#000" d={cells.dark.map(([x, y]) => `M${x + m} ${y + m}h1v1h-1z`).join("")} />
    </svg>
  );
}
