import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { AGENTDOCK_COMPAT_PROMPT } from "../constants/agentdock-compat-prompt";
import { OrphanCleanModal } from "./OrphanCleanModal";
import { useTranslation } from "../i18n/react";

export function IconSidebar() {
  const { t } = useTranslation("sidebar");
  const navigate = useNavigate();
  const [orphanModalOpen, setOrphanModalOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const queryClient = useQueryClient();

  const openOrphanModal = () => {
    // Force a fresh scan on every open click: the modal query is disabled
    // when closed, but the cached data is otherwise served stale-on-mount
    // for an instant. Invalidating here guarantees the user always sees
    // the latest disk state with an explicit loading indicator.
    queryClient.invalidateQueries({ queryKey: ["orphans"] });
    setOrphanModalOpen(true);
  };

  const handleCopyPrompt = async () => {
    try {
      await navigator.clipboard?.writeText(AGENTDOCK_COMPAT_PROMPT);
      setCopied(true);
    } catch {
      // Silent: mirrors SessionSidebar's clipboard fallback pattern
    }
  };

  // Reset the ✅ indicator after 1.5s. Managed via useEffect so the timer
  // is cleared on unmount and re-running the effect cancels any pending
  // timer from a previous click — no leaked timers, no race.
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <>
      <div className="icon-sidebar" data-testid="icon-sidebar">
        <div className="icon-sidebar-top">
          <button
            type="button"
            className="icon-sidebar-btn"
            title={t("expandSidebar")}
            onClick={openOrphanModal}
            data-testid="open-orphan-modal"
          >
            🧹
          </button>
          <button
            type="button"
            className="icon-sidebar-btn"
            title={t("viewPullRequests")}
            onClick={handleCopyPrompt}
            data-testid="copy-compat-prompt"
          >
            {copied ? "✅" : "📋"}
          </button>
        </div>
        <div className="icon-sidebar-bottom">
          <button
            type="button"
            className="icon-sidebar-btn"
            title={t("newSession")}
            onClick={() => navigate({ to: "/settings" })}
            data-testid="open-settings"
          >
            ⚙
          </button>
        </div>
      </div>
      <OrphanCleanModal open={orphanModalOpen} onClose={() => setOrphanModalOpen(false)} />
    </>
  );
}
