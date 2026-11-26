// SPDX-FileCopyrightText: 2026 alyn3d and contributors
// SPDX-License-Identifier: GPL-3.0-only

import { createRoot } from "react-dom/client";
import { App } from "./App";
import { Pair } from "./Pair";
import "./App.scss";

// A phone opening the pairing link from the PC's QR code gets the pairing page; everything else is the app.
createRoot(document.getElementById("root")!).render(location.pathname === "/pair" ? <Pair /> : <App />);
