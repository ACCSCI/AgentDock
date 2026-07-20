import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Check, Clipboard, Settings, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { AGENTDOCK_COMPAT_PROMPT } from "../constants/agentdock-compat-prompt";
import { useTranslation } from "../i18n/react";
import { OrphanCleanModal } from "./OrphanCleanModal";
import { Button } from "./ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

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
      <aside
        className="flex w-12 shrink-0 flex-col items-center border-r border-border bg-secondary py-2"
        aria-label="应用工具"
        data-testid="icon-sidebar"
      >
        <div className="flex flex-1 flex-col items-center gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={t("cleanOrphans")}
                onClick={openOrphanModal}
                data-testid="open-orphan-modal"
              >
                <Sparkles aria-hidden="true" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="right">{t("cleanOrphans")}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={t("copyCompatPrompt")}
                onClick={handleCopyPrompt}
                data-testid="copy-compat-prompt"
              >
                {copied ? (
                  <Check aria-hidden="true" className="text-success" />
                ) : (
                  <Clipboard aria-hidden="true" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="right">
              {copied ? "已复制" : t("copyCompatPrompt")}
            </TooltipContent>
          </Tooltip>
        </div>
        <div className="mt-auto flex flex-col items-center gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={t("settings")}
                onClick={() => navigate({ to: "/settings" })}
                data-testid="open-settings"
              >
                <Settings aria-hidden="true" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="right">{t("settings")}</TooltipContent>
          </Tooltip>
        </div>
      </aside>
      <OrphanCleanModal open={orphanModalOpen} onClose={() => setOrphanModalOpen(false)} />
    </>
  );
}
