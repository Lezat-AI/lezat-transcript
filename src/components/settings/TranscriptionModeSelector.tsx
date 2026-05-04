import React from "react";
import { useTranslation } from "react-i18next";
import { useSettings } from "@/hooks/useSettings";
import { Cloud, Cpu } from "lucide-react";

export const TranscriptionModeSelector: React.FC = () => {
  const { t } = useTranslation();
  const { settings, updateSetting } = useSettings();

  if (!settings) return null;

  const isCloudAvailable = !!(
    settings.cloud_sync_url && settings.cloud_sync_api_key
  );
  const currentMode =
    (settings as Record<string, unknown>).transcription_mode ?? "cloud";

  return (
    <div className="flex flex-col gap-2">
      <label className="text-xs font-semibold text-mid-gray uppercase tracking-wide">
        {t("settings.transcription.mode.title")}
      </label>
      <div className="grid grid-cols-2 gap-2">
        <button
          onClick={() => updateSetting("transcription_mode" as any, "cloud")}
          disabled={!isCloudAvailable}
          className={`flex items-center gap-3 p-3 rounded-lg border text-sm font-medium transition-colors text-left ${
            currentMode === "cloud"
              ? "border-lezat-sage bg-lezat-sage/10 text-lezat-sage"
              : "border-neutral-200 dark:border-neutral-700 hover:bg-neutral-50 dark:hover:bg-neutral-800"
          } ${!isCloudAvailable ? "opacity-40 cursor-not-allowed" : "cursor-pointer"}`}
        >
          <Cloud className="w-5 h-5 shrink-0" />
          <div>
            <p>{t("settings.transcription.mode.cloud")}</p>
            <p className="text-[11px] text-mid-gray font-normal mt-0.5">
              {t("settings.transcription.mode.cloudDesc")}
            </p>
          </div>
        </button>
        <button
          onClick={() => updateSetting("transcription_mode" as any, "local")}
          className={`flex items-center gap-3 p-3 rounded-lg border text-sm font-medium transition-colors text-left cursor-pointer ${
            currentMode === "local"
              ? "border-lezat-sage bg-lezat-sage/10 text-lezat-sage"
              : "border-neutral-200 dark:border-neutral-700 hover:bg-neutral-50 dark:hover:bg-neutral-800"
          }`}
        >
          <Cpu className="w-5 h-5 shrink-0" />
          <div>
            <p>{t("settings.transcription.mode.local")}</p>
            <p className="text-[11px] text-mid-gray font-normal mt-0.5">
              {t("settings.transcription.mode.localDesc")}
            </p>
          </div>
        </button>
      </div>
      {!isCloudAvailable && (
        <p className="text-[11px] text-mid-gray">
          {t("settings.transcription.mode.cloudUnavailable")}
        </p>
      )}
    </div>
  );
};
