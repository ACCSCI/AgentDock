import { ChevronRight, Code2, Eye, FileCode2, Save, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Scalar, stringify as yamlStringify } from "yaml";
import { useTranslation } from "../i18n/react";
import { type ProjectConfigData, useProjectConfig, useSaveConfig } from "../lib/queries";
import { cn } from "../lib/utils";
import { FilePicker } from "./FilePicker";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

// Shared select appearance (matches TerminalSettingsBar.tsx)
const selectClassName =
  "h-7 rounded-md border border-input bg-background px-2 text-xs text-foreground outline-none transition-colors focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/25";

// Shared field label appearance
const fieldLabelClassName =
  "flex items-center gap-1 text-xs font-medium text-muted-foreground";

// Shared field help (?) dot
const fieldHelpClassName =
  "inline-flex size-4 cursor-help items-center justify-center rounded-full bg-secondary text-[0.625rem] font-bold text-muted-foreground";

// Shared checkbox wrapper
const checkboxWrapperClassName = "flex cursor-pointer flex-row items-center gap-1.5 text-xs font-normal text-foreground";

// Shared checkbox input
const checkboxInputClassName = "size-4 cursor-pointer accent-primary";

type Config = ProjectConfigData["config"];

interface ConfigEditorProps {
  projectId: string;
  projectPath: string;
}

