import React, { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { getVersion } from "@tauri-apps/api/app";
import { Cloud } from "lucide-react";

import ModelSelector from "../model-selector";
import UpdateChecker from "../update-checker";
import { useSettings } from "@/hooks/useSettings";

const Footer: React.FC = () => {
  const { t } = useTranslation();
  const [version, setVersion] = useState("");
  const { settings } = useSettings();

  const isCloudMode =
    (settings as Record<string, unknown> | null)?.transcription_mode ===
      "cloud" &&
    !!settings?.cloud_sync_url &&
    !!settings?.cloud_sync_api_key;

  useEffect(() => {
    const fetchVersion = async () => {
      try {
        const appVersion = await getVersion();
        setVersion(appVersion);
      } catch (error) {
        console.error("Failed to get app version:", error);
        setVersion("0.1.2");
      }
    };

    fetchVersion();
  }, []);

  return (
    <div className="w-full border-t border-mid-gray/20 pt-3">
      <div className="flex justify-between items-center text-xs px-4 pb-3 text-text/60">
        <div className="flex items-center gap-4">
          {isCloudMode ? (
            <div className="flex items-center gap-1.5 text-lezat-sage font-medium">
              <Cloud className="w-3.5 h-3.5" />
              <span>{t("settings.transcription.mode.cloud")}</span>
            </div>
          ) : (
            <ModelSelector />
          )}
        </div>

        {/* Update Status */}
        <div className="flex items-center gap-1">
          <UpdateChecker />
          <span>•</span>
          {/* eslint-disable-next-line i18next/no-literal-string */}
          <span>v{version}</span>
        </div>
      </div>
    </div>
  );
};

export default Footer;
