import { useCallback, useEffect, useMemo, useState } from "react";
import { Scalar, stringify as yamlStringify } from "yaml";
import { useTranslation } from "../i18n/react";
import { type ProjectConfigData, useProjectConfig, useSaveConfig } from "../lib/queries";
import { FilePicker } from "./FilePicker";

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
  // biome-ignore lint/correctness/useExhaustiveDependencies: projectId changes intentionally reset local editor state.
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
      saveConfig.env = undefined;
    }
    try {
      await saveMutation.mutateAsync(saveConfig);
      setSaveStatus("success");
      setTimeout(() => setSaveStatus("idle"), 3000);
    } catch (err) {
      setSaveStatus("error");
      setSaveError(err instanceof Error ? err.message : t("saveFailed"));
    }
  }, [config, saveMutation, t]);

  if (isLoading || !config) {
    return (
      <div className="config-editor">
        <div className="config-loading">{t("loadingConfig")}</div>
      </div>
    );
  }

  return (
    <div className="config-editor">
      <div className="config-editor-header">
        <h2>{t("projectConfig")}</h2>
        <span className="config-file-status">
          {data?.exists ? "📄 agentdock.config.yaml" : t("configFileNotFound")}
        </span>
      </div>

      {/* Section: Resource Sync */}
      <div className="config-section">
        <button
          type="button"
          className="config-section-header"
          onClick={() => setExpandedSections((s) => ({ ...s, resources: !s.resources }))}
        >
          <span className={`config-section-arrow ${expandedSections.resources ? "expanded" : ""}`}>
            ▶
          </span>
          <h3>{t("resourceSync")}</h3>
          <span className="config-section-count">
            {t("itemsCount", { count: config.resources.sync.length })}
          </span>
        </button>
        <p className="config-section-desc">{t("resourceSyncDesc")}</p>

        {expandedSections.resources && (
          <div className="config-section-body">
            {config.resources.sync.map((res, i) => (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: config entries are edited and removed by their positional index and have no persisted identity.
                key={i}
                className="config-entry"
              >
                <div className="config-entry-row">
                  <div className="config-field config-field-source">
                    <label htmlFor={`resource-source-${i}`}>
                      source
                      <span className="config-field-help" title={help.source}>
                        ?
                      </span>
                    </label>
                    <div className="config-field-input-group">
                      <input
                        id={`resource-source-${i}`}
                        type="text"
                        value={res.source}
                        placeholder=".env"
                        onChange={(e) => updateResource(i, "source", e.target.value)}
                      />
                      <button
                        type="button"
                        className="config-btn-browse"
                        onClick={() => {
                          setFilePickerTarget(i);
                          setFilePickerOpen(true);
                        }}
                      >
                        {t("browse")}
                      </button>
                    </div>
                  </div>
                  <button
                    type="button"
                    className="config-btn-delete"
                    onClick={() => removeResource(i)}
                  >
                    ×
                  </button>
                </div>
                <div className="config-entry-row config-entry-row-fields">
                  <div className="config-field">
                    <label htmlFor={`resource-strategy-${i}`}>
                      strategy
                      <span className="config-field-help" title={help.strategy}>
                        ?
                      </span>
                    </label>
                    <select
                      id={`resource-strategy-${i}`}
                      value={res.strategy}
                      onChange={(e) => updateResource(i, "strategy", e.target.value)}
                    >
                      <option value="overwrite">{t("strategyOverwrite")}</option>
                      <option value="skip">{t("strategySkip")}</option>
                      <option value="merge">{t("strategyMerge")}</option>
                    </select>
                  </div>
                  <div className="config-field">
                    <span className="config-field-label">
                      skipIfMissing
                      <span className="config-field-help" title={help.skipIfMissing}>
                        ?
                      </span>
                    </span>
                    <label className="config-checkbox">
                      <input
                        type="checkbox"
                        checked={res.skipIfMissing}
                        onChange={(e) => updateResource(i, "skipIfMissing", e.target.checked)}
                      />
                      <span>{t("skipIfMissingLabel")}</span>
                    </label>
                  </div>
                </div>
              </div>
            ))}
            <button type="button" className="config-btn-add" onClick={addResource}>
              {t("addResource")}
            </button>
          </div>
        )}
      </div>

      {/* Section: Hooks */}
      <div className="config-section">
        <button
          type="button"
          className="config-section-header"
          onClick={() => setExpandedSections((s) => ({ ...s, hooks: !s.hooks }))}
        >
          <span className={`config-section-arrow ${expandedSections.hooks ? "expanded" : ""}`}>
            ▶
          </span>
          <h3>{t("hooks")}</h3>
        </button>
        <p className="config-section-desc">{t("hooksDesc")}</p>

        {expandedSections.hooks && (
          <div className="config-section-body">
            {/* Hook event tabs */}
            <div className="config-hook-tabs">
              {lifecycleEvents.map((evt) => (
                <button
                  key={evt.key}
                  type="button"
                  className={`config-hook-tab ${activeHookTab === evt.key ? "active" : ""}`}
                  onClick={() => setActiveHookTab(evt.key)}
                >
                  {evt.label}
                  <span className="config-hook-tab-count">
                    {(config.hooks[evt.key] || []).length}
                  </span>
                </button>
              ))}
            </div>

            {/* Active hook event description */}
            <p className="config-hook-desc">
              {lifecycleEvents.find((e) => e.key === activeHookTab)?.desc}
            </p>

            {/* Hook entries */}
            {(config.hooks[activeHookTab] || []).map((hook, i) => (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: hook entries are edited and removed by their positional index and have no persisted identity.
                key={i}
                className="config-entry config-entry-hook"
              >
                <div className="config-entry-row">
                  <div className="config-field config-field-run">
                    <label htmlFor={`hook-run-${activeHookTab}-${i}`}>
                      run
                      <span className="config-field-help" title={help.run}>
                        ?
                      </span>
                    </label>
                    <input
                      id={`hook-run-${activeHookTab}-${i}`}
                      type="text"
                      value={hook.run}
                      placeholder="bun install"
                      onChange={(e) => updateHook(activeHookTab, i, "run", e.target.value)}
                    />
                  </div>
                  <button
                    type="button"
                    className="config-btn-delete"
                    onClick={() => removeHook(activeHookTab, i)}
                  >
                    ×
                  </button>
                </div>
                <div className="config-entry-row config-entry-row-fields">
                  {!hook.async && (
                    <div className="config-field">
                      <span className="config-field-label">
                        required
                        <span className="config-field-help" title={help.required}>
                          ?
                        </span>
                      </span>
                      <label className="config-checkbox">
                        <input
                          type="checkbox"
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
                  <div className="config-field">
                    <label htmlFor={`hook-timeout-${activeHookTab}-${i}`}>
                      timeout (ms)
                      <span className="config-field-help" title={help.timeout}>
                        ?
                      </span>
                    </label>
                    <input
                      id={`hook-timeout-${activeHookTab}-${i}`}
                      type="number"
                      value={hook.timeout}
                      min={1000}
                      step={1000}
                      onChange={(e) =>
                        updateHook(activeHookTab, i, "timeout", Number(e.target.value))
                      }
                    />
                  </div>
                  <div className="config-field">
                    <label htmlFor={`hook-cwd-${activeHookTab}-${i}`}>
                      cwd
                      <span className="config-field-help" title={help.cwd}>
                        ?
                      </span>
                    </label>
                    <select
                      id={`hook-cwd-${activeHookTab}-${i}`}
                      value={hook.cwd}
                      onChange={(e) => updateHook(activeHookTab, i, "cwd", e.target.value)}
                    >
                      <option value="worktree">worktree</option>
                      <option value="project">project</option>
                    </select>
                  </div>
                  <div className="config-field config-field-async-mode">
                    <span className="config-field-label">
                      {t("executionMode")}
                      <span className="config-field-help" title={help.async}>
                        ?
                      </span>
                    </span>
                    <div className="config-hook-mode-tabs">
                      <button
                        type="button"
                        className={`config-hook-mode-tab ${!hook.async ? "active" : ""}`}
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
                        className={`config-hook-mode-tab ${hook.async ? "active" : ""}`}
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
            <button type="button" className="config-btn-add" onClick={() => addHook(activeHookTab)}>
              {t("addHook")}
            </button>
          </div>
        )}
      </div>

      {/* Section: Ports */}
      <div className="config-section">
        <button
          type="button"
          className="config-section-header"
          onClick={() => setExpandedSections((s) => ({ ...s, ports: !s.ports }))}
        >
          <span className={`config-section-arrow ${expandedSections.ports ? "expanded" : ""}`}>
            ▶
          </span>
          <h3>{t("portAllocation")}</h3>
          <span className="config-section-count">
            {config.env?.ports && config.env.ports.length > 0
              ? t("portCount", { count: config.env.ports.length })
              : t("defaultPortCount")}
          </span>
        </button>
        <p className="config-section-desc">
          {t("portAllocationDesc")}
          {t("portAllocationFallback")}
        </p>

        {expandedSections.ports && (
          <div className="config-section-body">
            {/* Port key tags */}
            <div className="config-port-list">
              {(config.env?.ports ?? []).map((key, i) => (
                <div key={key} className="config-port-tag">
                  <span className="config-port-tag-label">{key}</span>
                  <button
                    type="button"
                    className="config-port-tag-remove"
                    onClick={() => removePortKey(i)}
                  >
                    ×
                  </button>
                </div>
              ))}
              {!config.env?.ports?.length && (
                <div className="config-port-empty">{t("noPortsConfigured")}</div>
              )}
            </div>

            {/* Add port key input */}
            <div className="config-port-add">
              <input
                type="text"
                value={newPortKey}
                placeholder={t("portKeyPlaceholder")}
                onChange={(e) => setNewPortKey(e.target.value)}
                onKeyDown={handlePortKeyInputKeyDown}
                className="config-port-input"
              />
              <button
                type="button"
                className="config-btn-add config-btn-add-port"
                onClick={() => addPortKey(newPortKey)}
                disabled={!newPortKey.trim() || !/^[A-Z][A-Z0-9_]*$/i.test(newPortKey.trim())}
              >
                {t("add")}
              </button>
            </div>

            {/* .env hints */}
            {data?.envPorts && data.envPorts.length > 0 && (
              <div className="config-port-hints">
                <span className="config-port-hints-label">{t("currentEnvPorts")}</span>
                <div className="config-port-hint-tags">
                  {data.envPorts.map((key) => {
                    const alreadyAdded = (config.env?.ports ?? []).includes(key);
                    return (
                      <span
                        key={key}
                        className={`config-port-hint-tag ${alreadyAdded ? "added" : ""}`}
                      >
                        {key}
                        {!alreadyAdded && (
                          <button
                            type="button"
                            className="config-port-hint-add"
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
        <div className="config-yaml-preview">
          <div className="config-yaml-preview-header">
            <h3>{t("yamlPreview")}</h3>
            <button type="button" onClick={() => setShowYamlPreview(false)}>
              {t("close")}
            </button>
          </div>
          <pre>
            <code>{yamlPreview}</code>
          </pre>
        </div>
      )}

      {/* Action bar */}
      <div className="config-actions">
        <button type="button" className="config-btn config-btn-preview" onClick={handlePreview}>
          {t("previewYaml")}
        </button>
        <div className="config-actions-right">
          {saveStatus === "success" && (
            <span className="config-save-status config-save-success">✓ {t("saved")}</span>
          )}
          {saveStatus === "error" && (
            <span className="config-save-status config-save-error">✗ {saveError}</span>
          )}
          <button
            type="button"
            className="config-btn config-btn-save"
            onClick={handleSave}
            disabled={saveMutation.isPending}
          >
            {saveMutation.isPending
              ? t("saving")
              : data?.exists
                ? t("saveConfig")
                : t("generateConfigFile")}
          </button>
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
    </div>
  );
}
