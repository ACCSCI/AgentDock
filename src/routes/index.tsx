import { createFileRoute } from "@tanstack/react-router";
import { DirBrowserModal } from "../components/DirBrowserModal";
import { useOpenProject } from "../hooks/useOpenProject";

export const Route = createFileRoute("/")({
  component: HomeComponent,
});

function HomeComponent() {
  const { openProject, modalOpen, onModalConfirm, onModalCancel } = useOpenProject();

  return (
    <div className="home-container">
      <button type="button" className="home-open-btn" onClick={openProject}>
        打开项目
      </button>
      <DirBrowserModal open={modalOpen} onConfirm={onModalConfirm} onCancel={onModalCancel} />
    </div>
  );
}
