import { Component, type ErrorInfo, type ReactNode } from "react";
import i18n from "../i18n";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null, errorInfo: null };

  static getDerivedStateFromError(error: unknown): Partial<State> {
    // React allows `throw "string"` or `throw { custom }`.
    // Normalize to Error so .message and .stack are always available.
    const normalized =
      error instanceof Error
        ? error
        : new Error(typeof error === "string" ? error : JSON.stringify(error));
    return { hasError: true, error: normalized };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    this.setState({ errorInfo });
    // Forward to main process → pino log file
    window.api?.reportError?.({
      type: "react-boundary",
      message: error.message,
      stack: error.stack,
      componentStack: errorInfo.componentStack ?? null,
    });
  }

  private handleCopy = () => {
    const { error, errorInfo } = this.state;
    const text = [error?.message, error?.stack, errorInfo?.componentStack]
      .filter(Boolean)
      .join("\n\n");
    navigator.clipboard.writeText(text).catch(() => {});
  };

  private handleReload = () => {
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="error-boundary">
          <div className="error-boundary-box">
            <p className="error-boundary-title">
              {i18n.t("somethingWentWrong", { ns: "error-boundary" })}
            </p>
            <p className="error-boundary-message">
              {this.state.error?.message ?? i18n.t("unknownError", { ns: "error-boundary" })}
            </p>
            {import.meta.env.DEV && this.state.error?.stack && (
              <pre className="error-boundary-stack">{this.state.error.stack}</pre>
            )}
            <div className="error-boundary-actions">
              <button type="button" onClick={this.handleCopy} className="error-boundary-btn">
                {i18n.t("copyStack", { ns: "error-boundary" })}
              </button>
              <button
                type="button"
                onClick={this.handleReload}
                className="error-boundary-btn error-boundary-btn-primary"
              >
                {i18n.t("reload", { ns: "error-boundary" })}
              </button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
