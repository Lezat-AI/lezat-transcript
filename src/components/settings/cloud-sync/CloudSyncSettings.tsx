import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import { commands } from "@/bindings";
import { useSettings } from "@/hooks/useSettings";
import { ToggleSwitch } from "@/components/ui/ToggleSwitch";
import { Input } from "@/components/ui/Input";
import {
  CheckCircle2,
  XCircle,
  Loader2,
  LogOut,
  ListChecks,
  Plug,
  CloudUpload,
  Users,
  Mail,
  UserPlus,
} from "lucide-react";

const BACKEND_URL = "https://founderzat-agent-backend-production.up.railway.app";

const FEATURES = [
  {
    icon: CloudUpload,
    titleKey: "settings.cloudSync.features.sync.title",
    descKey: "settings.cloudSync.features.sync.desc",
  },
  {
    icon: ListChecks,
    titleKey: "settings.cloudSync.features.actions.title",
    descKey: "settings.cloudSync.features.actions.desc",
  },
  {
    icon: Plug,
    titleKey: "settings.cloudSync.features.integrations.title",
    descKey: "settings.cloudSync.features.integrations.desc",
  },
  {
    icon: Users,
    titleKey: "settings.cloudSync.features.team.title",
    descKey: "settings.cloudSync.features.team.desc",
  },
];

function GoogleIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none">
      <path
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"
        fill="#4285F4"
      />
      <path
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
        fill="#34A853"
      />
      <path
        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
        fill="#FBBC05"
      />
      <path
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
        fill="#EA4335"
      />
    </svg>
  );
}

