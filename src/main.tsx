import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createMemoryHistory, createRouter } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ToastContainer } from "./components/Toast";
import i18n from "./i18n";
import { I18nextProvider } from "./i18n/react";
import { routeTree } from "./routeTree.gen";
import "./styles/globals.css";
import "./styles/toast.css";

// Global error hooks — the React ErrorBoundary only catches render-phase
// exceptions. window.onerror and unhandledrejection cover everything else
// (event handlers, async callbacks, setTimeout). Forwarded to main via
// window.api.reportError so they land in the persistent log file.
window.addEventListener("error", (event) => {
  window.api?.reportError?.({
    type: "window.onerror",
    message: event.message,
    stack: event.error?.stack ?? null,
  });
});

window.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason;
  window.api?.reportError?.({
    type: "unhandledrejection",
    message: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : null,
  });
});

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 3_000,
      refetchOnWindowFocus: false,
    },
  },
});

// Electron prod builds load the renderer from a `file://...index.html`
// URL whose pathname is the literal file path (e.g. `/D:/Projects/.../
// index.html`). The default browserHistory then can't match `/`, so
// every route resolves to "Not Found" out of the box — the home page
// is invisible in production.
//
// Use memory history instead — the renderer is a SPA inside Electron,
// the URL bar isn't meaningful. Dev mode (loaded via the Vite dev
// server at `/`) had no problem with browserHistory either, but
// memory works in both contexts so we can just always use it.
const router = createRouter({
  routeTree,
  history: createMemoryHistory({ initialEntries: ["/"] }),
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

const rootElement = document.getElementById("root");
if (rootElement && !rootElement.innerHTML) {
  const root = createRoot(rootElement);
  root.render(
    <StrictMode>
      <I18nextProvider i18n={i18n}>
        <QueryClientProvider client={queryClient}>
          <RouterProvider router={router} />
          <ToastContainer />
        </QueryClientProvider>
      </I18nextProvider>
    </StrictMode>,
  );
}
