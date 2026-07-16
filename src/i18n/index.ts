import i18n from "i18next";
import { initReactI18next } from "react-i18next";

// 默认语言的翻译文件 —— 同步 import,确保启动即可用
import enCommon from "./locales/en/common.json";
import enCompatPrompt from "./locales/en/compat-prompt.json";
import enConfigEditor from "./locales/en/config-editor.json";
import enDaemon from "./locales/en/daemon.json";
import enErrorBoundary from "./locales/en/error-boundary.json";
import enHome from "./locales/en/home.json";
import enModals from "./locales/en/modals.json";
import enSession from "./locales/en/session.json";
import enSettings from "./locales/en/settings.json";
import enSidebar from "./locales/en/sidebar.json";
import enTerminal from "./locales/en/terminal.json";
import enTodo from "./locales/en/todo.json";

// 同步加载英文翻译 (默认语言,启动必须)
const enResources = {
  common: enCommon,
  settings: enSettings,
  sidebar: enSidebar,
  session: enSession,
  "config-editor": enConfigEditor,
  modals: enModals,
  terminal: enTerminal,
  todo: enTodo,
  home: enHome,
  "error-boundary": enErrorBoundary,
  daemon: enDaemon,
  "compat-prompt": enCompatPrompt,
};

// 中文翻译按需懒加载
const zhNamespaceModules: Record<string, () => Promise<{ default: Record<string, unknown> }>> = {
  common: () => import("./locales/zh/common.json"),
  settings: () => import("./locales/zh/settings.json"),
  sidebar: () => import("./locales/zh/sidebar.json"),
  session: () => import("./locales/zh/session.json"),
  "config-editor": () => import("./locales/zh/config-editor.json"),
  modals: () => import("./locales/zh/modals.json"),
  terminal: () => import("./locales/zh/terminal.json"),
  todo: () => import("./locales/zh/todo.json"),
  home: () => import("./locales/zh/home.json"),
  "error-boundary": () => import("./locales/zh/error-boundary.json"),
  daemon: () => import("./locales/zh/daemon.json"),
  "compat-prompt": () => import("./locales/zh/compat-prompt.json"),
};

const LANG_KEY = "agentdock_language";

function getSavedLanguage(): string {
  try {
    const raw = localStorage.getItem(LANG_KEY);
    if (raw === "zh" || raw === "en") return raw;
  } catch {
    /* localStorage unavailable */
  }
  return "en";
}

export type SupportedLanguage = "en" | "zh";
export const SUPPORTED_LANGUAGES: Array<{ value: SupportedLanguage; label: string }> = [
  { value: "en", label: "English" },
  { value: "zh", label: "中文" },
];

i18n.use(initReactI18next).init({
  resources: {
    en: enResources,
  },
  lng: getSavedLanguage(),
  fallbackLng: "en",
  ns: [
    "common",
    "settings",
    "sidebar",
    "session",
    "config-editor",
    "modals",
    "terminal",
    "todo",
    "home",
    "error-boundary",
    "daemon",
    "compat-prompt",
  ],
  defaultNS: "common",
  interpolation: {
    escapeValue: false, // React 已经处理 XSS
  },
  saveMissing: false,
  react: {
    useSuspense: false, // Electron 环境下 Suspense 边界复杂度高,关闭
  },
});

// 初始化加载保存的非默认语言(英文同步加载,其他语言需异步)
const initialLang = getSavedLanguage();
if (initialLang !== "en") {
  loadLanguage(initialLang as SupportedLanguage).catch((err) => {
    console.error("Failed to load initial language:", err);
  });
}

/**
 * 异步加载指定语言的所有 namespace 翻译文件。
 * 调用 i18n.addResourceBundle 逐个注入。
 * 跳过已加载的 namespace,容错处理单文件加载失败。
 */
export async function loadLanguage(lang: SupportedLanguage): Promise<void> {
  if (lang === "en") {
    // 英文已在初始化时同步加载
    await i18n.changeLanguage("en");
    return;
  }

  const entries = Object.entries(zhNamespaceModules);
  await Promise.all(
    entries.map(async ([ns, loadFn]) => {
      if (i18n.hasResourceBundle(lang, ns)) {
        return;
      }
      try {
        const mod = await loadFn();
        i18n.addResourceBundle(lang, ns, mod.default, true, true);
      } catch (err) {
        console.error(`Failed to load namespace ${ns} for ${lang}:`, err);
      }
    }),
  );

  await i18n.changeLanguage(lang);
}

/**
 * 切换语言并持久化到 localStorage。
 */
export async function setLanguage(lang: SupportedLanguage): Promise<void> {
  await loadLanguage(lang);
  try {
    localStorage.setItem(LANG_KEY, lang);
  } catch {
    /* ignore */
  }
}

export default i18n;
