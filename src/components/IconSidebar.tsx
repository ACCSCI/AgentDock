import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { OrphanCleanModal } from "./OrphanCleanModal";

export function IconSidebar() {
  const [orphanModalOpen, setOrphanModalOpen] = useState(false);
  const queryClient = useQueryClient();

  const openOrphanModal = () => {
    // Force a fresh scan on every open click: the modal query is disabled
    // when closed, but the cached data is otherwise served stale-on-mount
    // for an instant. Invalidating here guarantees the user always sees
    // the latest disk state with an explicit loading indicator.
    queryClient.invalidateQueries({ queryKey: ["orphans"] });
    setOrphanModalOpen(true);
  };

  return (
    <>
      <div className="icon-sidebar" data-testid="icon-sidebar">
        <div className="icon-sidebar-top">
          <button
            type="button"
            className="icon-sidebar-btn"
            title="清理孤儿目录"
            onClick={openOrphanModal}
            data-testid="open-orphan-modal"
          >
            🧹
          </button>
        </div>
        <div className="icon-sidebar-bottom">
          <button
            type="button"
            className="icon-sidebar-btn"
            title="设置"
          >
            ⚙
          </button>
        </div>
      </div>
      <OrphanCleanModal open={orphanModalOpen} onClose={() => setOrphanModalOpen(false)} />
    </>
  );
}
