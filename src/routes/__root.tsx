import { Outlet, createRootRoute } from "@tanstack/react-router";
import { TanStackRouterDevtools } from "@tanstack/react-router-devtools";
import { CustomTitleBar } from "../components/CustomTitleBar";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { ShortcutsProvider } from "../hooks/useShortcuts";
import { TabBar } from "../components/TabBar";
import { StoreProvider } from "../lib/store";

export const Route = createRootRoute({
  component: RootComponent,
});

function RootComponent() {
  return (
    <ErrorBoundary>
      <StoreProvider>
        <ShortcutsProvider>
          <div className="app-shell">
            <CustomTitleBar />
            <TabBar />
            <div className="app-content">
              <Outlet />
            </div>
          </div>
          {import.meta.env.DEV && <TanStackRouterDevtools position="bottom-right" />}
        </ShortcutsProvider>
      </StoreProvider>
    </ErrorBoundary>
  );
}
