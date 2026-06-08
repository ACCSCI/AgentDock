import { useCallback, useEffect, useMemo, useState } from "react";
import { stringify as yamlStringify, Scalar } from "yaml";
import { useProjectConfig, useSaveConfig, type ProjectConfigData } from "../lib/queries";
import { FilePicker } from "./FilePicker";

// Field help descriptions
const HELP = {
  source: "相对项目根目录的文件或目录路径，如 .env、config/、uploads/",
  strategy: "同步策略：overwrite=每次覆盖目标、skip=目标存在时跳过、merge=.env 逐 key 合并，目录递归叠加",
  skipIfMissing: "true=源不存在时静默跳过、false=源不存在时触发 rollback",
  run: "要执行的 shell 命令，如 bun install、npm run build",
  required: "true=失败时中断 pipeline 并 rollback",
  timeout: "超时毫秒数，超时后 SIGTERM 终止进程",
  cwd: "worktree=新工作目录、project=项目根目录",
  async: "true=不等待完成即返回，后台执行",
};

const LIFECYCLE_EVENTS = [
  { key: "beforeCreateSession", label: "创建前", desc: "Worktree 创建前触发" },
  { key: "afterCreateSession", label: "创建后", desc: "端口分配 + .env 写入后触发" },
  { key: "beforeDeleteSession", label: "删除前", desc: "Worktree 删除前触发" },
  { key: "afterDeleteSession", label: "删除后", desc: "Worktree 删除后触发" },
] as const;

type Config = ProjectConfigData["config"];

interface ConfigEditorProps {
  projectId: string;
  projectPath: string;
}

