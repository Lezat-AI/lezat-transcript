import { describe, expect, test } from "bun:test";
import {
  applyEdits,
  draftEdits,
  isDraftDirty,
  makeDraft,
} from "../src/components/action-items/TaskEditor";
import type { CloudActionItem } from "../src/components/action-items/shared";

const task: CloudActionItem = {
  id: "t1",
  meeting_id: "m1",
  meeting_title: "Weekly",
  title: "Realizar demo de BotZat para Ana Tamayo",
  description: null,
  assignee: null,
  due_date: null,
  task_type: "pending",
  status: "pending_review",
  synced_to: [],
  created_at: null,
  work_type: "vender",
};

describe("task work type", () => {
  test("the draft starts from the saved type", () => {
    expect(makeDraft(task, []).work_type).toBe("vender");
    expect(makeDraft({ ...task, work_type: null }, []).work_type).toBe("");
  });

  test("a changed type is sent and shown after saving", () => {
    const draft = { ...makeDraft(task, []), work_type: "qa" };
    expect(isDraftDirty(draft, task, [])).toBe(true);
    const edits = draftEdits(draft, task);
    expect(edits).toEqual({ work_type: "qa" });
    expect(applyEdits(task, edits).work_type).toBe("qa");
  });

  test("clearing the type sends an empty value", () => {
    const edits = draftEdits({ ...makeDraft(task, []), work_type: "" }, task);
    expect(edits).toEqual({ work_type: "" });
    expect(applyEdits(task, edits).work_type).toBeNull();
  });

  test("an untouched type is not sent", () => {
    expect(draftEdits(makeDraft(task, []), task)).toEqual({});
  });
});
