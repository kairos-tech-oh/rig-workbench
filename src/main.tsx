import React from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import App from "./App";
import { SettingsWindow } from "./settings";

/** Shows a render crash instead of leaving the window blank. */
class CrashScreen extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div style={{ padding: 24, color: "#e5534b", fontFamily: "Consolas, monospace" }}>
        <h2 style={{ marginTop: 0 }}>Rig Workbench crashed</h2>
        <pre style={{ whiteSpace: "pre-wrap", color: "#d6dbe4" }}>
          {this.state.error.stack ?? String(this.state.error)}
        </pre>
        <button onClick={() => this.setState({ error: null })}>Try again</button>
      </div>
    );
  }
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <CrashScreen>
      {getCurrentWebviewWindow().label === "settings" ? <SettingsWindow /> : <App />}
    </CrashScreen>
  </React.StrictMode>,
);
