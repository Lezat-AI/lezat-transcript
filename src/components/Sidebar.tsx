import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import { commands } from "@/bindings";
import { Cog, FlaskConical, Heart, History, Info, Library, Sparkles, Cpu, Video } from "lucide-react";
import HandyTextLogo from "./icons/HandyTextLogo";
import HandyHand from "./icons/HandyHand";
import { useSettings } from "../hooks/useSettings";
import {
  GeneralSettings,
  AdvancedSettings,
  HistorySettings,
  DebugSettings,
  AboutSettings,
  PostProcessingSettings,
  ModelsSettings,
} from "./settings";
import MeetingsPage from "./meetings/MeetingsPage";
import LibraryPage from "./library/LibraryPage";
import AcknowledgmentsPage from "./acknowledgments/AcknowledgmentsPage";

export type SidebarSection = keyof typeof SECTIONS_CONFIG;

interface IconProps {
  width?: number | string;
  height?: number | string;
  size?: number | string;
  className?: string;
  [key: string]: any;
}

interface SectionConfig {
  labelKey: string;
  icon: React.ComponentType<IconProps>;
  component: React.ComponentType;
  enabled: (settings: any) => boolean;
}

export const SECTIONS_CONFIG = {
  general: {
    labelKey: "sidebar.general",
    icon: HandyHand,
    component: GeneralSettings,
    enabled: () => true,
  },
  meetings: {
    labelKey: "sidebar.meetings",
    icon: Video,
    component: MeetingsPage,
    enabled: () => true,
  },
  library: {
    labelKey: "sidebar.library",
    icon: Library,
    component: LibraryPage,
    enabled: () => true,
  },
  models: {
    labelKey: "sidebar.models",
    icon: Cpu,
    component: ModelsSettings,
    enabled: () => true,
  },
  advanced: {
    labelKey: "sidebar.advanced",
    icon: Cog,
    component: AdvancedSettings,
    enabled: () => true,
  },
  history: {
    labelKey: "sidebar.history",
    icon: History,
    component: HistorySettings,
    enabled: () => true,
  },
  postprocessing: {
    labelKey: "sidebar.postProcessing",
    icon: Sparkles,
    component: PostProcessingSettings,
    enabled: (settings) => settings?.post_process_enabled ?? false,
  },
  debug: {
    labelKey: "sidebar.debug",
    icon: FlaskConical,
    component: DebugSettings,
    enabled: (settings) => settings?.debug_mode ?? false,
  },
  about: {
    labelKey: "sidebar.about",
    icon: Info,
    component: AboutSettings,
    enabled: () => true,
  },
  acknowledgments: {
    labelKey: "sidebar.acknowledgments",
    icon: Heart,
    component: AcknowledgmentsPage,
    enabled: () => true,
  },
} as const satisfies Record<string, SectionConfig>;

interface SidebarProps {
  activeSection: SidebarSection;
  onSectionChange: (section: SidebarSection) => void;
}

export const Sidebar: React.FC<SidebarProps> = ({
  activeSection,
  onSectionChange,
}) => {
  const { t } = useTranslation();
  const { settings } = useSettings();
  const [meetingActive, setMeetingActive] = useState<boolean>(false);

  // Track whether a meeting is currently recording so the sidebar can surface
  // a pulsing sage indicator next to the Meetings tab. Pulls the initial
  // state on mount and keeps it in sync with meeting-state events.
  useEffect(() => {
    let cancelled = false;
    commands.meetingActive().then((id) => {
      if (!cancelled) setMeetingActive(id != null);
    });
    const p = listen<{ state: string }>("meeting-state-event", (evt) => {
      if (evt.payload.state === "started") setMeetingActive(true);
      else if (evt.payload.state === "stopped" || evt.payload.state === "error")
        setMeetingActive(false);
    });
    return () => {
      cancelled = true;
      p.then((fn) => fn()).catch(() => undefined);
    };
  }, []);

  const availableSections = Object.entries(SECTIONS_CONFIG)
    .filter(([_, config]) => config.enabled(settings))
    .map(([id, config]) => ({ id: id as SidebarSection, ...config }));

  return (
    <div className="flex flex-col w-40 h-full border-e border-mid-gray/20 items-center px-2">
      <HandyTextLogo width={120} className="m-4" />
      <div className="flex flex-col w-full items-center gap-1 pt-2 border-t border-mid-gray/20">
        {availableSections.map((section) => {
          const Icon = section.icon;
          const isActive = activeSection === section.id;

          return (
            <div
              key={section.id}
              className={`flex gap-2 items-center p-2 w-full rounded-lg cursor-pointer transition-colors ${
                isActive
                  ? "bg-lezat-sage text-[#0d0d1a]"
                  : "hover:bg-lezat-sage/15 hover:opacity-100 opacity-85"
              }`}
              onClick={() => onSectionChange(section.id)}
            >
              <Icon width={24} height={24} className="shrink-0" />
              <p
                className="text-sm font-medium truncate"
                title={t(section.labelKey)}
              >
                {t(section.labelKey)}
              </p>
              {section.id === "meetings" && meetingActive && (
                <span
                  className="ml-auto w-2 h-2 rounded-full bg-lezat-sage animate-pulse shrink-0"
                  title="Meeting in progress"
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};
