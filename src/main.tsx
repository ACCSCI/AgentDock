import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  RouterProvider,
  createMemoryHistory,
  createRouter,
} from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { routeTree } from "./routeTree.gen";
import { ToastContainer } from "./components/Toast";
import "./styles/globals.css";
import "./styles/toast.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
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
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
        <ToastContainer />
      </QueryClientProvider>
    </StrictMode>,
  );
}
