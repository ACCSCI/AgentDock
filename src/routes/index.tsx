import { createFileRoute } from "@tanstack/react-router";
import { ArrowRight, FolderGit2, GitBranch, PanelsTopLeft, TerminalSquare } from "lucide-react";
import { DirBrowserModal } from "../components/DirBrowserModal";
import { GitInitConfirmModal } from "../components/GitInitConfirmModal";
import { IconSidebar } from "../components/IconSidebar";
import { Button } from "../components/ui/button";
import { useOpenProject } from "../hooks/useOpenProject";

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
    <div className="flex h-full">
      <IconSidebar />
      <div className="flex flex-1 flex-col overflow-hidden">
        <main
          id="main-content"
          className="relative flex min-h-0 flex-1 overflow-auto bg-background"
          data-testid="home-page"
        >
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 opacity-60 [background-image:linear-gradient(to_right,var(--border)_1px,transparent_1px),linear-gradient(to_bottom,var(--border)_1px,transparent_1px)] [background-size:32px_32px] [mask-image:linear-gradient(to_bottom,black,transparent_78%)]"
          />
          {/* Centered content with comfortable whitespace on all sides. The
              grid + place-items-center centers the max-width column on both
              axes; min-h-full keeps the grid track as tall as the viewport so
              centering works even though `main` is a scroll container. The
              page gutter (p-*) guarantees a margin before centering kicks in. */}
          <div className="relative grid min-h-full w-full place-items-center px-8 py-14 sm:px-12">
            <div className="flex w-full max-w-4xl flex-col">
            <div className="mb-7 inline-flex w-fit items-center gap-2 rounded-full border border-border bg-card/80 px-3 py-1 font-mono text-[0.6875rem] uppercase tracking-[0.16em] text-muted-foreground shadow-xs backdrop-blur">
              <span className="size-1.5 rounded-full bg-success shadow-[0_0_0_3px_color-mix(in_oklab,var(--success)_16%,transparent)]" />
              Operator console
            </div>
            <h1 className="max-w-3xl text-balance text-[clamp(2rem,4vw,3.75rem)] font-semibold leading-[1.06] tracking-[-0.02em] text-foreground">
              每个 Agent，
              <br />
              <span className="text-primary">都有清晰的工作现场。</span>
            </h1>
            <p className="mt-5 max-w-xl text-pretty text-sm leading-6 text-muted-foreground">
              在独立 worktree 中启动会话，集中管理终端、端口、任务与项目状态。选择一个 Git
              项目开始。
            </p>
            <div className="mt-8 flex items-center gap-3">
              <Button size="lg" onClick={openProject} data-testid="home-open-project">
                <FolderGit2 aria-hidden="true" />
                打开项目
                <ArrowRight aria-hidden="true" />
              </Button>
              <span className="font-mono text-xs text-muted-foreground" data-testid="home-status-hint">
                选择一个 Git 项目开始
              </span>
            </div>
            <ul
              className="mt-14 grid max-w-3xl grid-cols-1 gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-3"
              aria-label="AgentDock 能力"
            >
              {[
                [GitBranch, "Isolated", "每个会话使用独立 worktree"],
                [TerminalSquare, "Observable", "终端与生命周期状态同屏"],
                [PanelsTopLeft, "Coordinated", "项目、任务与端口集中管理"],
              ].map(([Icon, label, copy]) => {
                const FeatureIcon = Icon as typeof GitBranch;
                return (
                  <li key={label as string} className="bg-card p-4 transition-colors hover:bg-accent/50">
                    <FeatureIcon aria-hidden="true" className="mb-4 size-4 text-primary" />
                    <div className="font-mono text-xs font-semibold text-foreground">
                      {label as string}
                    </div>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">{copy as string}</p>
                  </li>
                );
              })}
            </ul>
            </div>
          </div>
          <DirBrowserModal open={modalOpen} onConfirm={onModalConfirm} onCancel={onModalCancel} />
          <GitInitConfirmModal
            open={gitInitModalOpen}
            dirPath={selectedDirPath}
            onConfirm={onGitInitConfirm}
            onCancel={onGitInitCancel}
            loading={gitInitLoading}
          />
        </main>
      </div>
    </div>
  );
}
