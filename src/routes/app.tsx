import { Outlet, createFileRoute } from "@tanstack/react-router";
import { IconSidebar } from "../components/IconSidebar";
import { SessionSidebar } from "../components/SessionSidebar";
import { useProjects } from "../lib/queries";
import { useStore } from "../lib/store";

export const Route = createFileRoute("/app")({
  component: AppLayout,
});

function AppLayout() {
  const { activeProjectId } = useStore();
  const { data: projects } = useProjects();
  // Match by id first (nanoid from DB), then by path fallback (v2State
  // path-based IDs when the project was opened by path rather than DB id).
  const project = projects?.find((p) => p.id === activeProjectId)
    ?? projects?.find((p) => p.path === activeProjectId);

  return (
    <div className="app-layout">
      {project && <IconSidebar />}
      {project && <SessionSidebar />}
      <div className="app-workspace">
        <Outlet />
      </div>
    </div>
  );
}
