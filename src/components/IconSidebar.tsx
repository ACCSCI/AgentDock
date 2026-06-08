import { useState } from "react";
import { OrphanCleanModal } from "./OrphanCleanModal";

export function IconSidebar() {
  const [orphanModalOpen, setOrphanModalOpen] = useState(false);

  return (
    <>
      <div className="icon-sidebar">
        <button
          type="button"
          className="icon-sidebar-btn"
          title="清理孤儿目录"
          onClick={() => setOrphanModalOpen(true)}
        >
          🧹
        </button>
        <button
          type="button"
          className="icon-sidebar-btn"
          title="设置"
        >
          ⚙
        </button>
      </div>
      <OrphanCleanModal open={orphanModalOpen} onClose={() => setOrphanModalOpen(false)} />
    </>
  );
}
