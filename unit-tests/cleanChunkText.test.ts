// Run with: bun test unit-tests
import { describe, expect, test } from "bun:test";
import { cleanChunkText } from "../src/components/meetings/MeetingTranscriptView";

describe("cleanChunkText", () => {
  test("keeps only the text of a raw JSON answer", () => {
    expect(
      cleanChunkText('{"text": "Hola, Diego.", "language_detected": "es"}'),
    ).toBe("Hola, Diego.");
  });

  test("decodes unicode escapes of a malformed answer", () => {
    // A broken escape (\u00tos) makes JSON.parse fail; the rest must still
    // read as plain text instead of "¿".
    const raw =
      '{"text": "\\u00bfcu\\u00e1ntos costos? \\u00c9l, \\u00tos y m\\u00e1s", "language_detected": "es"}';
    expect(cleanChunkText(raw)).toBe("¿cuántos costos? Él, \\u00tos y más");
  });

  test("leaves normal text alone", () => {
    expect(cleanChunkText("Hola {equipo}")).toBe("Hola {equipo}");
  });
});
