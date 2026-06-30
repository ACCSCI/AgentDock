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
  const project = projects?.find((p) => p.id === activeProjectId);

  return (
    <div className="app-layout">
      <IconSidebar />
      {project && <SessionSidebar />}
      <div className="app-workspace">
        <Outlet />
      </div>
    </div>
  );
}
