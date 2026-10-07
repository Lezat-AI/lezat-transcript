import React, { useState, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Loader2 } from "lucide-react";
import { ProgressBar } from "../shared";
import { useSettings } from "../../hooks/useSettings";
import { commands } from "../../bindings";

interface UpdateCheckerProps {
  className?: string;
}

/// Re-check for updates while the app stays open (it lives in the tray for
/// days), so a mandatory release reaches people who never restart it.
const PERIODIC_CHECK_MS = 4 * 60 * 60 * 1000;
/// While a meeting is recording, a mandatory install waits and retries.
const MEETING_RETRY_MS = 30 * 1000;

/// Numeric compare of "x.y.z" versions (pre-release suffixes ignored).
function compareVersions(a: string, b: string): number {
  const parts = (v: string) =>
    v
      .replace(/^v/, "")
      .split("-")[0]
      .split(".")
      .map((n) => parseInt(n, 10) || 0);
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/// latest.json may carry `min_version` (oldest version still allowed) or
/// `mandatory: true`. Either makes the update install without asking.
function isMandatoryUpdate(update: Update): boolean {
  const raw = update.rawJson ?? {};
  if (raw.mandatory === true) return true;
  const minVersion = raw.min_version;
  return (
    typeof minVersion === "string" &&
    compareVersions(update.currentVersion, minVersion) < 0
  );
}

const UpdateChecker: React.FC<UpdateCheckerProps> = ({ className = "" }) => {
  const { t } = useTranslation();
  // Update checking state
  const [isChecking, setIsChecking] = useState(false);
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [isInstalling, setIsInstalling] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [showUpToDate, setShowUpToDate] = useState(false);
  const [showPortableUpdateDialog, setShowPortableUpdateDialog] =
    useState(false);
  // Version of a mandatory update being forced, if any.
  const [mandatoryVersion, setMandatoryVersion] = useState<string | null>(null);
  const [waitingForMeeting, setWaitingForMeeting] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);
  const mandatoryRetryRef = useRef<ReturnType<typeof setTimeout>>();
  // Ref, not state: periodic checks and retries run from stale closures.
  const installingRef = useRef(false);

  const { settings, isLoading } = useSettings();
  const settingsLoaded = !isLoading && settings !== null;
  const updateChecksEnabled = settings?.update_checks_enabled ?? false;

  const upToDateTimeoutRef = useRef<ReturnType<typeof setTimeout>>();
  const isManualCheckRef = useRef(false);
  const downloadedBytesRef = useRef(0);
  const contentLengthRef = useRef(0);

  useEffect(() => {
    // Wait for settings to load before doing anything
    if (!settingsLoaded) return;

    if (!updateChecksEnabled) {
      if (upToDateTimeoutRef.current) {
        clearTimeout(upToDateTimeoutRef.current);
      }
      setIsChecking(false);
      setUpdateAvailable(false);
      setShowUpToDate(false);
      return;
    }

    checkForUpdates();
    const periodic = setInterval(() => checkForUpdates(), PERIODIC_CHECK_MS);

    // Listen for update check events
    const updateUnlisten = listen("check-for-updates", () => {
      handleManualUpdateCheck();
    });

    return () => {
      if (upToDateTimeoutRef.current) {
        clearTimeout(upToDateTimeoutRef.current);
      }
      if (mandatoryRetryRef.current) {
        clearTimeout(mandatoryRetryRef.current);
      }
      clearInterval(periodic);
      updateUnlisten.then((fn) => fn());
    };
  }, [settingsLoaded, updateChecksEnabled]);

  // Update checking functions
  const checkForUpdates = async () => {
    if (!updateChecksEnabled || isChecking) return;

    try {
      setIsChecking(true);
      const update = await check();

      if (update) {
        setUpdateAvailable(true);
        setShowUpToDate(false);
        if (isMandatoryUpdate(update)) {
          setMandatoryVersion(update.version);
          void installMandatoryUpdate();
        }
      } else {
        setUpdateAvailable(false);

        if (isManualCheckRef.current) {
          setShowUpToDate(true);
          if (upToDateTimeoutRef.current) {
            clearTimeout(upToDateTimeoutRef.current);
          }
          upToDateTimeoutRef.current = setTimeout(() => {
            setShowUpToDate(false);
          }, 3000);
        }
      }
    } catch (error) {
      console.error("Failed to check for updates:", error);
    } finally {
      setIsChecking(false);
      isManualCheckRef.current = false;
    }
  };

  const handleManualUpdateCheck = () => {
    if (!updateChecksEnabled) return;
    isManualCheckRef.current = true;
    checkForUpdates();
  };

  /// Install a mandatory update right away, unless a meeting is being
  /// recorded: relaunching would cut it, so wait for it to end.
  const installMandatoryUpdate = async () => {
    if (mandatoryRetryRef.current) {
      clearTimeout(mandatoryRetryRef.current);
      mandatoryRetryRef.current = undefined;
    }
    let meetingActive = false;
    try {
      meetingActive = (await commands.meetingActive()) != null;
    } catch {
      meetingActive = false;
    }
    if (meetingActive) {
      setWaitingForMeeting(true);
      mandatoryRetryRef.current = setTimeout(
        () => void installMandatoryUpdate(),
        MEETING_RETRY_MS,
      );
      return;
    }
    setWaitingForMeeting(false);
    await installUpdate();
  };

  const installUpdate = async () => {
    if (!updateChecksEnabled || installingRef.current) return;
    installingRef.current = true;
    setInstallError(null);

    // Flip the busy flag *synchronously* before any `await` so rapid
    // clicks during the portable/check roundtrip can't re-enter this
    // handler. Reset on the portable branch.
    setIsInstalling(true);
    setDownloadProgress(0);
    downloadedBytesRef.current = 0;
    contentLengthRef.current = 0;

    try {
      const portable = await commands.isPortable();
      if (portable) {
        setShowPortableUpdateDialog(true);
        setIsInstalling(false);
        installingRef.current = false;
        return;
      }

      const update = await check();

      if (!update) {
        console.log("No update available during install attempt");
        return;
      }

      await update.downloadAndInstall((event) => {
        switch (event.event) {
          case "Started":
            downloadedBytesRef.current = 0;
            contentLengthRef.current = event.data.contentLength ?? 0;
            break;
          case "Progress":
            downloadedBytesRef.current += event.data.chunkLength;
            const progress =
              contentLengthRef.current > 0
                ? Math.round(
                    (downloadedBytesRef.current / contentLengthRef.current) *
                      100,
                  )
                : 0;
            setDownloadProgress(Math.min(progress, 100));
            break;
          case "Finished":
            setDownloadProgress(100);
            break;
        }
      });
      await relaunch();
    } catch (error) {
      console.error("Failed to install update:", error);
      setInstallError(String(error));
    } finally {
      installingRef.current = false;
      setIsInstalling(false);
      setDownloadProgress(0);
      downloadedBytesRef.current = 0;
      contentLengthRef.current = 0;
    }
  };

  // Update status functions
  const getUpdateStatusText = () => {
    if (!updateChecksEnabled) {
      return t("footer.updateCheckingDisabled");
    }
    if (isInstalling) {
      if (downloadProgress === 100) return t("footer.installing");
      if (downloadProgress > 0)
        return t("footer.downloading", {
          progress: downloadProgress.toString().padStart(3),
        });
      return t("footer.preparing");
    }
    if (isChecking) return t("footer.checkingUpdates");
    if (showUpToDate) return t("footer.upToDate");
    if (updateAvailable) return t("footer.updateAvailableShort");
    return t("footer.checkForUpdates");
  };

  // A progress bar is visible the whole time we're installing — at 0% during
  // "preparing" (head request, signature fetch) so the user gets an immediate
  // "something is happening" cue instead of a silent button-label change.
  const shouldShowProgress = isInstalling;

  const getUpdateStatusAction = () => {
    if (!updateChecksEnabled) return undefined;
    if (updateAvailable && !isInstalling) return installUpdate;
    if (!isChecking && !isInstalling && !updateAvailable)
      return handleManualUpdateCheck;
    return undefined;
  };

  const isUpdateDisabled = !updateChecksEnabled || isChecking || isInstalling;
  const isUpdateClickable =
    !isUpdateDisabled && (updateAvailable || (!isChecking && !showUpToDate));

  return (
    <>
      {mandatoryVersion && waitingForMeeting && (
        <div className="fixed bottom-4 right-4 z-50 max-w-sm rounded-lg border border-amber-500/40 bg-bg shadow-lg p-3 text-sm space-y-1">
          <p className="font-semibold">{t("footer.mandatoryUpdateTitle")}</p>
          <p className="text-amber-500">
            {t("footer.mandatoryUpdateWaitingMeeting")}
          </p>
        </div>
      )}
      {mandatoryVersion && !waitingForMeeting && !showPortableUpdateDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="bg-bg border border-border rounded-lg p-6 max-w-md w-full mx-4 space-y-4">
            <h2 className="text-base font-semibold">
              {t("footer.mandatoryUpdateTitle")}
            </h2>
            <p className="text-sm text-text/70">
              {t("footer.mandatoryUpdateMessage", {
                version: mandatoryVersion,
              })}
            </p>
            {isInstalling && (
              <div className="space-y-1">
                <p className="text-xs text-text/60 tabular-nums">
                  {getUpdateStatusText()}
                </p>
                <ProgressBar
                  progress={[
                    { id: "mandatory-update", percentage: downloadProgress },
                  ]}
                  size="large"
                />
              </div>
            )}
            {installError && !isInstalling && (
              <div className="space-y-2">
                <p className="text-sm text-red-500 break-words">
                  {t("footer.mandatoryUpdateFailed", { error: installError })}
                </p>
                <div className="flex justify-end">
                  <button
                    className="px-3 py-1.5 text-sm rounded bg-logo-primary text-background hover:bg-logo-primary/80 transition-colors"
                    onClick={() => void installMandatoryUpdate()}
                  >
                    {t("footer.mandatoryUpdateRetry")}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
      {showPortableUpdateDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-bg border border-border rounded-lg p-6 max-w-md w-full mx-4 space-y-4">
            <h2 className="text-base font-semibold">
              {t("footer.portableUpdateTitle")}
            </h2>
            <p className="text-sm text-text/70">
              {t("footer.portableUpdateMessage")}
            </p>
            <div className="flex gap-2 justify-end">
              <button
                className="px-3 py-1.5 text-sm rounded border border-border hover:bg-border/50 transition-colors"
                onClick={() => setShowPortableUpdateDialog(false)}
              >
                {t("common.close")}
              </button>
              <button
                className="px-3 py-1.5 text-sm rounded bg-logo-primary text-background hover:bg-logo-primary/80 transition-colors"
                onClick={() => {
                  openUrl("https://lezat.co");
                  setShowPortableUpdateDialog(false);
                }}
              >
                {t("footer.portableUpdateButton")}
              </button>
            </div>
          </div>
        </div>
      )}
      <div className={`flex items-center gap-3 ${className}`}>
        {isUpdateClickable ? (
          <button
            onClick={getUpdateStatusAction()}
            disabled={isUpdateDisabled}
            className={`transition-colors disabled:opacity-50 tabular-nums flex items-center gap-1.5 ${
              updateAvailable
                ? "text-logo-primary hover:text-logo-primary/80 font-medium"
                : "text-text/60 hover:text-text/80"
            }`}
          >
            {(isInstalling || isChecking) && (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            )}
            {getUpdateStatusText()}
          </button>
        ) : (
          <span className="text-text/60 tabular-nums flex items-center gap-1.5">
            {(isInstalling || isChecking) && (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            )}
            {getUpdateStatusText()}
          </span>
        )}

        {shouldShowProgress && (
          <ProgressBar
            progress={[
              {
                id: "update",
                percentage: downloadProgress,
              },
            ]}
            size="large"
          />
        )}
      </div>
    </>
  );
};

export default UpdateChecker;
