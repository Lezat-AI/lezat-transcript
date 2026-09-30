// Run with: bun test unit-tests
import { describe, expect, test } from "bun:test";
import { removeMicEcho } from "../src/lib/echoFilter";

const mic = (offset_ms: number, text: string) => ({
  offset_ms,
  source: "mic",
  text,
});
const sys = (offset_ms: number, text: string) => ({
  offset_ms,
  source: "system",
  text,
});

describe("removeMicEcho", () => {
  test("drops a mic chunk that only repeats the system audio", () => {
    const r = removeMicEcho([
      sys(60555, "Cuéntanos mientras que se une Diego. Todo muy bien, Dani."),
      mic(
        60522,
        "Nos cuéntanos mientras que se une Diegui. Todo muy bien, Dani.",
      ),
    ]);
    expect(r.removedChunks).toBe(1);
    expect(r.chunks.map((c) => c.source)).toEqual(["system"]);
  });

  test("keeps the user's own words in a chunk that also has echo", () => {
    const r = removeMicEcho([
      sys(
        36325,
        "Hola, ¿qué tal? Buenos días. Muy bien, muy bien. ¿Cómo andan ustedes?",
      ),
      mic(
        36339,
        "Hola, buen día. ¿Cómo están? Hola, equipo. Muy bien, muy bien. ¿Cómo andan ustedes?",
      ),
    ]);
    expect(r.trimmedChunks).toBe(1);
    const kept = r.chunks.find((c) => c.source === "mic");
    expect(kept?.text).toBe("Hola, buen día. ¿Cómo están? Hola, equipo.");
  });

  test("never touches mic speech the system audio did not say", () => {
    const chunks = [
      sys(0, "Sí, sí, sí, desde ya para que lo pueda"),
      mic(0, "Para iniciar esta reunión en el transcriptor. Toma, sí."),
    ];
    const r = removeMicEcho(chunks);
    expect(r.chunks).toEqual(chunks);
    expect(r.removedChunks + r.trimmedChunks).toBe(0);
  });

  test("short shared phrases are not treated as echo", () => {
    const chunks = [
      sys(0, "Perfecto, muy bien, seguimos con el siguiente punto"),
      mic(0, "Sí, muy bien, gracias a todos por venir hoy"),
    ];
    expect(removeMicEcho(chunks).chunks).toEqual(chunks);
  });

  test("ignores system chunks far away in time", () => {
    const text =
      "les doy un poco de contexto sobre la compañía y lo que hacemos";
    const chunks = [sys(0, text), mic(120_000, text)];
    expect(removeMicEcho(chunks).chunks).toEqual(chunks);
  });

  test("matches echo straddling the next system chunk", () => {
    const r = removeMicEcho([
      sys(12_000, "uno dos tres cuatro palabras al final del bloque"),
      sys(24_000, "y esto sigue en el siguiente bloque de audio"),
      mic(13_500, "palabras al final del bloque y esto sigue en el siguiente"),
    ]);
    expect(r.removedChunks).toBe(1);
  });

  test("numbers written as digits or words still match", () => {
    const r = removeMicEcho([
      sys(
        0,
        "un microcrédito de tres, cuatro, 5 millones que se gastó en 5 minutos",
      ),
      mic(
        0,
        "un microcrédito de tres, cuatro, cinco millones que se gastó en cinco minutos",
      ),
    ]);
    expect(r.removedChunks).toBe(1);
  });

  test("without system audio nothing changes", () => {
    const chunks = [mic(0, "hola a todos"), mic(12_000, "seguimos")];
    expect(removeMicEcho(chunks).chunks).toBe(chunks);
  });
  test("the user repeating the other person later is not echo", () => {
    const chunks = [
      sys(
        36000,
        "Perfecto Angel. Entonces tú me mandas la propuesta comercial de PeopleZat el viernes, ¿listo?",
      ),
      mic(
        48000,
        "Sí, yo te mando la propuesta comercial de PeopleZat el viernes sin falta.",
      ),
    ];
    expect(removeMicEcho(chunks).chunks).toEqual(chunks);
  });

  test("numbers as digits or words match", () => {
    const r = removeMicEcho([
      sys(
        0,
        "un microcrédito de tres, cuatro, 5 millones que se gastó en 5 minutos",
      ),
      mic(
        0,
        "un microcrédito de tres, cuatro, cinco millones que se gastó en cinco minutos",
      ),
    ]);
    expect(r.removedChunks).toBe(1);
  });
});
