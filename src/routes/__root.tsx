import { Outlet, createRootRoute } from "@tanstack/react-router";
import { TanStackRouterDevtools } from "@tanstack/react-router-devtools";
import { ShortcutsProvider } from "../hooks/useShortcuts";
import { TabBar } from "../components/TabBar";
import { StoreProvider } from "../lib/store";

export const Route = createRootRoute({
  component: RootComponent,
});

function RootComponent() {
  return (
    <StoreProvider>
      <ShortcutsProvider>
        <div className="app-shell">
          <TabBar />
          <div className="app-content">
            <Outlet />
          </div>
        </div>
        {import.meta.env.DEV && <TanStackRouterDevtools position="bottom-right" />}
      </ShortcutsProvider>
    </StoreProvider>
  );
}
