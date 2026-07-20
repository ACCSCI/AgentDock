import { Outlet, createRootRoute } from "@tanstack/react-router";
import { TanStackRouterDevtools } from "@tanstack/react-router-devtools";
import { CustomTitleBar } from "../components/CustomTitleBar";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { TabBar } from "../components/TabBar";
import { TooltipProvider } from "../components/ui/tooltip";
import { ShortcutsProvider } from "../hooks/useShortcuts";
import { StoreProvider } from "../lib/store";

export const Route = createRootRoute({
  component: RootComponent,
});

function RootComponent() {
  return (
    <ErrorBoundary>
      <StoreProvider>
        <TooltipProvider delayDuration={450} skipDelayDuration={100}>
          <ShortcutsProvider>
            <div className="flex h-full flex-col overflow-hidden">
              <CustomTitleBar />
              <TabBar />
              <div className="flex-1 overflow-hidden">
                <Outlet />
              </div>
            </div>
            {import.meta.env.DEV && <TanStackRouterDevtools position="bottom-right" />}
          </ShortcutsProvider>
        </TooltipProvider>
      </StoreProvider>
    </ErrorBoundary>
  );
}