export function ConfigEditor({ projectId }: ConfigEditorProps) {
  const { data, isLoading } = useProjectConfig(projectId);
  const saveMutation = useSaveConfig(projectId);

  const [config, setConfig] = useState<Config | null>(null);
  const [showYamlPreview, setShowYamlPreview] = useState(false);
  const [saveStatus, setSaveStatus] = useState<"idle" | "success" | "error">("idle");
  const [saveError, setSaveError] = useState("");
  const [expandedSections, setExpandedSections] = useState({ resources: true, hooks: true, ports: false });
  const [activeHookTab, setActiveHookTab] = useState("afterCreateSession");
  const [filePickerOpen, setFilePickerOpen] = useState(false);
  const [filePickerTarget, setFilePickerTarget] = useState<number | null>(null);
  const [newPortKey, setNewPortKey] = useState("");

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

  const removeResource = useCallback((index: number) => {
    updateConfig((prev) => ({
      ...prev,
      resources: { sync: prev.resources.sync.filter((_, i) => i !== index) },
    }));
  }, [updateConfig]);

  const updateResource = useCallback((index: number, field: string, value: unknown) => {
    updateConfig((prev) => ({
      ...prev,
      resources: {
        sync: prev.resources.sync.map((r, i) => (i === index ? { ...r, [field]: value } : r)),
      },
    }));
  }, [updateConfig]);

  const handleFileSelect = useCallback((filePath: string) => {
    if (filePickerTarget !== null) {
      updateResource(filePickerTarget, "source", filePath);
    }
    setFilePickerOpen(false);
    setFilePickerTarget(null);
  }, [filePickerTarget, updateResource]);

  // --- Hook handlers ---
  const addHook = useCallback((event: string) => {
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
  }, [updateConfig]);

  const removeHook = useCallback((event: string, index: number) => {
    updateConfig((prev) => ({
      ...prev,
      hooks: {
        ...prev.hooks,
        [event]: (prev.hooks[event] || []).filter((_, i) => i !== index),
      },
    }));
  }, [updateConfig]);

  const updateHook = useCallback((event: string, index: number, field: string, value: unknown) => {
    updateConfig((prev) => ({
      ...prev,
      hooks: {
        ...prev.hooks,
        [event]: (prev.hooks[event] || []).map((h, i) => (i === index ? { ...h, [field]: value } : h)),
      },
    }));
  }, [updateConfig]);

  // --- Port key handlers ---
  const addPortKey = useCallback((key: string) => {
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
  }, [updateConfig]);

  const removePortKey = useCallback((index: number) => {
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
  }, [updateConfig]);

  const handlePortKeyInputKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addPortKey(newPortKey);
    }
  }, [addPortKey, newPortKey]);

  // --- Actions ---
  const handlePreview = useCallback(() => {
    setShowYamlPreview((prev) => !prev);
  }, []);

  const handleSave = useCallback(async () => {
    if (!config) return;
    setSaveStatus("idle");
    setSaveError("");
    try {
      await saveMutation.mutateAsync(config);
      setSaveStatus("success");
      setTimeout(() => setSaveStatus("idle"), 3000);
    } catch (err) {
      setSaveStatus("error");
      setSaveError(err instanceof Error ? err.message : "保存失败");
    }
  }, [config, saveMutation]);

  if (isLoading || !config) {
    return (
      <div className="config-editor">
        <div className="config-loading">加载配置中...</div>
      </div>
    );
  }

  return (
    <div className="config-editor">
      <div className="config-editor-header">
        <h2>项目配置</h2>
        <span className="config-file-status">
          {data?.exists ? "📄 agentdock.config.yaml" : "⚠️ 配置文件不存在，保存后将创建"}
        </span>
      </div>

      {/* Section: Resource Sync */}
      <div className="config-section">
        <button
          type="button"
          className="config-section-header"
          onClick={() => setExpandedSections((s) => ({ ...s, resources: !s.resources }))}
        >
          <span className={`config-section-arrow ${expandedSections.resources ? "expanded" : ""}`}>▶</span>
          <h3>资源同步 (resources.sync)</h3>
          <span className="config-section-count">{config.resources.sync.length} 项</span>
        </button>
        <p className="config-section-desc">
          在 Worktree 创建后、端口分配前，将指定文件从项目根目录同步到新工作目录
        </p>

        {expandedSections.resources && (
          <div className="config-section-body">
            {config.resources.sync.map((res, i) => (
              <div key={i} className="config-entry">
                <div className="config-entry-row">
                  <div className="config-field config-field-source">
                    <label>
                      source
                      <span className="config-field-help" title={HELP.source}>?</span>
                    </label>
                    <div className="config-field-input-group">
                      <input
                        type="text"
                        value={res.source}
                        placeholder=".env"
                        onChange={(e) => updateResource(i, "source", e.target.value)}
                      />
                      <button
                        type="button"
                        className="config-btn-browse"
                        onClick={() => { setFilePickerTarget(i); setFilePickerOpen(true); }}
                      >
                        浏览...
                      </button>
                    </div>
                  </div>
                  <button type="button" className="config-btn-delete" onClick={() => removeResource(i)}>×</button>
                </div>
                <div className="config-entry-row config-entry-row-fields">
                  <div className="config-field">
                    <label>
                      strategy
                      <span className="config-field-help" title={HELP.strategy}>?</span>
                    </label>
                    <select value={res.strategy} onChange={(e) => updateResource(i, "strategy", e.target.value)}>
                      <option value="overwrite">overwrite（覆盖）</option>
                      <option value="skip">skip（跳过）</option>
                      <option value="merge">merge（合并）</option>
                    </select>
                  </div>
                  <div className="config-field">
                    <label>
                      skipIfMissing
                      <span className="config-field-help" title={HELP.skipIfMissing}>?</span>
                    </label>
                    <label className="config-checkbox">
                      <input
                        type="checkbox"
                        checked={res.skipIfMissing}
                        onChange={(e) => updateResource(i, "skipIfMissing", e.target.checked)}
                      />
                      <span>源不存在时跳过</span>
                    </label>
                  </div>
                </div>
              </div>
            ))}
            <button type="button" className="config-btn-add" onClick={addResource}>
              + 添加资源
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
          <span className={`config-section-arrow ${expandedSections.hooks ? "expanded" : ""}`}>▶</span>
          <h3>生命周期钩子 (hooks)</h3>
        </button>
        <p className="config-section-desc">
          在 Session 生命周期的特定阶段执行 shell 命令
        </p>

        {expandedSections.hooks && (
          <div className="config-section-body">
            {/* Hook event tabs */}
            <div className="config-hook-tabs">
              {LIFECYCLE_EVENTS.map((evt) => (
                <button
                  key={evt.key}
                  type="button"
                  className={`config-hook-tab ${activeHookTab === evt.key ? "active" : ""}`}
                  onClick={() => setActiveHookTab(evt.key)}
                >
                  {evt.label}
                  <span className="config-hook-tab-count">{(config.hooks[evt.key] || []).length}</span>
                </button>
              ))}
            </div>

            {/* Active hook event description */}
            <p className="config-hook-desc">
              {LIFECYCLE_EVENTS.find((e) => e.key === activeHookTab)?.desc}
            </p>

            {/* Hook entries */}
            {(config.hooks[activeHookTab] || []).map((hook, i) => (
              <div key={i} className="config-entry config-entry-hook">
                <div className="config-entry-row">
                  <div className="config-field config-field-run">
                    <label>
                      run
                      <span className="config-field-help" title={HELP.run}>?</span>
                    </label>
                    <input
                      type="text"
                      value={hook.run}
                      placeholder="bun install"
                      onChange={(e) => updateHook(activeHookTab, i, "run", e.target.value)}
                    />
                  </div>
                  <button type="button" className="config-btn-delete" onClick={() => removeHook(activeHookTab, i)}>×</button>
                </div>
                <div className="config-entry-row config-entry-row-fields">
                  <div className="config-field">
                    <label>
                      required
                      <span className="config-field-help" title={HELP.required}>?</span>
                    </label>
                    <label className="config-checkbox">
                      <input
                        type="checkbox"
                        checked={hook.required}
                        onChange={(e) => updateHook(activeHookTab, i, "required", e.target.checked)}
                      />
                      <span>失败中断</span>
                    </label>
                  </div>
                  <div className="config-field">
                    <label>
                      timeout (ms)
                      <span className="config-field-help" title={HELP.timeout}>?</span>
                    </label>
                    <input
                      type="number"
                      value={hook.timeout}
                      min={1000}
                      step={1000}
                      onChange={(e) => updateHook(activeHookTab, i, "timeout", Number(e.target.value))}
                    />
                  </div>
                  <div className="config-field">
                    <label>
                      cwd
                      <span className="config-field-help" title={HELP.cwd}>?</span>
                    </label>
                    <select value={hook.cwd} onChange={(e) => updateHook(activeHookTab, i, "cwd", e.target.value)}>
                      <option value="worktree">worktree</option>
                      <option value="project">project</option>
                    </select>
                  </div>
                  <div className="config-field">
                    <label>
                      async
                      <span className="config-field-help" title={HELP.async}>?</span>
                    </label>
                    <label className="config-checkbox">
                      <input
                        type="checkbox"
                        checked={hook.async}
                        onChange={(e) => updateHook(activeHookTab, i, "async", e.target.checked)}
                      />
                      <span>异步执行</span>
                    </label>
                  </div>
                </div>
              </div>
            ))}
            <button type="button" className="config-btn-add" onClick={() => addHook(activeHookTab)}>
              + 添加钩子
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
          <span className={`config-section-arrow ${expandedSections.ports ? "expanded" : ""}`}>▶</span>
          <h3>端口分配 (env.ports)</h3>
          <span className="config-section-count">
            {(config.env?.ports && config.env.ports.length > 0)
              ? `${config.env.ports.length} 个端口`
              : "默认 5 端口"}
          </span>
        </button>
        <p className="config-section-desc">
          定义此项目需要分配哪些端口变量。分配到 worktree 后写入 .env 文件。
          不配置时默认分配 FRONTEND_PORT、BACKEND_PORT、WS_PORT、DEBUG_PORT、PREVIEW_PORT。
        </p>

        {expandedSections.ports && (
          <div className="config-section-body">
            {/* Port key tags */}
            <div className="config-port-list">
              {(config.env?.ports ?? []).map((key, i) => (
                <div key={i} className="config-port-tag">
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
                <div className="config-port-empty">
                  未配置自定义端口变量，将使用默认 5 端口
                </div>
              )}
            </div>

            {/* Add port key input */}
            <div className="config-port-add">
              <input
                type="text"
                value={newPortKey}
                placeholder="输入端口变量名如 METRICS_PORT，按 Enter 添加"
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
                + 添加
              </button>
            </div>

            {/* .env hints */}
            {data?.envPorts && data.envPorts.length > 0 && (
              <div className="config-port-hints">
                <span className="config-port-hints-label">📋 当前 .env 中的端口变量：</span>
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
                            title="添加到配置"
                          >
                            + 添加
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
            <h3>YAML 预览</h3>
            <button type="button" onClick={() => setShowYamlPreview(false)}>关闭</button>
          </div>
          <pre><code>{yamlPreview}</code></pre>
        </div>
      )}

      {/* Action bar */}
      <div className="config-actions">
        <button type="button" className="config-btn config-btn-preview" onClick={handlePreview}>
          预览 YAML
        </button>
        <div className="config-actions-right">
          {saveStatus === "success" && <span className="config-save-status config-save-success">✓ 已保存</span>}
          {saveStatus === "error" && <span className="config-save-status config-save-error">✗ {saveError}</span>}
          <button
            type="button"
            className="config-btn config-btn-save"
            onClick={handleSave}
            disabled={saveMutation.isPending}
          >
            {saveMutation.isPending ? "保存中..." : data?.exists ? "保存配置" : "生成配置文件"}
          </button>
        </div>
      </div>

      {/* File Picker */}
      <FilePicker
        open={filePickerOpen}
        projectId={projectId}
        onConfirm={handleFileSelect}
        onCancel={() => { setFilePickerOpen(false); setFilePickerTarget(null); }}
      />
    </div>
  );
}
