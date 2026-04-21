import React, { useEffect, useState } from "react";
import { useSettings } from "../../hooks/useSettings";
import { commands } from "@/bindings";
import { SettingContainer } from "../ui/SettingContainer";
import { Textarea } from "../ui/Textarea";

interface TranscriptionPromptProps {
  descriptionMode?: "inline" | "tooltip";
  grouped?: boolean;
}

const PLACEHOLDER =
  "e.g. Transcripción profesional en español de una reunión de trabajo.";

/**
 * Free-form initial prompt passed to Whisper before each transcription.
 * Useful to bias toward a language and domain — especially for Spanish, where
 * a one-liner context hint noticeably improves accent handling and
 * punctuation.
 */
export const TranscriptionPrompt: React.FC<TranscriptionPromptProps> = ({
  descriptionMode = "tooltip",
  grouped = false,
}) => {
  const { getSetting, updateSetting } = useSettings();
  const stored = getSetting("transcription_initial_prompt") || "";
  const [draft, setDraft] = useState(stored);

  useEffect(() => {
    setDraft(stored);
  }, [stored]);

  const commit = async () => {
    if (draft === stored) return;
    const next = draft.trim() || null;
    try {
      await commands.changeTranscriptionInitialPromptSetting(next);
      updateSetting("transcription_initial_prompt", next);
    } catch (e) {
      console.warn("changeTranscriptionInitialPromptSetting failed", e);
    }
  };

  return (
    <SettingContainer
      title="Transcription context prompt"
      description="Short hint passed to Whisper before every transcription — bias language, domain, or tone. Leave blank for neutral auto-detect."
      descriptionMode={descriptionMode}
      grouped={grouped}
      layout="stacked"
    >
      <Textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        placeholder={PLACEHOLDER}
        rows={2}
        className="w-full"
      />
    </SettingContainer>
  );
};
