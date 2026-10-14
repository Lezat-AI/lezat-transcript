import { describe, expect, test } from "bun:test";
import {
  canonicalProject,
  groupByProject,
  resolveProject,
} from "../src/components/action-items/projects";

describe("projects", () => {
  test("renamed products show their new name", () => {
    expect(canonicalProject("Wazat")).toBe("BotZat");
    expect(canonicalProject("WaZat")).toBe("BotZat");
    expect(canonicalProject("MediaZat B2C")).toBe("NewsZat");
    expect(canonicalProject("MediaZat B2B")).toBe("MediaZat");
  });

  test("known names keep their spelling, others pass through", () => {
    expect(canonicalProject("botzat")).toBe("BotZat");
    expect(canonicalProject("newszat")).toBe("NewsZat");
    expect(canonicalProject("Teucali")).toBe("Teucalí");
    expect(canonicalProject("Tienda Verde")).toBe("Tienda Verde");
    expect(resolveProject({ project: "  " })).toBeNull();
  });

  test("old and new names group together", () => {
    const groups = groupByProject([
      { id: 1, project: "Wazat" },
      { id: 2, project: "BotZat" },
      { id: 3, project: null },
    ]);
    expect(groups.map((g) => [g.project, g.items.length])).toEqual([
      ["BotZat", 2],
      [null, 1],
    ]);
  });
});
