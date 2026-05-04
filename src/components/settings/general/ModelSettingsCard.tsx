import React from "react";
import { useTranslation } from "react-i18next";
import { SettingsGroup } from "../../ui/SettingsGroup";
import { LanguageSelector } from "../LanguageSelector";
import { TranslateToEnglish } from "../TranslateToEnglish";
import { useModelStore } from "../../../stores/modelStore";
import { useSettings } from "@/hooks/useSettings";
import type { ModelInfo } from "@/bindings";

export const ModelSettingsCard: React.FC = () => {
  const { t } = useTranslation();
  const { currentModel, models } = useModelStore();
  const { settings } = useSettings();

  const isCloudMode =
    (settings as Record<string, unknown> | null)?.transcription_mode ===
      "cloud" &&
    !!settings?.cloud_sync_url &&
    !!settings?.cloud_sync_api_key;

  // In cloud mode, show language selector (sent to backend) without model-specific constraints
  if (isCloudMode) {
    return (
      <SettingsGroup title={t("settings.transcription.languageTitle")}>
        <LanguageSelector
          descriptionMode="tooltip"
          grouped={true}
          supportedLanguages={[]}
        />
      </SettingsGroup>
    );
  }

  const currentModelInfo = models.find((m: ModelInfo) => m.id === currentModel);

  const supportsLanguageSelection =
    currentModelInfo?.supports_language_selection ?? false;
  const supportsTranslation = currentModelInfo?.supports_translation ?? false;
  const hasAnySettings = supportsLanguageSelection || supportsTranslation;

  // Don't render anything if no model is selected or no settings available
  if (!currentModel || !currentModelInfo || !hasAnySettings) {
    return null;
  }

  return (
    <SettingsGroup
      title={t("settings.modelSettings.title", {
        model: currentModelInfo.name,
      })}
    >
      {supportsLanguageSelection && (
        <LanguageSelector
          descriptionMode="tooltip"
          grouped={true}
          supportedLanguages={currentModelInfo.supported_languages}
        />
      )}
      {supportsTranslation && (
        <TranslateToEnglish descriptionMode="tooltip" grouped={true} />
      )}
    </SettingsGroup>
  );
};
