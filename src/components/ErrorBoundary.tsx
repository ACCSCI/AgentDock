import { Component, type ReactNode, type ErrorInfo } from "react";
import i18n from "../i18n";
import { Button } from "./ui/button";

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
    const normalized = error instanceof Error
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
        <div className="flex h-screen w-full items-center justify-center bg-background p-6">
          <div className="w-full max-w-[600px] rounded-lg border border-destructive-border bg-destructive-bg p-8">
            <p className="mb-2 text-lg font-semibold text-destructive-text">{i18n.t("somethingWentWrong", { ns: "error-boundary" })}</p>
            <p className="mb-4 break-words text-sm text-foreground">
              {this.state.error?.message ?? i18n.t("unknownError", { ns: "error-boundary" })}
            </p>
            {import.meta.env.DEV && this.state.error?.stack && (
              <pre className="mb-4 max-h-60 overflow-auto whitespace-pre-wrap break-all rounded-sm border border-border bg-secondary p-3 font-mono text-xs leading-normal text-muted-foreground">{this.state.error.stack}</pre>
            )}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" size="sm" onClick={this.handleCopy}>
                {i18n.t("copyStack", { ns: "error-boundary" })}
              </Button>
              <Button type="button" variant="default" size="sm" onClick={this.handleReload}>
                {i18n.t("reload", { ns: "error-boundary" })}
              </Button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
