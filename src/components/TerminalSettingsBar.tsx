import { useTranslation } from "../i18n/react";
import { useStore } from "../lib/store";
import { TERMINAL_FONT_FAMILIES, TERMINAL_FONT_SIZES } from "../lib/store";
import type { TerminalPreferences } from "../lib/store";
import { terminalCache } from "../lib/terminal-cache";

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

  return (
    <div className="terminal-settings-bar">
      <div className="terminal-settings-group">
        <span className="terminal-settings-label">{t("fontSize")}</span>
        <button
          type="button"
          className="terminal-settings-stepper"
          onClick={() => cycleFontSize(-1)}
          disabled={terminalPrefs.fontSize <= TERMINAL_FONT_SIZES[0]}
          title={t("decreaseFontSize")}
        >
          −
        </button>
        <span className="terminal-settings-value">{terminalPrefs.fontSize}</span>
        <button
          type="button"
          className="terminal-settings-stepper"
          onClick={() => cycleFontSize(1)}
          disabled={terminalPrefs.fontSize >= TERMINAL_FONT_SIZES[TERMINAL_FONT_SIZES.length - 1]}
          title={t("increaseFontSize")}
        >
          +
        </button>
      </div>

      <div className="terminal-settings-group">
        <label className="terminal-settings-label" htmlFor="terminal-font-family">
          Font
        </label>
        <select
          id="terminal-font-family"
          className="terminal-settings-select"
          value={terminalPrefs.fontFamily}
          onChange={handleFontFamilyChange}
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
