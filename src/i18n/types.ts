import type enCommon from "./locales/en/common.json";
import type enSettings from "./locales/en/settings.json";
import type enSidebar from "./locales/en/sidebar.json";
import type enSession from "./locales/en/session.json";
import type enConfigEditor from "./locales/en/config-editor.json";
import type enModals from "./locales/en/modals.json";
import type enTerminal from "./locales/en/terminal.json";
import type enTodo from "./locales/en/todo.json";
import type enHome from "./locales/en/home.json";
import type enErrorBoundary from "./locales/en/error-boundary.json";
import type enDaemon from "./locales/en/daemon.json";
import type enCompatPrompt from "./locales/en/compat-prompt.json";

export interface Translations {
  common: typeof enCommon;
  settings: typeof enSettings;
  sidebar: typeof enSidebar;
  session: typeof enSession;
  "config-editor": typeof enConfigEditor;
  modals: typeof enModals;
  terminal: typeof enTerminal;
  todo: typeof enTodo;
  home: typeof enHome;
  "error-boundary": typeof enErrorBoundary;
  daemon: typeof enDaemon;
  "compat-prompt": typeof enCompatPrompt;
}
