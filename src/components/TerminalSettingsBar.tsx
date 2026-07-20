import { Minus, Plus } from "lucide-react";
import { useStore } from "../lib/store";
import { TERMINAL_FONT_SIZES, TERMINAL_FONT_FAMILIES } from "../lib/store";
import type { TerminalPreferences } from "../lib/store";
import { terminalCache } from "../lib/terminal-cache";
import { useTranslation } from "../i18n/react";
import { Button } from "./ui/button";

export function TerminalSettingsBar() {
  const { t } = useTranslation("terminal");
  const { terminalPrefs, setTerminalPrefs } = useStore();

  const update = (patch: Partial<TerminalPreferences>) => {
    const next = { ...terminalPrefs, ...patch };
    setTerminalPrefs(next);
    terminalCache.applyPrefs(next);
  };

  const cycleFontSize = (dir: 1 | -1) => {
    const idx = TERMINAL_FONT_SIZES.indexOf(terminalPrefs.fontSize);
    const next = idx + dir;
    if (next >= 0 && next < TERMINAL_FONT_SIZES.length) {
      update({ fontSize: TERMINAL_FONT_SIZES[next] });
    }
  };

  const handleFontFamilyChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    update({ fontFamily: e.target.value });
  };

  const atMin = terminalPrefs.fontSize <= TERMINAL_FONT_SIZES[0];
  const atMax = terminalPrefs.fontSize >= TERMINAL_FONT_SIZES[TERMINAL_FONT_SIZES.length - 1];

  return (
    <div className="flex h-9 shrink-0 items-center gap-4 border-b border-border bg-background px-2.5">
      <div className="flex items-center gap-1.5">
        <span className="text-xs text-muted-foreground">{t("fontSize")}</span>
        <Button
          type="button"
          variant="outline"
          size="icon-sm"
          onClick={() => cycleFontSize(-1)}
          disabled={atMin}
          title={t("decreaseFontSize")}
          aria-label={t("decreaseFontSize")}
        >
          <Minus aria-hidden="true" />
        </Button>
        <span className="min-w-6 text-center font-mono text-xs tabular-nums text-foreground">
          {terminalPrefs.fontSize}
        </span>
        <Button
          type="button"
          variant="outline"
          size="icon-sm"
          onClick={() => cycleFontSize(1)}
          disabled={atMax}
          title={t("increaseFontSize")}
          aria-label={t("increaseFontSize")}
        >
          <Plus aria-hidden="true" />
        </Button>
      </div>

      <div className="flex items-center gap-1.5">
        <span className="text-xs text-muted-foreground">Font</span>
        <select
          className="h-7 rounded-md border border-input bg-background px-2 text-xs text-foreground outline-none transition-colors focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/25"
          value={terminalPrefs.fontFamily}
          onChange={handleFontFamilyChange}
          aria-label="Terminal font family"
        >
          {TERMINAL_FONT_FAMILIES.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
