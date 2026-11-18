// SPDX-FileCopyrightText: 2026 alyn3d and contributors
// SPDX-License-Identifier: GPL-3.0-only

import { Component, type ErrorInfo, type ReactNode } from "react";

type Props = { children: ReactNode; /** Changing it (another page picked) clears the error and renders the children again. */ resetKey?: string };
type State = { error: Error | null };

/** Keeps a render error in one page from blanking the whole app: the page shows the error, the sidebar stays usable. */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("UI error:", error, info.componentStack);
  }

  componentDidUpdate(prev: Props) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <section className="card ui-error" role="alert">
        <h3>This page hit an error</h3>
        <p className="error">{this.state.error.message || String(this.state.error)}</p>
        <p className="muted">Runs keep going in the background. Try the page again, pick another page, or reload the app.</p>
        <div className="row">
          <button className="primary" onClick={() => this.setState({ error: null })}>
            Try again
          </button>
          <button onClick={() => window.location.reload()}>Reload</button>
        </div>
      </section>
    );
  }
}
