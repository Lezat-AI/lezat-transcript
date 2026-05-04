import React, { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import { commands } from "@/bindings";
import { useSettings } from "@/hooks/useSettings";
import {
  RefreshCw,
  Loader2,
  AlertCircle,
  CloudOff,
  Link2,
  ExternalLink,
  ChevronDown,
  ChevronUp,
  Check,
  Database,
  Settings2,
  Clock,
  LogIn,
} from "lucide-react";

interface IntegrationConfig {
  database_id: string | null;
  database_name: string | null;
  board_id: string | null;
  board_name: string | null;
  calendar_id: string | null;
  todo_status: string | null;
}

interface IntegrationStatus {
  provider: string;
  connected: boolean;
  workspace: string | null;
  account_name: string | null;
  config: IntegrationConfig | null;
}

interface SelectOption {
  id: string;
  name: string;
}

const PROVIDER_META: Record<string, { label: string; icon: string; color: string }> = {
  notion: { label: "Notion", icon: "N", color: "bg-[#000]/10 text-[#000] dark:bg-white/10 dark:text-white" },
  "google-calendar": { label: "Google Calendar", icon: "G", color: "bg-blue-500/10 text-blue-600" },
  "outlook-calendar": { label: "Outlook Calendar", icon: "O", color: "bg-sky-500/10 text-sky-600" },
  monday: { label: "Monday.com", icon: "M", color: "bg-orange-500/10 text-orange-600" },
  "read-ai": { label: "Read AI", icon: "R", color: "bg-purple-500/10 text-purple-600" },
};

export const IntegrationsPage: React.FC = () => {
  const { t } = useTranslation();
  const { settings } = useSettings();
  const [integrations, setIntegrations] = useState<IntegrationStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  // Config options fetched on demand
  const [notionDatabases, setNotionDatabases] = useState<SelectOption[]>([]);
  const [notionStatuses, setNotionStatuses] = useState<SelectOption[]>([]);
  const [mondayBoards, setMondayBoards] = useState<SelectOption[]>([]);
  const [loadingConfig, setLoadingConfig] = useState(false);
  const [savingConfig, setSavingConfig] = useState(false);

  const isConfigured = settings?.cloud_sync_url && settings?.cloud_sync_api_key;

  const fetchStatus = useCallback(async () => {
    if (!isConfigured) { setLoading(false); return; }
    setLoading(true);
    setError(null);
    try {
      const result = await (commands as any).cloudGetIntegrationsStatus();
      if (result.status === "ok") setIntegrations(result.data.integrations);
      else setError(result.error);
    } catch (e) { setError(String(e)); }
    finally { setLoading(false); }
  }, [isConfigured]);

  useEffect(() => { fetchStatus(); }, [fetchStatus]);

  // Auto-refresh when OAuth completes in the browser
  useEffect(() => {
    const p = listen<{ state: string; provider?: string }>(
      "integration-o-auth-event",
      (evt) => {
        if (evt.payload.state === "success") {
          fetchStatus();
        }
      },
    );
    return () => {
      p.then((fn) => fn()).catch(() => undefined);
    };
  }, [fetchStatus]);

  const handleConnect = async (provider: string) => {
    setConnecting(provider);
    try {
      const result = await (commands as any).cloudStartIntegrationOauth(provider);
      if (result.status === "error") setError(result.error);
    } catch (e) { setError(String(e)); }
    finally { setConnecting(null); }
  };

  const handleDisconnect = async (provider: string) => {
    try {
      const result = await (commands as any).cloudDisconnectIntegration(provider);
      if (result.status === "ok") {
        setIntegrations((prev) =>
          prev.map((i) => i.provider === provider ? { ...i, connected: false, config: null } : i),
        );
      } else { setError(result.error); }
    } catch (e) { setError(String(e)); }
  };

  const handleExpand = async (provider: string) => {
    if (expanded === provider) { setExpanded(null); return; }
    setExpanded(provider);
    setLoadingConfig(true);
    try {
      if (provider === "notion") {
        const result = await (commands as any).cloudGetNotionDatabases();
        if (result.status === "ok") setNotionDatabases(result.data);
        // Also fetch status options if a database is already selected
        const notionIntegration = integrations.find((i) => i.provider === "notion");
        const dbId = notionIntegration?.config?.database_id;
        if (dbId) {
          const statusResult = await (commands as any).cloudGetNotionStatusOptions(dbId);
          if (statusResult.status === "ok") {
            setNotionStatuses(statusResult.data.map((s: { name: string }) => ({ id: s.name, name: s.name })));
          }
        }
      } else if (provider === "monday") {
        const result = await (commands as any).cloudGetMondayBoards();
        if (result.status === "ok") setMondayBoards(result.data);
      }
    } catch { /* ignore */ }
    finally { setLoadingConfig(false); }
  };

  const handleSaveSetting = async (key: string, value: string) => {
    setSavingConfig(true);
    try {
      await (commands as any).cloudUpdateIntegrationSettings({ [key]: value });
      await fetchStatus(); // Refresh to see updated config
    } catch { /* ignore */ }
    finally { setSavingConfig(false); }
  };

  const handleNotionDatabaseChange = async (databaseId: string) => {
    await handleSaveSetting("NOTION_TASKS_DATABASE_ID", databaseId);
    // Fetch status options for the newly selected database
    setNotionStatuses([]);
    if (databaseId) {
      try {
        const result = await (commands as any).cloudGetNotionStatusOptions(databaseId);
        if (result.status === "ok") {
          setNotionStatuses(result.data.map((s: { name: string }) => ({ id: s.name, name: s.name })));
        }
      } catch { /* ignore */ }
    }
  };

  if (!isConfigured) {
    return (
      <div className="flex flex-col h-full">
        <div className="flex items-center justify-between px-6 py-4 border-b border-mid-gray/20">
          <h2 className="text-lg font-semibold">{t("integrations.title")}</h2>
        </div>
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-3">
          <div className="flex flex-col items-center justify-center gap-4 text-center px-8 py-12">
            <CloudOff className="w-12 h-12 opacity-40" />
            <p className="text-lg font-medium opacity-70">{t("integrations.notConfigured")}</p>
            <p className="text-sm opacity-50">{t("integrations.configureHint")}</p>
          </div>
          <TimesheetCard />
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="w-6 h-6 animate-spin opacity-50" />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-6 py-4 border-b border-mid-gray/20">
        <h2 className="text-lg font-semibold">{t("integrations.title")}</h2>
        <button onClick={fetchStatus} className="p-2 rounded-lg hover:bg-mid-gray/10 transition-colors">
          <RefreshCw className="w-4 h-4" />
        </button>
      </div>

      {error && (
        <div className="mx-6 mt-4 p-3 rounded-lg bg-red-500/10 text-red-500 text-sm flex items-center gap-2">
          <AlertCircle className="w-4 h-4 shrink-0" />
          <span className="truncate">{error}</span>
          <button onClick={() => setError(null)} className="ml-auto text-xs underline shrink-0">
            {t("integrations.dismiss")}
          </button>
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-6 py-4 space-y-3">
        {integrations.map((integration) => {
          const meta = PROVIDER_META[integration.provider] ?? {
            label: integration.provider, icon: "?", color: "bg-mid-gray/10",
          };
          const isExpanded = expanded === integration.provider;
          const hasConfig = integration.provider === "notion" || integration.provider === "monday";

          return (
            <div key={integration.provider} className="rounded-xl border border-mid-gray/20 overflow-hidden">
              {/* Main row */}
              <div className="flex items-center gap-4 p-4">
                <div className={`flex items-center justify-center w-10 h-10 rounded-lg text-sm font-bold ${meta.color}`}>
                  {integration.connected ? (
                    <Link2 className="w-5 h-5" />
                  ) : (
                    <span className="opacity-40">{meta.icon}</span>
                  )}
                </div>

                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium">{meta.label}</p>
                  {integration.connected ? (
                    <div className="flex items-center gap-2 text-xs text-mid-gray flex-wrap">
                      <span className="w-1.5 h-1.5 rounded-full bg-green-500 shrink-0" />
                      <span>{t("integrations.connected")}</span>
                      {(integration.workspace || integration.account_name) && (
                        <span className="opacity-60 truncate max-w-[180px]" title={integration.workspace || integration.account_name || ""}>
                          {integration.workspace || integration.account_name}
                        </span>
                      )}
                      {integration.config?.database_id && (
                        <span className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-mid-gray/10">
                          <Database className="w-3 h-3" />
                          {integration.config.database_name || integration.config.database_id}
                        </span>
                      )}
                      {integration.config?.board_id && (
                        <span className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-mid-gray/10">
                          <Database className="w-3 h-3" />
                          {integration.config.board_name || integration.config.board_id}
                        </span>
                      )}
                    </div>
                  ) : (
                    <p className="text-xs opacity-40">{t("integrations.disconnected")}</p>
                  )}
                </div>

                <div className="flex items-center gap-2">
                  {integration.connected && hasConfig && (
                    <button
                      onClick={() => handleExpand(integration.provider)}
                      className="p-1.5 rounded-lg hover:bg-mid-gray/10 transition-colors"
                      title={t("integrations.configure")}
                    >
                      {isExpanded ? <ChevronUp className="w-4 h-4" /> : <Settings2 className="w-4 h-4" />}
                    </button>
                  )}
                  {integration.connected ? (
                    <button
                      onClick={() => handleDisconnect(integration.provider)}
                      className="px-3 py-1.5 text-xs font-medium rounded-lg border border-red-500/30 text-red-500 hover:bg-red-500/10 transition-colors"
                    >
                      {t("integrations.disconnect")}
                    </button>
                  ) : (
                    <button
                      onClick={() => handleConnect(integration.provider)}
                      disabled={connecting === integration.provider}
                      className="px-3 py-1.5 text-xs font-medium rounded-lg bg-lezat-sage text-[#0d0d1a] hover:bg-lezat-sage/80 disabled:opacity-50 transition-colors flex items-center gap-1.5"
                    >
                      {connecting === integration.provider ? (
                        <Loader2 className="w-3 h-3 animate-spin" />
                      ) : (
                        <ExternalLink className="w-3 h-3" />
                      )}
                      {t("integrations.connect")}
                    </button>
                  )}
                </div>
              </div>

              {/* Expanded config panel */}
              {isExpanded && integration.connected && (
                <div className="border-t border-mid-gray/10 p-4 bg-mid-gray/[0.03]">
                  {loadingConfig ? (
                    <div className="flex items-center justify-center py-4">
                      <Loader2 className="w-4 h-4 animate-spin opacity-50" />
                    </div>
                  ) : (
                    <div className="flex flex-col gap-3">
                      {integration.provider === "notion" && (
                        <>
                          <ConfigSelect
                            label={t("integrations.notion.database")}
                            options={notionDatabases}
                            value={integration.config?.database_id ?? ""}
                            saving={savingConfig}
                            onChange={(id) => handleNotionDatabaseChange(id)}
                          />
                          {integration.config?.database_id && (
                            <ConfigSelect
                              label={t("integrations.notion.status")}
                              options={notionStatuses}
                              value={integration.config?.todo_status ?? ""}
                              saving={savingConfig}
                              onChange={(status) => handleSaveSetting("NOTION_KANBAN_TODO_STATUS", status)}
                            />
                          )}
                        </>
                      )}
                      {integration.provider === "monday" && (
                        <ConfigSelect
                          label={t("integrations.monday.board")}
                          options={mondayBoards}
                          value={integration.config?.board_id ?? ""}
                          saving={savingConfig}
                          onChange={(id) => handleSaveSetting("MONDAY_BOARD_ID", id)}
                        />
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}

        {/* Timesheet — standalone integration (not via cloud_sync) */}
        <TimesheetCard />
      </div>
    </div>
  );
};

// ─── Timesheet integration card ─────────────────────────────────

interface TimesheetProjectOption {
  id: number;
  name: string;
  client_name: string;
}

function TimesheetCard() {
  const { t } = useTranslation();
  const { settings, refreshSettings } = useSettings();

  const isConnected = !!settings?.timesheet_token;
  const connectedEmail = settings?.timesheet_email ?? null;

  const [expanded, setExpanded] = useState(false);
  const [showLogin, setShowLogin] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loggingIn, setLoggingIn] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);

  // Config panel state
  const [projects, setProjects] = useState<TimesheetProjectOption[]>([]);
  const [loadingProjects, setLoadingProjects] = useState(false);

  // Time entry form state
  const [showEntryForm, setShowEntryForm] = useState(false);
  const [entryProjectId, setEntryProjectId] = useState<number | null>(null);
  const [entryHoursInput, setEntryHoursInput] = useState("");
  const [entryDescription, setEntryDescription] = useState("");
  const [entryDate, setEntryDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [submitting, setSubmitting] = useState(false);
  const [submitSuccess, setSubmitSuccess] = useState(false);

  const handleLogin = async () => {
    setLoggingIn(true);
    setLoginError(null);
    try {
      const result = await (commands as any).timesheetLogin(email, password);
      if (result.status === "ok") {
        setShowLogin(false);
        setEmail("");
        setPassword("");
        refreshSettings();
      } else {
        setLoginError(result.error ?? t("integrations.timesheet.loginError"));
      }
    } catch {
      setLoginError(t("integrations.timesheet.loginError"));
    } finally {
      setLoggingIn(false);
    }
  };

  const handleDisconnect = async () => {
    try {
      await (commands as any).timesheetDisconnect();
      refreshSettings();
      setExpanded(false);
      setShowEntryForm(false);
    } catch { /* ignore */ }
  };

  const handleExpand = async () => {
    if (expanded) { setExpanded(false); return; }
    setExpanded(true);
    setLoadingProjects(true);
    try {
      const result = await (commands as any).timesheetGetProjects();
      if (result.status === "ok") setProjects(result.data);
    } catch { /* ignore */ }
    finally { setLoadingProjects(false); }
  };

  const handleSetDefaultProject = async (projectId: string) => {
    const id = projectId ? Number(projectId) : null;
    try {
      await (commands as any).timesheetSetDefaultProject(id);
      refreshSettings();
    } catch { /* ignore */ }
  };

  // Parse user-friendly hours input to decimal
  const parseHoursInput = (input: string): number | null => {
    const trimmed = input.trim().toLowerCase();
    if (!trimmed) return null;

    // Try direct decimal: "1.5", "2"
    const directNum = parseFloat(trimmed);
    if (/^\d+(\.\d+)?$/.test(trimmed) && !isNaN(directNum) && directNum > 0) {
      return directNum;
    }

    // Try "Xh Ym" pattern: "1h 30m", "1h30m", "2h", "45m"
    const hMatch = trimmed.match(/(\d+)\s*h/);
    const mMatch = trimmed.match(/(\d+)\s*m/);
    if (hMatch || mMatch) {
      const hours = hMatch ? parseInt(hMatch[1], 10) : 0;
      const minutes = mMatch ? parseInt(mMatch[1], 10) : 0;
      const total = hours + minutes / 60;
      return total > 0 ? Math.round(total * 100) / 100 : null;
    }

    return null;
  };

  const formatHoursPreview = (input: string): string | null => {
    const hours = parseHoursInput(input);
    if (hours === null) return null;
    const h = Math.floor(hours);
    const m = Math.round((hours - h) * 60);
    if (h > 0 && m > 0) return `${h}h ${m}m`;
    if (h > 0) return `${h}h`;
    if (m > 0) return `${m}m`;
    return null;
  };

  const handleSubmitEntry = async () => {
    const hours = parseHoursInput(entryHoursInput);
    if (!hours || !entryProjectId || !entryDescription.trim() || !entryDate) return;

    setSubmitting(true);
    try {
      const result = await (commands as any).timesheetCreateEntry(
        entryProjectId,
        entryDate,
        hours,
        entryDescription.trim(),
      );
      if (result.status === "ok") {
        setSubmitSuccess(true);
        setEntryHoursInput("");
        setEntryDescription("");
        setTimeout(() => setSubmitSuccess(false), 3000);
      }
    } catch { /* ignore */ }
    finally { setSubmitting(false); }
  };

  const defaultProjectId = settings?.timesheet_default_project_id ?? null;

  return (
    <div className="rounded-xl border border-mid-gray/20 overflow-hidden">
      {/* Main row */}
      <div className="flex items-center gap-4 p-4">
        <div className="flex items-center justify-center w-10 h-10 rounded-lg text-sm font-bold bg-emerald-500/10 text-emerald-600">
          {isConnected ? <Link2 className="w-5 h-5" /> : <Clock className="w-5 h-5 opacity-40" />}
        </div>

        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium">{t("integrations.timesheet.title")}</p>
          {isConnected ? (
            <div className="flex items-center gap-2 text-xs text-mid-gray">
              <span className="w-1.5 h-1.5 rounded-full bg-green-500 shrink-0" />
              <span>{t("integrations.connected")}</span>
              {connectedEmail && (
                <span className="opacity-60 truncate max-w-[180px]" title={connectedEmail}>
                  {connectedEmail}
                </span>
              )}
            </div>
          ) : (
            <p className="text-xs opacity-40">{t("integrations.disconnected")}</p>
          )}
        </div>

        <div className="flex items-center gap-2">
          {isConnected && (
            <button
              onClick={handleExpand}
              className="p-1.5 rounded-lg hover:bg-mid-gray/10 transition-colors"
              title={t("integrations.configure")}
            >
              {expanded ? <ChevronUp className="w-4 h-4" /> : <Settings2 className="w-4 h-4" />}
            </button>
          )}
          {isConnected ? (
            <button
              onClick={handleDisconnect}
              className="px-3 py-1.5 text-xs font-medium rounded-lg border border-red-500/30 text-red-500 hover:bg-red-500/10 transition-colors"
            >
              {t("integrations.disconnect")}
            </button>
          ) : (
            <button
              onClick={() => setShowLogin(true)}
              className="px-3 py-1.5 text-xs font-medium rounded-lg bg-lezat-sage text-[#0d0d1a] hover:bg-lezat-sage/80 transition-colors flex items-center gap-1.5"
            >
              <LogIn className="w-3 h-3" />
              {t("integrations.connect")}
            </button>
          )}
        </div>
      </div>

      {/* Login form */}
      {showLogin && !isConnected && (
        <div className="border-t border-mid-gray/10 p-4 bg-mid-gray/[0.03]">
          <div className="flex flex-col gap-3 max-w-sm">
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-mid-gray">{t("integrations.timesheet.email")}</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="px-3 py-1.5 text-sm rounded-lg border border-mid-gray/20 bg-transparent"
                autoFocus
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-mid-gray">{t("integrations.timesheet.password")}</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && !loggingIn && email && password && handleLogin()}
                className="px-3 py-1.5 text-sm rounded-lg border border-mid-gray/20 bg-transparent"
              />
            </div>
            {loginError && (
              <p className="text-xs text-red-500">{loginError}</p>
            )}
            <div className="flex gap-2">
              <button
                onClick={handleLogin}
                disabled={loggingIn || !email || !password}
                className="px-4 py-1.5 text-xs font-medium rounded-lg bg-lezat-sage text-[#0d0d1a] hover:bg-lezat-sage/80 disabled:opacity-50 transition-colors flex items-center gap-1.5"
              >
                {loggingIn && <Loader2 className="w-3 h-3 animate-spin" />}
                {loggingIn ? t("integrations.timesheet.loggingIn") : t("integrations.timesheet.login")}
              </button>
              <button
                onClick={() => { setShowLogin(false); setLoginError(null); }}
                className="px-4 py-1.5 text-xs font-medium rounded-lg border border-mid-gray/20 hover:bg-mid-gray/10 transition-colors"
              >
                {t("integrations.dismiss")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Config panel (project selector + time entry form) */}
      {expanded && isConnected && (
        <div className="border-t border-mid-gray/10 p-4 bg-mid-gray/[0.03]">
          {loadingProjects ? (
            <div className="flex items-center justify-center py-4">
              <Loader2 className="w-4 h-4 animate-spin opacity-50" />
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              {/* Default project selector */}
              <ConfigSelect
                label={t("integrations.timesheet.project")}
                options={projects.map((p) => ({ id: String(p.id), name: `${p.name} (${p.client_name})` }))}
                value={defaultProjectId ? String(defaultProjectId) : ""}
                saving={false}
                onChange={handleSetDefaultProject}
              />

              {/* Toggle time entry form */}
              <button
                onClick={() => {
                  setShowEntryForm(!showEntryForm);
                  if (!showEntryForm && defaultProjectId) {
                    setEntryProjectId(defaultProjectId);
                  }
                }}
                className="self-start px-3 py-1.5 text-xs font-medium rounded-lg border border-mid-gray/20 hover:bg-mid-gray/10 transition-colors flex items-center gap-1.5"
              >
                <Clock className="w-3 h-3" />
                {t("integrations.timesheet.addEntry")}
              </button>

              {/* Time entry form */}
              {showEntryForm && (
                <div className="flex flex-col gap-3 p-3 rounded-lg border border-mid-gray/10 bg-mid-gray/[0.02]">
                  {/* Project */}
                  <ConfigSelect
                    label={t("integrations.timesheet.project")}
                    options={projects.map((p) => ({ id: String(p.id), name: `${p.name} (${p.client_name})` }))}
                    value={entryProjectId ? String(entryProjectId) : ""}
                    saving={false}
                    onChange={(id) => setEntryProjectId(id ? Number(id) : null)}
                  />

                  {/* Date */}
                  <div className="flex items-center gap-3">
                    <label className="text-xs font-medium text-mid-gray shrink-0 w-32">
                      {t("integrations.timesheet.date")}
                    </label>
                    <input
                      type="date"
                      value={entryDate}
                      onChange={(e) => setEntryDate(e.target.value)}
                      className="flex-1 px-3 py-1.5 text-sm rounded-lg border border-mid-gray/20 bg-transparent"
                    />
                  </div>

                  {/* Hours — friendly input */}
                  <div className="flex items-center gap-3">
                    <label className="text-xs font-medium text-mid-gray shrink-0 w-32">
                      {t("integrations.timesheet.hours")}
                    </label>
                    <div className="flex-1 relative">
                      <input
                        type="text"
                        value={entryHoursInput}
                        onChange={(e) => setEntryHoursInput(e.target.value)}
                        placeholder={t("integrations.timesheet.hoursPlaceholder")}
                        className="w-full px-3 py-1.5 text-sm rounded-lg border border-mid-gray/20 bg-transparent pr-16"
                      />
                      {entryHoursInput && (
                        <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-mid-gray">
                          {formatHoursPreview(entryHoursInput) ?? "?"}
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Description */}
                  <div className="flex items-start gap-3">
                    <label className="text-xs font-medium text-mid-gray shrink-0 w-32 pt-2">
                      {t("integrations.timesheet.description")}
                    </label>
                    <textarea
                      value={entryDescription}
                      onChange={(e) => setEntryDescription(e.target.value)}
                      placeholder={t("integrations.timesheet.descriptionPlaceholder")}
                      rows={2}
                      className="flex-1 px-3 py-1.5 text-sm rounded-lg border border-mid-gray/20 bg-transparent resize-none"
                    />
                  </div>

                  {/* Submit */}
                  <div className="flex items-center gap-2">
                    <button
                      onClick={handleSubmitEntry}
                      disabled={submitting || !entryProjectId || !parseHoursInput(entryHoursInput) || !entryDescription.trim()}
                      className="px-4 py-1.5 text-xs font-medium rounded-lg bg-lezat-sage text-[#0d0d1a] hover:bg-lezat-sage/80 disabled:opacity-50 transition-colors flex items-center gap-1.5"
                    >
                      {submitting && <Loader2 className="w-3 h-3 animate-spin" />}
                      {submitting ? t("integrations.timesheet.submitting") : t("integrations.timesheet.submit")}
                    </button>
                    {submitSuccess && (
                      <span className="text-xs text-green-500 flex items-center gap-1">
                        <Check className="w-3 h-3" />
                        {t("integrations.timesheet.success")}
                      </span>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Shared components ──────────────────────────────────────────

function ConfigSelect({
  label,
  options,
  value,
  saving,
  onChange,
}: {
  label: string;
  options: SelectOption[];
  value: string;
  saving: boolean;
  onChange: (id: string) => void;
}) {
  return (
    <div className="flex items-center gap-3">
      <label className="text-xs font-medium text-mid-gray shrink-0 w-32">
        {label}
      </label>
      <div className="flex-1 relative">
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={saving}
          className="w-full px-3 py-1.5 text-sm rounded-lg border border-mid-gray/20 bg-transparent appearance-none cursor-pointer disabled:opacity-50 pr-8"
        >
          <option value="">—</option>
          {options.map((opt) => (
            <option key={opt.id} value={opt.id}>{opt.name}</option>
          ))}
        </select>
        <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 pointer-events-none opacity-40" />
      </div>
      {value && !saving && <Check className="w-4 h-4 text-green-500 shrink-0" />}
      {saving && <Loader2 className="w-4 h-4 animate-spin opacity-50 shrink-0" />}
    </div>
  );
}

export default IntegrationsPage;
