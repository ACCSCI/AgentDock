import { createFileRoute } from "@tanstack/react-router";
import { DirBrowserModal } from "../components/DirBrowserModal";
import { GitInitConfirmModal } from "../components/GitInitConfirmModal";
import { useOpenProject } from "../hooks/useOpenProject";
import { IconSidebar } from "../components/IconSidebar";

export const Route = createFileRoute("/")({
  component: HomeComponent,
});

function HomeComponent() {
  const {
    openProject,
    modalOpen,
    onModalConfirm,
    onModalCancel,
    gitInitModalOpen,
    gitInitLoading,
    selectedDirPath,
    onGitInitConfirm,
    onGitInitCancel,
  } = useOpenProject();

  return (
    <div className="app-layout">
      <IconSidebar />
      <div className="app-workspace">
        <div className="home-container" data-testid="home-page">
          <button
            type="button"
            className="home-open-btn"
            onClick={openProject}
            data-testid="home-open-project"
          >
            打开项目
          </button>
          <DirBrowserModal open={modalOpen} onConfirm={onModalConfirm} onCancel={onModalCancel} />
          <GitInitConfirmModal
            open={gitInitModalOpen}
            dirPath={selectedDirPath}
            onConfirm={onGitInitConfirm}
            onCancel={onGitInitCancel}
            loading={gitInitLoading}
          />
        </div>
      </div>
    </div>
  );
}