export function ConfigEditor({ projectId }: ConfigEditorProps) {
  const { data, isLoading } = useProjectConfig(projectId);
  const saveMutation = useSaveConfig(projectId);
  const { t } = useTranslation("config-editor");

  const [config, setConfig] = useState<Config | null>(null);
  const [showYamlPreview, setShowYamlPreview] = useState(false);
  const [saveStatus, setSaveStatus] = useState<"idle" | "success" | "error">("idle");
  const [saveError, setSaveError] = useState("");
  const [expandedSections, setExpandedSections] = useState({
    resources: true,
    hooks: true,
    ports: false,
  });
  const [activeHookTab, setActiveHookTab] = useState("afterCreateSession");
  const [filePickerOpen, setFilePickerOpen] = useState(false);
  const [filePickerTarget, setFilePickerTarget] = useState<number | null>(null);
  const [newPortKey, setNewPortKey] = useState("");

  // Field help descriptions
  const help = useMemo(
    () => ({
      source: t("help.source"),
      strategy: t("help.strategy"),
      skipIfMissing: t("help.skipIfMissing"),
      run: t("help.run"),
      required: t("help.required"),
      timeout: t("help.timeout"),
      cwd: t("help.cwd"),
      async: t("help.async"),
    }),
    [t],
  );

  const lifecycleEvents = useMemo(
    () => [
      {
        key: "beforeCreateSession",
        label: t("lifecycle.beforeCreateSession"),
        desc: t("lifecycle.beforeCreateSessionDesc"),
      },
      {
        key: "afterCreateSession",
        label: t("lifecycle.afterCreateSession"),
        desc: t("lifecycle.afterCreateSessionDesc"),
      },
      {
        key: "beforeDeleteSession",
        label: t("lifecycle.beforeDeleteSession"),
        desc: t("lifecycle.beforeDeleteSessionDesc"),
      },
      {
        key: "afterDeleteSession",
        label: t("lifecycle.afterDeleteSession"),
        desc: t("lifecycle.afterDeleteSessionDesc"),
      },
    ],
    [t],
  );

  // Reset config when projectId changes
  useEffect(() => {
    setConfig(null);
  }, [projectId]);

  // Initialize config from fetched data (only when config is null)
  useEffect(() => {
    if (data?.config && config === null) {
      setConfig(data.config);
    }
  }, [data, config]);

  const updateConfig = useCallback((updater: (prev: Config) => Config) => {
    setConfig((prev) => (prev ? updater(prev) : prev));
  }, []);

  // Real-time YAML preview — force double quotes on all run fields
  const yamlPreview = useMemo(() => {
    if (!config) return "";
    // Deep clone and wrap run values in Scalar with double-quote type
    const quoted = JSON.parse(JSON.stringify(config));
    if (quoted.hooks) {
      for (const event of Object.keys(quoted.hooks)) {
        quoted.hooks[event] = quoted.hooks[event].map((h: { run: string }) => {
          const s = new Scalar(h.run);
          s.type = Scalar.QUOTE_DOUBLE;
          return { ...h, run: s };
        });
      }
    }
    return yamlStringify(quoted, { indent: 2 });
  }, [config]);

  // --- Resource sync handlers ---
  const addResource = useCallback(() => {
    updateConfig((prev) => ({
      ...prev,
      resources: {
        sync: [...prev.resources.sync, { source: "", strategy: "overwrite", skipIfMissing: true }],
      },
    }));
  }, [updateConfig]);

  const removeResource = useCallback(
    (index: number) => {
      updateConfig((prev) => ({
        ...prev,
        resources: { sync: prev.resources.sync.filter((_, i) => i !== index) },
      }));
    },
    [updateConfig],
  );

  const updateResource = useCallback(
    (index: number, field: string, value: unknown) => {
      updateConfig((prev) => ({
        ...prev,
        resources: {
          sync: prev.resources.sync.map((r, i) => (i === index ? { ...r, [field]: value } : r)),
        },
      }));
    },
    [updateConfig],
  );

  const handleFileSelect = useCallback(
    (filePath: string) => {
      if (filePickerTarget !== null) {
        updateResource(filePickerTarget, "source", filePath);
      }
      setFilePickerOpen(false);
      setFilePickerTarget(null);
    },
    [filePickerTarget, updateResource],
  );

  // --- Hook handlers ---
  const addHook = useCallback(
    (event: string) => {
      updateConfig((prev) => ({
        ...prev,
        hooks: {
          ...prev.hooks,
          [event]: [
            ...(prev.hooks[event] || []),
            { run: "", required: false, timeout: 30000, cwd: "worktree", async: false },
          ],
        },
      }));
    },
    [updateConfig],
  );

  const removeHook = useCallback(
    (event: string, index: number) => {
      updateConfig((prev) => ({
        ...prev,
        hooks: {
          ...prev.hooks,
          [event]: (prev.hooks[event] || []).filter((_, i) => i !== index),
        },
      }));
    },
    [updateConfig],
  );

  const updateHook = useCallback(
    (event: string, index: number, field: string, value: unknown) => {
      updateConfig((prev) => ({
        ...prev,
        hooks: {
          ...prev.hooks,
          [event]: (prev.hooks[event] || []).map((h, i) =>
            i === index ? { ...h, [field]: value } : h,
          ),
        },
      }));
    },
    [updateConfig],
  );

  // --- Port key handlers ---
  const addPortKey = useCallback(
    (key: string) => {
      const trimmed = key.trim().toUpperCase();
      if (!trimmed || !/^[A-Z][A-Z0-9_]*$/.test(trimmed)) return;
      updateConfig((prev) => {
        const current = prev.env?.ports ?? [];
        if (current.includes(trimmed)) return prev;
        return {
          ...prev,
          env: {
            ...prev.env,
            ports: [...current, trimmed],
          },
        };
      });
      setNewPortKey("");
    },
    [updateConfig],
  );

  const removePortKey = useCallback(
    (index: number) => {
      updateConfig((prev) => {
        const current = prev.env?.ports ?? [];
        return {
          ...prev,
          env: {
            ...prev.env,
            ports: current.filter((_, i) => i !== index),
          },
        };
      });
    },
    [updateConfig],
  );

  const handlePortKeyInputKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        addPortKey(newPortKey);
      }
    },
    [addPortKey, newPortKey],
  );

  // --- Actions ---
  const handlePreview = useCallback(() => {
    setShowYamlPreview((prev) => !prev);
  }, []);

  const handleSave = useCallback(async () => {
    if (!config) return;
    setSaveStatus("idle");
    setSaveError("");
    // Normalize: strip empty ports so Zod default kicks in (avoid min(1) rejection)
    const saveConfig = { ...config };
    if (!saveConfig.env?.ports?.length) {
      delete saveConfig.env;
    }
    try {
      await saveMutation.mutateAsync(saveConfig);
      setSaveStatus("success");
      setTimeout(() => setSaveStatus("idle"), 3000);
    } catch (err) {
      setSaveStatus("error");
      setSaveError(err instanceof Error ? err.message : t("saveFailed"));
    }
  }, [config, saveMutation]);

  if (isLoading || !config) {
    return (
      <div className="box-border h-full overflow-y-auto p-6">
        <div className="flex h-[200px] items-center justify-center text-sm text-muted-foreground">
          {t("loadingConfig")}
        </div>
      </div>
    );
  }

  return (
    <main className="config-editor box-border h-full overflow-y-auto bg-background px-[clamp(20px,4vw,48px)] pb-24 pt-7 text-foreground">
      <div className="mx-auto mb-[22px] flex w-[min(100%,960px)] items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="flex size-10 items-center justify-center rounded-lg border border-border bg-card text-primary">
            <Code2 aria-hidden="true" className="size-5" />
          </span>
          <div>
            <div className="font-mono text-[0.625rem] uppercase tracking-[0.16em] text-muted-foreground">
              Project manifest
            </div>
            <h1 className="mt-0.5 text-xl font-semibold tracking-[-0.025em]">{t("projectConfig")}</h1>
          </div>
        </div>
        <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-[9px] py-[5px] font-mono text-[0.6875rem] text-muted-foreground">
          <FileCode2 aria-hidden="true" className="size-3.5" />
          {data?.exists ? "agentdock.config.yaml" : t("configFileNotFound")}
        </span>
      </div>

      {/* Section: Resource Sync */}
      <div className="mx-auto mb-3 w-[min(100%,960px)] overflow-hidden rounded-[calc(var(--radius)+2px)] border border-border bg-card shadow-sm">
        <button
          type="button"
          className="flex min-h-[50px] w-full cursor-pointer items-center gap-2 px-4 py-[13px] text-sm text-foreground transition-colors hover:bg-accent"
          onClick={() => setExpandedSections((s) => ({ ...s, resources: !s.resources }))}
        >
          <ChevronRight
            aria-hidden="true"
            className={cn(
              "size-3.5 text-muted-foreground transition-transform duration-200",
              expandedSections.resources && "rotate-90",
            )}
          />
          <h3 className="text-[0.9375rem] font-semibold">{t("resourceSync")}</h3>
          <span className="ml-auto rounded-[10px] bg-secondary px-2 py-0.5 text-xs text-foreground">
            {t("itemsCount", { count: config.resources.sync.length })}
          </span>
        </button>
        <p className="border-t border-border px-4 py-2.5 text-[0.8125rem] leading-relaxed text-muted-foreground">
          {t("resourceSyncDesc")}
        </p>

        {expandedSections.resources && (
          <div className="flex flex-col gap-3 border-t border-border p-3.5">
            {config.resources.sync.map((res, i) => (
              <div key={i} className="rounded-md border border-border bg-background p-3">
                <div className="flex items-end gap-2">
                  <div className="flex flex-1 flex-col gap-1">
                    <label htmlFor={`resource-source-${i}`} className={fieldLabelClassName}>
                      source
                      <span className={fieldHelpClassName} title={help.source}>
                        ?
                      </span>
                    </label>
                    <div className="flex gap-1">
                      <Input
                        id={`resource-source-${i}`}
                        type="text"
                        value={res.source}
                        placeholder=".env"
                        className="h-8 flex-1 font-mono text-[0.8125rem]"
                        onChange={(e) => updateResource(i, "source", e.target.value)}
                      />
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-8 whitespace-nowrap"
                        onClick={() => {
                          setFilePickerTarget(i);
                          setFilePickerOpen(true);
                        }}
                      >
                        {t("browse")}
                      </Button>
                    </div>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className="shrink-0 text-muted-foreground hover:bg-destructive-bg hover:text-destructive"
                    onClick={() => removeResource(i)}
                  >
                    <X aria-hidden="true" className="size-4" />
                  </Button>
                </div>
                <div className="mt-2.5 flex flex-wrap gap-3">
                  <div className="flex flex-col gap-1">
                    <label className={fieldLabelClassName}>
                      strategy
                      <span className={fieldHelpClassName} title={help.strategy}>
                        ?
                      </span>
                    </label>
                    <select
                      className={selectClassName}
                      value={res.strategy}
                      onChange={(e) => updateResource(i, "strategy", e.target.value)}
                    >
                      <option value="overwrite">{t("strategyOverwrite")}</option>
                      <option value="skip">{t("strategySkip")}</option>
                      <option value="merge">{t("strategyMerge")}</option>
                    </select>
                  </div>
                  <div className="flex flex-col gap-1">
                    <label className={fieldLabelClassName}>
                      skipIfMissing
                      <span className={fieldHelpClassName} title={help.skipIfMissing}>
                        ?
                      </span>
                    </label>
                    <label className={checkboxWrapperClassName}>
                      <input
                        type="checkbox"
                        className={checkboxInputClassName}
                        checked={res.skipIfMissing}
                        onChange={(e) => updateResource(i, "skipIfMissing", e.target.checked)}
                      />
                      <span>{t("skipIfMissingLabel")}</span>
                    </label>
                  </div>
                </div>
              </div>
            ))}
            <Button
              type="button"
              variant="outline"
              className="h-9 w-full border-dashed text-muted-foreground hover:text-foreground"
              onClick={addResource}
            >
              {t("addResource")}
            </Button>
          </div>
        )}
      </div>

      {/* Section: Hooks */}
      <div className="mx-auto mb-3 w-[min(100%,960px)] overflow-hidden rounded-[calc(var(--radius)+2px)] border border-border bg-card shadow-sm">
        <button
          type="button"
          className="flex min-h-[50px] w-full cursor-pointer items-center gap-2 px-4 py-[13px] text-sm text-foreground transition-colors hover:bg-accent"
          onClick={() => setExpandedSections((s) => ({ ...s, hooks: !s.hooks }))}
        >
          <ChevronRight
            aria-hidden="true"
            className={cn(
              "size-3.5 text-muted-foreground transition-transform duration-200",
              expandedSections.hooks && "rotate-90",
            )}
          />
          <h3 className="text-[0.9375rem] font-semibold">{t("hooks")}</h3>
        </button>
        <p className="border-t border-border px-4 py-2.5 text-[0.8125rem] leading-relaxed text-muted-foreground">
          {t("hooksDesc")}
        </p>

        {expandedSections.hooks && (
          <div className="flex flex-col gap-3 border-t border-border p-3.5">
            {/* Hook event tabs */}
            <div className="mb-3 flex gap-0.5 border-b border-border">
              {lifecycleEvents.map((evt) => (
                <button
                  key={evt.key}
                  type="button"
                  className={cn(
                    "flex cursor-pointer items-center gap-1.5 border-b-2 border-transparent bg-none px-3.5 py-2 text-[0.8125rem] text-muted-foreground transition-colors hover:text-foreground",
                    activeHookTab === evt.key && "border-primary text-primary",
                  )}
                  onClick={() => setActiveHookTab(evt.key)}
                >
                  {evt.label}
                  <span
                    className={cn(
                      "min-w-4 rounded-lg bg-secondary px-1.5 py-px text-center text-[0.6875rem]",
                      activeHookTab === evt.key && "bg-primary text-primary-foreground",
                    )}
                  >
                    {(config.hooks[evt.key] || []).length}
                  </span>
                </button>
              ))}
            </div>

            {/* Active hook event description */}
            <p className="mb-3 text-[0.8125rem] text-muted-foreground">
              {lifecycleEvents.find((e) => e.key === activeHookTab)?.desc}
            </p>

            {/* Hook entries */}
            {(config.hooks[activeHookTab] || []).map((hook, i) => (
              <div key={i} className="rounded-md border border-border bg-background p-3">
                <div className="flex items-end gap-2">
                  <div className="flex flex-1 flex-col gap-1">
                    <label className={fieldLabelClassName}>
                      run
                      <span className={fieldHelpClassName} title={help.run}>
                        ?
                      </span>
                    </label>
                    <Input
                      type="text"
                      value={hook.run}
                      placeholder="bun install"
                      className="h-8 font-mono text-[0.8125rem]"
                      onChange={(e) => updateHook(activeHookTab, i, "run", e.target.value)}
                    />
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className="shrink-0 text-muted-foreground hover:bg-destructive-bg hover:text-destructive"
                    onClick={() => removeHook(activeHookTab, i)}
                  >
                    <X aria-hidden="true" className="size-4" />
                  </Button>
                </div>
                <div className="mt-2.5 flex flex-wrap items-end gap-x-4 gap-y-3">
                  {!hook.async && (
                    <div className="flex flex-col gap-1.5">
                      <label className={fieldLabelClassName}>
                        required
                        <span className={fieldHelpClassName} title={help.required}>
                          ?
                        </span>
                      </label>
                      <label className={checkboxWrapperClassName}>
                        <input
                          type="checkbox"
                          className={checkboxInputClassName}
                          checked={hook.required}
                          onChange={(e) => {
                            updateHook(activeHookTab, i, "required", e.target.checked);
                            if (e.target.checked && hook.async) {
                              updateHook(activeHookTab, i, "async", false);
                            }
                          }}
                        />
                        <span>{t("failAbort")}</span>
                      </label>
                    </div>
                  )}
                  <div className="flex flex-col gap-1.5">
                    <label className={fieldLabelClassName}>
                      timeout (ms)
                      <span className={fieldHelpClassName} title={help.timeout}>
                        ?
                      </span>
                    </label>
                    <Input
                      type="number"
                      value={hook.timeout}
                      min={1000}
                      step={1000}
                      className="h-8 w-28 font-mono text-[0.8125rem]"
                      onChange={(e) =>
                        updateHook(activeHookTab, i, "timeout", Number(e.target.value))
                      }
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <label className={fieldLabelClassName}>
                      cwd
                      <span className={fieldHelpClassName} title={help.cwd}>
                        ?
                      </span>
                    </label>
                    <select
                      className={selectClassName}
                      value={hook.cwd}
                      onChange={(e) => updateHook(activeHookTab, i, "cwd", e.target.value)}
                    >
                      <option value="worktree">worktree</option>
                      <option value="project">project</option>
                    </select>
                  </div>
                  <div className="flex min-w-44 flex-col gap-1.5">
                    <label className={fieldLabelClassName}>
                      {t("executionMode")}
                      <span className={fieldHelpClassName} title={help.async}>
                        ?
                      </span>
                    </label>
                    {/* Segmented control — equal-height, padded segments so the
                        selected (filled) state doesn't crowd the label. */}
                    <div className="flex h-8 items-stretch overflow-hidden rounded-md border border-border bg-secondary p-0.5">
                      <button
                        type="button"
                        className={cn(
                          "flex-1 cursor-pointer rounded-[5px] border-0 bg-transparent px-3 text-xs text-muted-foreground transition-colors hover:text-foreground",
                          !hook.async && "bg-primary font-medium text-primary-foreground shadow-sm hover:text-primary-foreground",
                        )}
                        onClick={() => {
                          if (hook.async) {
                            updateHook(activeHookTab, i, "async", false);
                          }
                        }}
                      >
                        {t("syncExecution")}
                      </button>
                      <button
                        type="button"
                        className={cn(
                          "flex-1 cursor-pointer rounded-[5px] border-0 bg-transparent px-3 text-xs text-muted-foreground transition-colors hover:text-foreground",
                          hook.async && "bg-primary font-medium text-primary-foreground shadow-sm hover:text-primary-foreground",
                        )}
                        onClick={() => {
                          if (!hook.async) {
                            updateHook(activeHookTab, i, "async", true);
                            // async 和 required 互斥 — 切换到异步时自动去掉 required
                            if (hook.required) {
                              updateHook(activeHookTab, i, "required", false);
                            }
                          }
                        }}
                      >
                        {t("asyncExecution")}
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            ))}
            <Button
              type="button"
              variant="outline"
              className="h-9 w-full border-dashed text-muted-foreground hover:text-foreground"
              onClick={() => addHook(activeHookTab)}
            >
              {t("addHook")}
            </Button>
          </div>
        )}
      </div>

      {/* Section: Ports */}
      <div className="mx-auto mb-3 w-[min(100%,960px)] overflow-hidden rounded-[calc(var(--radius)+2px)] border border-border bg-card shadow-sm">
        <button
          type="button"
          className="flex min-h-[50px] w-full cursor-pointer items-center gap-2 px-4 py-[13px] text-sm text-foreground transition-colors hover:bg-accent"
          onClick={() => setExpandedSections((s) => ({ ...s, ports: !s.ports }))}
        >
          <ChevronRight
            aria-hidden="true"
            className={cn(
              "size-3.5 text-muted-foreground transition-transform duration-200",
              expandedSections.ports && "rotate-90",
            )}
          />
          <h3 className="text-[0.9375rem] font-semibold">{t("portAllocation")}</h3>
          <span className="ml-auto rounded-[10px] bg-secondary px-2 py-0.5 text-xs text-foreground">
            {config.env?.ports && config.env.ports.length > 0
              ? t("portCount", { count: config.env.ports.length })
              : t("defaultPortCount")}
          </span>
        </button>
        <p className="border-t border-border px-4 py-2.5 text-[0.8125rem] leading-relaxed text-muted-foreground">
          {t("portAllocationDesc")}
          {t("portAllocationFallback")}
        </p>

        {expandedSections.ports && (
          <div className="flex flex-col gap-3 border-t border-border p-3.5">
            {/* Port key tags */}
            <div className="mb-3 flex min-h-8 flex-wrap gap-2">
              {(config.env?.ports ?? []).map((key, i) => (
                <div
                  key={i}
                  className="inline-flex items-center gap-1 rounded-md border border-border bg-secondary px-2 py-1 font-mono text-[0.8125rem] text-foreground"
                >
                  <span className="text-primary">{key}</span>
                  <button
                    type="button"
                    className="cursor-pointer px-0.5 text-sm leading-none text-muted-foreground transition-colors hover:text-destructive"
                    onClick={() => removePortKey(i)}
                  >
                    ×
                  </button>
                </div>
              ))}
              {!config.env?.ports?.length && (
                <div className="py-2 text-[0.8125rem] italic text-muted-foreground">
                  {t("noPortsConfigured")}
                </div>
              )}
            </div>

            {/* Add port key input */}
            <div className="mb-3 flex gap-2">
              <Input
                type="text"
                value={newPortKey}
                placeholder={t("portKeyPlaceholder")}
                onChange={(e) => setNewPortKey(e.target.value)}
                onKeyDown={handlePortKeyInputKeyDown}
                className="h-8 flex-1 font-mono text-[0.8125rem]"
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8"
                onClick={() => addPortKey(newPortKey)}
                disabled={!newPortKey.trim() || !/^[A-Z][A-Z0-9_]*$/i.test(newPortKey.trim())}
              >
                {t("add")}
              </Button>
            </div>

            {/* .env hints */}
            {data?.envPorts && data.envPorts.length > 0 && (
              <div className="mt-2 rounded-md border border-dashed border-border bg-secondary px-3 py-2.5">
                <span className="mb-1.5 block text-xs text-muted-foreground">
                  {t("currentEnvPorts")}
                </span>
                <div className="flex flex-wrap gap-1.5">
                  {data.envPorts.map((key) => {
                    const alreadyAdded = (config.env?.ports ?? []).includes(key);
                    return (
                      <span
                        key={key}
                        className={cn(
                          "inline-flex items-center gap-1 rounded border border-border bg-background px-2 py-0.5 font-mono text-xs text-muted-foreground",
                          alreadyAdded && "border-primary text-primary opacity-60",
                        )}
                      >
                        {key}
                        {!alreadyAdded && (
                          <button
                            type="button"
                            className="cursor-pointer px-0.5 text-xs leading-none text-success transition-colors hover:text-success/80"
                            onClick={() => addPortKey(key)}
                            title={t("addToConfig")}
                          >
                            {t("add")}
                          </button>
                        )}
                      </span>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* YAML Preview */}
      {showYamlPreview && (
        <div className="mx-auto mb-6 w-[min(100%,960px)] overflow-hidden rounded-[calc(var(--radius)+2px)] border border-border">
          <div className="flex items-center justify-between bg-secondary px-4 py-2.5">
            <h3 className="text-sm font-semibold">{t("yamlPreview")}</h3>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7"
              onClick={() => setShowYamlPreview(false)}
            >
              {t("close")}
            </Button>
          </div>
          <pre className="overflow-x-auto bg-background p-4 font-mono text-[0.8125rem] leading-normal text-foreground">
            <code>{yamlPreview}</code>
          </pre>
        </div>
      )}

      {/* Action bar */}
      <div className="mx-auto mt-5 flex w-[min(100%,960px)] items-center justify-between rounded-[calc(var(--radius)+2px)] border border-border bg-card p-2.5">
        <Button type="button" variant="outline" onClick={handlePreview}>
          <Eye aria-hidden="true" />
          {t("previewYaml")}
        </Button>
        <div className="flex items-center gap-3">
          {saveStatus === "success" && (
            <span className="text-[0.8125rem] text-success">✓ {t("saved")}</span>
          )}
          {saveStatus === "error" && (
            <span className="text-[0.8125rem] text-destructive">✗ {saveError}</span>
          )}
          <Button type="button" onClick={handleSave} disabled={saveMutation.isPending}>
            <Save aria-hidden="true" />
            {saveMutation.isPending
              ? t("saving")
              : data?.exists
                ? t("saveConfig")
                : t("generateConfigFile")}
          </Button>
        </div>
      </div>

      {/* File Picker */}
      <FilePicker
        open={filePickerOpen}
        projectId={projectId}
        onConfirm={handleFileSelect}
        onCancel={() => {
          setFilePickerOpen(false);
          setFilePickerTarget(null);
        }}
      />
    </main>
  );
}
