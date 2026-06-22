import { Component, type ReactNode, type ErrorInfo } from "react";

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

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error };
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
    const text = [
      error?.message,
      error?.stack,
      errorInfo?.componentStack,
    ]
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
            <p className="error-boundary-title">出了点问题</p>
            <p className="error-boundary-message">
              {this.state.error?.message ?? "未知错误"}
            </p>
            {import.meta.env.DEV && this.state.error?.stack && (
              <pre className="error-boundary-stack">{this.state.error.stack}</pre>
            )}
            <div className="error-boundary-actions">
              <button type="button" onClick={this.handleCopy} className="error-boundary-btn">
                复制堆栈
              </button>
              <button type="button" onClick={this.handleReload} className="error-boundary-btn error-boundary-btn-primary">
                重新加载
              </button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