export const CloudSyncSettings: React.FC = () => {
  const { t } = useTranslation();
  const { settings, updateSetting, refreshSettings } = useSettings();

  // Auth method toggle
  const [showEmailLogin, setShowEmailLogin] = useState(false);
  const [isRegisterMode, setIsRegisterMode] = useState(false);

  // Email login/register state
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [fullName, setFullName] = useState("");

  // Shared auth state
  const [authStatus, setAuthStatus] = useState<
    "idle" | "loading" | "error"
  >("idle");
  const [authError, setAuthError] = useState("");
  const [connectedEmail, setConnectedEmail] = useState<string | null>(null);

  const isLoggedIn = !!(
    settings?.cloud_sync_api_key && settings?.cloud_sync_url
  );

  // On mount, fetch connected user info
  React.useEffect(() => {
    if (isLoggedIn) {
      (commands as any)
        .cloudTestConnection()
        .then((result: any) => {
          if (result.status === "ok" && result.data.user_email) {
            setConnectedEmail(result.data.user_email);
          }
        })
        .catch(() => {});
    }
  }, [isLoggedIn]);

  // Listen for Google OAuth result (comes async from background thread)
  useEffect(() => {
    const p = listen<{ state: string; user_email?: string; user_name?: string; error?: string }>(
      "google-login-event",
      async (evt) => {
        if (evt.payload.state === "success") {
          setConnectedEmail(evt.payload.user_email ?? null);
          setAuthStatus("idle");
          await refreshSettings();
        } else if (evt.payload.state === "failed") {
          setAuthStatus("error");
          setAuthError(evt.payload.error ?? "Google sign-in failed");
        }
      },
    );
    return () => {
      p.then((fn) => fn()).catch(() => undefined);
    };
  }, [refreshSettings]);

  const handleGoogleLogin = async () => {
    setAuthStatus("loading");
    setAuthError("");
    try {
      // This returns immediately — the actual result comes via GoogleLoginEvent
      const result = await (commands as any).cloudLoginGoogle(BACKEND_URL);
      if (result.status === "error") {
        setAuthStatus("error");
        setAuthError(result.error);
      }
      // If ok, we stay in "loading" state until the event arrives
    } catch (e) {
      setAuthStatus("error");
      setAuthError(String(e));
    }
  };

  const handleEmailLogin = async () => {
    if (!email || !password) return;
    setAuthStatus("loading");
    setAuthError("");
    try {
      const result = await (commands as any).cloudLogin(
        BACKEND_URL,
        email.trim(),
        password,
      );
      if (result.status === "ok") {
        setConnectedEmail(result.data.user_email);
        setEmail("");
        setPassword("");
        await refreshSettings();
        setAuthStatus("idle");
      } else {
        setAuthStatus("error");
        setAuthError(result.error);
      }
    } catch (e) {
      setAuthStatus("error");
      setAuthError(String(e));
    }
  };

  const handleEmailRegister = async () => {
    if (!email || !password || !fullName) return;
    if (password !== confirmPassword) {
      setAuthStatus("error");
      setAuthError(t("settings.cloudSync.login.passwordMismatch"));
      return;
    }
    setAuthStatus("loading");
    setAuthError("");
    try {
      const result = await (commands as any).cloudRegister(
        BACKEND_URL,
        email.trim(),
        password,
        fullName.trim(),
      );
      if (result.status === "ok") {
        setConnectedEmail(result.data.user_email);
        setEmail("");
        setPassword("");
        setConfirmPassword("");
        setFullName("");
        await refreshSettings();
        setAuthStatus("idle");
      } else {
        setAuthStatus("error");
        setAuthError(result.error);
      }
    } catch (e) {
      setAuthStatus("error");
      setAuthError(String(e));
    }
  };

  const handleLogout = async () => {
    await updateSetting("cloud_sync_api_key", null);
    await updateSetting("cloud_sync_url", null);
    await updateSetting("cloud_sync_enabled", false);
    setConnectedEmail(null);
    setAuthStatus("idle");
    setAuthError("");
  };

  if (!settings) return null;

  // ─── Connected ────────────────────────────────────────────────
  if (isLoggedIn) {
    return (
      <div className="max-w-3xl w-full mx-auto space-y-6">
        <section className="rounded-xl border border-mid-gray/20 p-5 flex flex-col gap-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-lezat-sage/20 flex items-center justify-center">
                <CheckCircle2 className="w-5 h-5 text-lezat-sage" />
              </div>
              <div>
                <p className="text-sm font-semibold">
                  {t("settings.cloudSync.connected.title")}
                </p>
                <p className="text-xs text-mid-gray">
                  {connectedEmail ?? settings.cloud_sync_url}
                </p>
              </div>
            </div>
            <button
              onClick={handleLogout}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-mid-gray/20 hover:bg-mid-gray/10 transition-colors opacity-60 hover:opacity-100"
            >
              <LogOut className="w-3 h-3" />
              {t("settings.cloudSync.logout")}
            </button>
          </div>
        </section>

        <section className="rounded-xl border border-mid-gray/20 p-5">
          <ToggleSwitch
            checked={settings.cloud_sync_enabled ?? false}
            onChange={(checked) =>
              updateSetting("cloud_sync_enabled", checked)
            }
            label={t("settings.cloudSync.autoSync.title")}
            description={t("settings.cloudSync.autoSync.desc")}
          />
        </section>

        <section className="rounded-xl border border-mid-gray/20 p-5 flex flex-col gap-3">
          <h3 className="text-xs font-bold uppercase tracking-wide text-mid-gray">
            {t("settings.cloudSync.connected.whatYouGet")}
          </h3>
          <div className="grid grid-cols-2 gap-3">
            {FEATURES.map((f) => {
              const Icon = f.icon;
              return (
                <div
                  key={f.titleKey}
                  className="flex items-start gap-2.5 p-3 rounded-lg bg-mid-gray/5"
                >
                  <Icon className="w-4 h-4 mt-0.5 text-lezat-sage shrink-0" />
                  <div>
                    <p className="text-xs font-medium">{t(f.titleKey)}</p>
                    <p className="text-[11px] text-mid-gray leading-relaxed">
                      {t(f.descKey)}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      </div>
    );
  }

  // ─── Not connected ────────────────────────────────────────────
  return (
    <div className="max-w-3xl w-full mx-auto space-y-6">
      {/* Hero */}
      <section className="rounded-xl border border-mid-gray/20 p-6 flex flex-col items-center text-center gap-4">
        <div className="w-14 h-14 rounded-2xl bg-lezat-sage/15 flex items-center justify-center">
          <CloudUpload className="w-7 h-7 text-lezat-sage" />
        </div>
        <div>
          <h2 className="text-lg font-bold">
            {t("settings.cloudSync.onboarding.title")}
          </h2>
          <p className="text-sm text-mid-gray mt-1 max-w-md">
            {t("settings.cloudSync.onboarding.subtitle")}
          </p>
        </div>

        <div className="grid grid-cols-2 gap-3 w-full mt-2">
          {FEATURES.map((f) => {
            const Icon = f.icon;
            return (
              <div
                key={f.titleKey}
                className="flex items-start gap-2.5 p-3 rounded-lg border border-mid-gray/10 text-left"
              >
                <Icon className="w-4 h-4 mt-0.5 text-lezat-sage shrink-0" />
                <div>
                  <p className="text-xs font-medium">{t(f.titleKey)}</p>
                  <p className="text-[11px] text-mid-gray leading-relaxed">
                    {t(f.descKey)}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* Sign in / Register */}
      <section className="rounded-xl border border-mid-gray/20 p-5 flex flex-col gap-4">
        <h3 className="text-sm font-semibold">
          {isRegisterMode
            ? t("settings.cloudSync.login.registerTitle")
            : t("settings.cloudSync.login.title")}
        </h3>

        {/* Google button — primary */}
        {authStatus === "loading" && !showEmailLogin ? (
          <div className="flex flex-col items-center gap-3 py-4">
            <Loader2 className="w-6 h-6 animate-spin text-lezat-sage" />
            <p className="text-sm text-mid-gray">
              {t("settings.cloudSync.login.waitingGoogle")}
            </p>
            <button
              onClick={() => setAuthStatus("idle")}
              className="text-xs text-mid-gray hover:text-red-500 transition-colors"
            >
              {t("settings.cloudSync.login.cancel")}
            </button>
          </div>
        ) : (
          <button
            onClick={handleGoogleLogin}
            disabled={authStatus === "loading"}
            className="flex items-center justify-center gap-3 w-full py-2.5 text-sm font-medium rounded-lg border border-mid-gray/20 hover:bg-mid-gray/5 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            <GoogleIcon className="w-4 h-4" />
            {t("settings.cloudSync.login.google")}
          </button>
        )}

        {/* Divider */}
        <div className="flex items-center gap-3">
          <div className="flex-1 h-px bg-mid-gray/15" />
          <span className="text-[11px] text-mid-gray uppercase tracking-wide">
            {t("settings.cloudSync.login.or")}
          </span>
          <div className="flex-1 h-px bg-mid-gray/15" />
        </div>

        {/* Email form (login or register) */}
        {showEmailLogin ? (
          isRegisterMode ? (
            /* ── Register form ── */
            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium text-mid-gray">
                  {t("settings.cloudSync.login.fullName")}
                </label>
                <Input
                  type="text"
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  placeholder="John Doe"
                  variant="compact"
                  className="w-full"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium text-mid-gray">
                  {t("settings.cloudSync.login.email")}
                </label>
                <Input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@company.com"
                  variant="compact"
                  className="w-full"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium text-mid-gray">
                  {t("settings.cloudSync.login.password")}
                </label>
                <Input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  variant="compact"
                  className="w-full"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium text-mid-gray">
                  {t("settings.cloudSync.login.confirmPassword")}
                </label>
                <Input
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="••••••••"
                  variant="compact"
                  className="w-full"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleEmailRegister();
                  }}
                />
              </div>
              <button
                onClick={handleEmailRegister}
                disabled={
                  authStatus === "loading" ||
                  !email ||
                  !password ||
                  !confirmPassword ||
                  !fullName
                }
                className="flex items-center justify-center gap-2 w-full py-2.5 text-sm font-medium rounded-lg bg-lezat-sage text-[#0d0d1a] hover:bg-lezat-sage/80 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {authStatus === "loading" ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <UserPlus className="w-4 h-4" />
                )}
                {t("settings.cloudSync.login.signUp")}
              </button>
              <p className="text-xs text-center text-mid-gray">
                {t("settings.cloudSync.login.hasAccount")}{" "}
                <button
                  onClick={() => {
                    setIsRegisterMode(false);
                    setAuthError("");
                    setAuthStatus("idle");
                  }}
                  className="text-lezat-sage hover:underline font-medium"
                >
                  {t("settings.cloudSync.login.signInLink")}
                </button>
              </p>
            </div>
          ) : (
            /* ── Login form ── */
            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium text-mid-gray">
                  {t("settings.cloudSync.login.email")}
                </label>
                <Input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@company.com"
                  variant="compact"
                  className="w-full"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium text-mid-gray">
                  {t("settings.cloudSync.login.password")}
                </label>
                <Input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  variant="compact"
                  className="w-full"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleEmailLogin();
                  }}
                />
              </div>
              <button
                onClick={handleEmailLogin}
                disabled={authStatus === "loading" || !email || !password}
                className="flex items-center justify-center gap-2 w-full py-2.5 text-sm font-medium rounded-lg bg-lezat-sage text-[#0d0d1a] hover:bg-lezat-sage/80 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {authStatus === "loading" ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Mail className="w-4 h-4" />
                )}
                {t("settings.cloudSync.login.signIn")}
              </button>
              <p className="text-xs text-center text-mid-gray">
                {t("settings.cloudSync.login.noAccount")}{" "}
                <button
                  onClick={() => {
                    setIsRegisterMode(true);
                    setAuthError("");
                    setAuthStatus("idle");
                  }}
                  className="text-lezat-sage hover:underline font-medium"
                >
                  {t("settings.cloudSync.login.signUpLink")}
                </button>
              </p>
            </div>
          )
        ) : (
          <button
            onClick={() => setShowEmailLogin(true)}
            className="flex items-center justify-center gap-2 w-full py-2.5 text-sm font-medium rounded-lg border border-mid-gray/20 hover:bg-mid-gray/5 transition-colors text-mid-gray"
          >
            <Mail className="w-4 h-4" />
            {t("settings.cloudSync.login.withEmail")}
          </button>
        )}

        {/* Toggle between sign-in and sign-up — always visible */}
        {!showEmailLogin && (
          <p className="text-xs text-center text-mid-gray">
            {isRegisterMode
              ? t("settings.cloudSync.login.hasAccount")
              : t("settings.cloudSync.login.noAccount")}{" "}
            <button
              onClick={() => {
                setIsRegisterMode(!isRegisterMode);
                setShowEmailLogin(true);
                setAuthError("");
                setAuthStatus("idle");
              }}
              className="text-lezat-sage hover:underline font-medium"
            >
              {isRegisterMode
                ? t("settings.cloudSync.login.signInLink")
                : t("settings.cloudSync.login.signUpLink")}
            </button>
          </p>
        )}

        {/* Error */}
        {authStatus === "error" && (
          <div className="flex items-start gap-2 p-3 rounded-lg bg-red-500/10 text-red-500 text-xs">
            <XCircle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>{authError}</span>
          </div>
        )}
      </section>
    </div>
  );
};
