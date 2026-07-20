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
    <div className="flex h-full">
      <IconSidebar />
      {project && <SessionSidebar />}
      <div className="flex flex-1 flex-col overflow-hidden">
        <Outlet />
      </div>
    </div>
  );
}
