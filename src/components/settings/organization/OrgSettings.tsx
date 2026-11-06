import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { X, Loader2, AlertCircle } from "lucide-react";
import { Input } from "../../ui/Input";
import { Button } from "../../ui/Button";
import { SettingsGroup } from "../../ui/SettingsGroup";
import { useOrgStore, canEditOrg } from "@/stores/orgStore";

interface CrudListProps {
  title: string;
  description: string;
  placeholder: string;
  addLabel: string;
  emptyLabel: string;
  items: string[];
  loading: boolean;
  error: string | null;
  canEdit: boolean;
  mutating: boolean;
  onAdd: (value: string) => Promise<boolean>;
  onRemove: (value: string) => void;
  removeLabel: (value: string) => string;
}

/** A titled list with an inline add field and a per-row delete (x). */
const CrudList: React.FC<CrudListProps> = ({
  title,
  description,
  placeholder,
  addLabel,
  emptyLabel,
  items,
  loading,
  error,
  canEdit,
  mutating,
  onAdd,
  onRemove,
  removeLabel,
}) => {
  const [value, setValue] = useState("");

  const handleAdd = async () => {
    const trimmed = value.trim();
    if (!trimmed) return;
    const ok = await onAdd(trimmed);
    if (ok) setValue("");
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void handleAdd();
    }
  };

  return (
    <SettingsGroup title={title} description={description}>
      <div className="p-4 flex flex-col gap-3">
        {canEdit && (
          <div className="flex items-center gap-2">
            <Input
              type="text"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={placeholder}
              variant="compact"
              className="flex-1"
              disabled={mutating}
            />
            <Button
              onClick={handleAdd}
              disabled={!value.trim() || mutating}
              variant="primary"
              size="md"
            >
              {mutating ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                addLabel
              )}
            </Button>
          </div>
        )}

        {error && (
          <p className="text-xs text-red-500 flex items-start gap-1.5">
            <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-px" />
            {error}
          </p>
        )}

        {loading ? (
          <div className="flex items-center justify-center py-4">
            <Loader2 className="w-4 h-4 animate-spin opacity-50" />
          </div>
        ) : items.length === 0 ? (
          <p className="text-xs text-mid-gray py-1">{emptyLabel}</p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {items.map((item) => (
              <span
                key={item}
                className="inline-flex items-center gap-1 pl-2.5 pr-1 py-1 rounded-full bg-mid-gray/10 text-xs"
              >
                <span>{item}</span>
                {canEdit && (
                  <button
                    type="button"
                    onClick={() => onRemove(item)}
                    disabled={mutating}
                    aria-label={removeLabel(item)}
                    title={removeLabel(item)}
                    className="p-0.5 rounded-full hover:bg-red-500/20 hover:text-red-500 disabled:opacity-40 transition-colors"
                  >
                    <X className="w-3 h-3" />
                  </button>
                )}
              </span>
            ))}
          </div>
        )}
      </div>
    </SettingsGroup>
  );
};

export const OrgSettings: React.FC = () => {
  const { t } = useTranslation();
  const {
    projects,
    glossary,
    role,
    loadingProjects,
    loadingGlossary,
    mutating,
    projectsError,
    glossaryError,
    loadRole,
    loadProjects,
    loadGlossary,
    addProject,
    removeProject,
    addTerm,
    removeTerm,
  } = useOrgStore();

  useEffect(() => {
    void loadRole();
    void loadProjects();
    void loadGlossary();
  }, [loadRole, loadProjects, loadGlossary]);

  const canEdit = canEditOrg(role);

  return (
    <div className="max-w-3xl w-full mx-auto space-y-6">
      <div className="px-4">
        <h1 className="text-lg font-semibold">{t("settings.organization.title")}</h1>
        <p className="text-sm text-mid-gray mt-1">
          {t("settings.organization.description")}
        </p>
        {!canEdit && (
          <p className="text-xs text-mid-gray mt-2 flex items-center gap-1.5">
            <AlertCircle className="w-3.5 h-3.5 shrink-0" />
            {t("settings.organization.readOnly")}
          </p>
        )}
      </div>

      <CrudList
        title={t("settings.organization.projects.title")}
        description={t("settings.organization.projects.description")}
        placeholder={t("settings.organization.projects.placeholder")}
        addLabel={t("settings.organization.projects.add")}
        emptyLabel={t("settings.organization.projects.empty")}
        items={projects}
        loading={loadingProjects}
        error={projectsError}
        canEdit={canEdit}
        mutating={mutating}
        onAdd={addProject}
        onRemove={removeProject}
        removeLabel={(name) =>
          t("settings.organization.projects.remove", { name })
        }
      />

      <CrudList
        title={t("settings.organization.glossary.title")}
        description={t("settings.organization.glossary.description")}
        placeholder={t("settings.organization.glossary.placeholder")}
        addLabel={t("settings.organization.glossary.add")}
        emptyLabel={t("settings.organization.glossary.empty")}
        items={glossary}
        loading={loadingGlossary}
        error={glossaryError}
        canEdit={canEdit}
        mutating={mutating}
        onAdd={addTerm}
        onRemove={removeTerm}
        removeLabel={(term) =>
          t("settings.organization.glossary.remove", { term })
        }
      />
    </div>
  );
};
