import { Component } from "react";

/**
 * Catches render errors so a single bad value does not blank the whole window.
 *
 * React unmounts the entire tree on an uncaught render error, which looks
 * exactly like the app failing to start — no message, no clue where to look.
 * This turns that into something readable and recoverable.
 */
export class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error("render error", error, info?.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div
        style={{
          height: "100vh",
          width: "100vw",
          boxSizing: "border-box",
          background: "#0D1014",
          color: "#E4E7EB",
          fontFamily: '"Segoe UI Variable Text","Segoe UI",system-ui,sans-serif',
          display: "grid",
          placeItems: "center",
          padding: 32,
        }}
      >
        <div style={{ maxWidth: 560, width: "100%" }}>
          <div
            style={{
              fontFamily: '"Cascadia Mono",Consolas,ui-monospace,monospace',
              fontSize: 10.5,
              letterSpacing: "0.16em",
              textTransform: "uppercase",
              color: "#E05A4E",
              marginBottom: 10,
            }}
          >
            Something broke
          </div>
          <div
            style={{
              fontFamily: '"Bahnschrift","Segoe UI Variable Display","Segoe UI",sans-serif',
              fontWeight: 700,
              fontSize: 26,
              textTransform: "uppercase",
              marginBottom: 14,
            }}
          >
            The app hit an error
          </div>

          <pre
            style={{
              fontFamily: '"Cascadia Mono",Consolas,ui-monospace,monospace',
              fontSize: 12.5,
              lineHeight: 1.5,
              background: "#151A21",
              border: "1px solid #29323D",
              borderLeft: "3px solid #E05A4E",
              borderRadius: 5,
              padding: "14px 16px",
              overflowX: "auto",
              color: "#C9D3DC",
              marginBottom: 18,
            }}
          >
            {String(error?.message ?? error)}
          </pre>

          <div style={{ display: "flex", gap: 8 }}>
            <button
              onClick={() => this.setState({ error: null })}
              style={{
                background: "#2FC8BF",
                border: "none",
                borderRadius: 4,
                padding: "9px 16px",
                fontWeight: 600,
                fontSize: 13,
                color: "#07110F",
                cursor: "pointer",
                fontFamily: "inherit",
              }}
            >
              Try again
            </button>
            <button
              onClick={() => window.location.reload()}
              style={{
                background: "#1C232C",
                border: "1px solid #343E4B",
                borderRadius: 4,
                padding: "9px 16px",
                fontWeight: 600,
                fontSize: 13,
                color: "#E4E7EB",
                cursor: "pointer",
                fontFamily: "inherit",
              }}
            >
              Reload
            </button>
          </div>

          <div style={{ marginTop: 14, fontSize: 12, color: "#4E5966", lineHeight: 1.5 }}>
            The full stack trace is in the developer console.
          </div>
        </div>
      </div>
    );
  }
}
