import { useState } from "react";
import { OrphanCleanModal } from "./OrphanCleanModal";

export function IconSidebar() {
  const [orphanModalOpen, setOrphanModalOpen] = useState(false);

  return (
    <>
      <div className="icon-sidebar" data-testid="icon-sidebar">
        <div className="icon-sidebar-top">
          <button
            type="button"
            className="icon-sidebar-btn"
            title="清理孤儿目录"
            onClick={() => setOrphanModalOpen(true)}
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
