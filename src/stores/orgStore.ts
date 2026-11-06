import { create } from "zustand";
import { commands } from "@/bindings";
import { setKnownProjects } from "@/components/action-items/projects";

export type OrgRole = "owner" | "admin" | "member";

/** Owners and admins may edit the org's projects and glossary; members are read-only. */
export function canEditOrg(role: OrgRole): boolean {
  return role === "owner" || role === "admin";
}

function normalizeRole(value: string): OrgRole {
  return value === "owner" || value === "admin" ? value : "member";
}

interface OrgStore {
  projects: string[];
  glossary: string[];
  role: OrgRole;
  roleLoaded: boolean;
  loadingProjects: boolean;
  loadingGlossary: boolean;
  loadingRole: boolean;
  /** A write (add/delete) is in flight. */
  mutating: boolean;
  projectsError: string | null;
  glossaryError: string | null;

  loadRole: () => Promise<void>;
  loadProjects: () => Promise<void>;
  loadGlossary: () => Promise<void>;
  addProject: (name: string) => Promise<boolean>;
  removeProject: (name: string) => Promise<boolean>;
  addTerm: (term: string) => Promise<boolean>;
  removeTerm: (term: string) => Promise<boolean>;
}

export const useOrgStore = create<OrgStore>((set, get) => ({
  projects: [],
  glossary: [],
  role: "member",
  roleLoaded: false,
  loadingProjects: false,
  loadingGlossary: false,
  loadingRole: false,
  mutating: false,
  projectsError: null,
  glossaryError: null,

  loadRole: async () => {
    set({ loadingRole: true });
    try {
      const r = await commands.cloudGetOrgRole();
      if (r.status === "ok") {
        set({ role: normalizeRole(r.data.org_role), roleLoaded: true });
      } else {
        // Unknown role → treat as read-only member.
        set({ role: "member", roleLoaded: true });
      }
    } catch {
      set({ role: "member", roleLoaded: true });
    } finally {
      set({ loadingRole: false });
    }
  },

  loadProjects: async () => {
    set({ loadingProjects: true, projectsError: null });
    try {
      const r = await commands.cloudGetOrgProjects();
      if (r.status === "ok") {
        const projects = [...r.data.projects].sort((a, b) =>
          a.localeCompare(b, "es"),
        );
        setKnownProjects(projects);
        set({ projects });
      } else {
        // Fallback to empty (NOT a hardcoded list) so non-Lezat orgs show "no project".
        setKnownProjects([]);
        set({ projects: [], projectsError: r.error });
      }
    } catch (e) {
      setKnownProjects([]);
      set({ projects: [], projectsError: String(e) });
    } finally {
      set({ loadingProjects: false });
    }
  },

  loadGlossary: async () => {
    set({ loadingGlossary: true, glossaryError: null });
    try {
      const r = await commands.cloudGetOrgGlossary();
      if (r.status === "ok") {
        const terms = [...r.data.terms].sort((a, b) => a.localeCompare(b, "es"));
        set({ glossary: terms });
      } else {
        set({ glossary: [], glossaryError: r.error });
      }
    } catch (e) {
      set({ glossary: [], glossaryError: String(e) });
    } finally {
      set({ loadingGlossary: false });
    }
  },

  addProject: async (name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return false;
    set({ mutating: true, projectsError: null });
    try {
      const r = await commands.cloudAddOrgProject(trimmed);
      if (r.status === "ok") {
        const projects = [...r.data.projects].sort((a, b) =>
          a.localeCompare(b, "es"),
        );
        setKnownProjects(projects);
        set({ projects });
        return true;
      }
      set({ projectsError: r.error });
      return false;
    } catch (e) {
      set({ projectsError: String(e) });
      return false;
    } finally {
      set({ mutating: false });
    }
  },

  removeProject: async (name: string) => {
    set({ mutating: true, projectsError: null });
    try {
      const r = await commands.cloudDeleteOrgProject(name);
      if (r.status === "ok") {
        const projects = [...r.data.projects].sort((a, b) =>
          a.localeCompare(b, "es"),
        );
        setKnownProjects(projects);
        set({ projects });
        return true;
      }
      set({ projectsError: r.error });
      return false;
    } catch (e) {
      set({ projectsError: String(e) });
      return false;
    } finally {
      set({ mutating: false });
    }
  },

  addTerm: async (term: string) => {
    const trimmed = term.trim();
    if (!trimmed) return false;
    set({ mutating: true, glossaryError: null });
    try {
      const r = await commands.cloudAddOrgGlossary(trimmed);
      if (r.status === "ok") {
        const terms = [...r.data.terms].sort((a, b) => a.localeCompare(b, "es"));
        set({ glossary: terms });
        return true;
      }
      set({ glossaryError: r.error });
      return false;
    } catch (e) {
      set({ glossaryError: String(e) });
      return false;
    } finally {
      set({ mutating: false });
    }
  },

  removeTerm: async (term: string) => {
    set({ mutating: true, glossaryError: null });
    try {
      const r = await commands.cloudDeleteOrgGlossary(term);
      if (r.status === "ok") {
        const terms = [...r.data.terms].sort((a, b) => a.localeCompare(b, "es"));
        set({ glossary: terms });
        return true;
      }
      set({ glossaryError: r.error });
      return false;
    } catch (e) {
      set({ glossaryError: String(e) });
      return false;
    } finally {
      set({ mutating: false });
    }
  },
}));
