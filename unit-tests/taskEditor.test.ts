import { describe, expect, test } from "bun:test";
import {
  applyEdits,
  draftEdits,
  draftProblem,
  isDraftDirty,
  makeDraft,
} from "../src/components/action-items/TaskEditor";
import type { CloudActionItem } from "../src/components/action-items/shared";

const task: CloudActionItem = {
  id: "t1",
  meeting_id: "m1",
  meeting_title: "Weekly",
  title: "Coordinar la entrega de WealthZat",
  description: "Con Felipe",
  assignee: null,
  due_date: "2026-10-24",
  task_type: "pending",
  status: "pending_review",
  synced_to: [],
  created_at: null,
};

describe("task title editing", () => {
  test("a reworded title is sent, trimmed, and shown after saving", () => {
    const draft = { ...makeDraft(task, []), title: "  Entregar la B1 de WealthZat a Felipe " };
    expect(isDraftDirty(draft, task, [])).toBe(true);
    const edits = draftEdits(draft, task);
    expect(edits).toEqual({ title: "Entregar la B1 de WealthZat a Felipe" });
    expect(applyEdits(task, edits).title).toBe("Entregar la B1 de WealthZat a Felipe");
  });

  test("an untouched title is not sent", () => {
    expect(draftEdits(makeDraft(task, []), task)).toEqual({});
  });

  test("the title can't be cleared", () => {
    const draft = { ...makeDraft(task, []), title: "   " };
    expect(draftProblem(draft, task)).toBe("actionItems.edit.titleRequired");
    expect(draftEdits(draft, task).title).toBeUndefined();
  });

  test("an old task without a title only needs its description", () => {
    const old = { ...task, title: null };
    const draft = makeDraft(old, []);
    expect(draftProblem(draft, old)).toBeNull();
    expect(draftProblem({ ...draft, description: "" }, old)).toBe(
      "actionItems.edit.descriptionRequired",
    );
  });
});
