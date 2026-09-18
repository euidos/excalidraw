import { describe, expect, it } from "vitest";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import { sweepGhostPlaceholders } from "../../src/persist";

/**
 * Minimal element literals: the sweep only reads id/type/text/containerId/isDeleted/boundElements/strokeStyle,
 * so building real restored elements would only add noise.
 */
type Bound = { id: string; type: "text" };
const shape = (
  id: string,
  extra: {
    boundElements?: Bound[] | null;
    strokeStyle?: string;
    isDeleted?: boolean;
    customData?: Record<string, unknown>;
  } = {},
) =>
  ({
    id,
    type: "rectangle",
    isDeleted: false,
    strokeStyle: "solid",
    boundElements: null,
    ...extra,
  }) as unknown as ExcalidrawElement;

/** A region marker as fit.ts stamps it (round 4a): scaffolding that a finished take always deletes itself. */
const marker = (id: string, extra: { boundElements?: Bound[] | null; type?: string } = {}) =>
  ({
    id,
    type: extra.type ?? "rectangle",
    isDeleted: false,
    strokeStyle: "dashed",
    boundElements: extra.boundElements ?? null,
    customData: { voiceRegion: true },
  }) as unknown as ExcalidrawElement;

const text = (
  id: string,
  content: string,
  extra: {
    containerId?: string | null;
    isDeleted?: boolean;
    /** fit.ts stamps a "⚠ STT" warning with `voiceFailed`; a commit clears it again. */
    customData?: Record<string, unknown>;
  } = {},
) =>
  ({
    id,
    type: "text",
    text: content,
    containerId: null,
    isDeleted: false,
    ...extra,
  }) as unknown as ExcalidrawElement;

const byId = (els: readonly ExcalidrawElement[], id: string) =>
  els.find((e) => e.id === id) as unknown as Record<string, unknown>;

describe("sweepGhostPlaceholders", () => {
  it("deletes a bound placeholder and restores its container", () => {
    const out = sweepGhostPlaceholders([
      shape("c1", { boundElements: [{ id: "t1", type: "text" }], strokeStyle: "dashed" }),
      text("t1", "·", { containerId: "c1" }),
    ]);
    expect(byId(out, "t1").isDeleted).toBe(true);
    expect(byId(out, "c1").boundElements).toBe(null);
    expect(byId(out, "c1").strokeStyle).toBe("solid");
  });

  it.each(["·", "··", "···", "⚠ STT", "⚠ STT timeout"])("sweeps frame %s", (frame) => {
    const out = sweepGhostPlaceholders([
      shape("c1", { boundElements: [{ id: "t1", type: "text" }], strokeStyle: "dashed" }),
      text("t1", frame, { containerId: "c1" }),
    ]);
    expect(byId(out, "t1").isDeleted).toBe(true);
  });

  it("keeps other bound texts on the container and leaves a solid stroke alone", () => {
    const out = sweepGhostPlaceholders([
      shape("c1", {
        boundElements: [
          { id: "t1", type: "text" },
          { id: "t2", type: "text" },
        ],
        strokeStyle: "solid",
      }),
      text("t1", "·", { containerId: "c1" }),
      text("t2", "real label", { containerId: "c1" }),
    ]);
    expect(byId(out, "c1").boundElements).toEqual([{ id: "t2", type: "text" }]);
    expect(byId(out, "c1").strokeStyle).toBe("solid");
    expect(byId(out, "t2").isDeleted).toBe(false);
  });

  it("deletes a bound placeholder whose container is missing", () => {
    const out = sweepGhostPlaceholders([text("t1", "··", { containerId: "gone" })]);
    expect(byId(out, "t1").isDeleted).toBe(true);
  });

  it("deletes free-standing placeholder dots", () => {
    const out = sweepGhostPlaceholders([text("t1", "·"), text("t2", "···")]);
    expect(byId(out, "t1").isDeleted).toBe(true);
    expect(byId(out, "t2").isDeleted).toBe(true);
  });

  it("deletes a free-standing warning the app STAMPED (a failed line region, or a marker-less retry)", () => {
    const out = sweepGhostPlaceholders([
      text("t1", "⚠ STT", { customData: { voiceFailed: true } }),
    ]);
    expect(byId(out, "t1").isDeleted, "nothing could ever retry into it: the audio died with the page").toBe(true);
  });

  it("leaves real text, real shapes and free-standing STT warnings untouched", () => {
    const input = [shape("c1"), text("t1", "hello"), text("t2", "⚠ STT failed")];
    const out = sweepGhostPlaceholders(input);
    expect(out).toEqual(input);
  });

  it("is a pure function: the input array and its elements are not mutated", () => {
    const container = shape("c1", { boundElements: [{ id: "t1", type: "text" }], strokeStyle: "dashed" });
    const placeholder = text("t1", "·", { containerId: "c1" });
    const input = [container, placeholder];
    sweepGhostPlaceholders(input);
    expect(input).toEqual([container, placeholder]);
    expect(placeholder.isDeleted).toBe(false);
    expect(container.strokeStyle).toBe("dashed");
  });

  it("ignores elements already deleted", () => {
    const out = sweepGhostPlaceholders([
      shape("c1", { boundElements: [{ id: "t1", type: "text" }], strokeStyle: "dashed" }),
      text("t1", "·", { containerId: "c1", isDeleted: true }),
    ]);
    expect(byId(out, "c1").strokeStyle).toBe("dashed");
  });

  describe("region markers (round 4a)", () => {
    it("deletes a marker and its placeholder: a reload cannot finish that take", () => {
      const out = sweepGhostPlaceholders([
        marker("m1", { boundElements: [{ id: "t1", type: "text" }] }),
        text("t1", "··", { containerId: "m1" }),
      ]);
      expect(byId(out, "m1").isDeleted, "the marker was never the founder's drawing").toBe(true);
      expect(byId(out, "t1").isDeleted).toBe(true);
    });

    it("deletes a marker whose text is gone altogether", () => {
      const out = sweepGhostPlaceholders([marker("m1"), shape("keep")]);
      expect(byId(out, "m1").isDeleted).toBe(true);
      expect(byId(out, "keep").isDeleted, "nothing else is touched").toBe(false);
      expect(byId(out, "keep").strokeStyle).toBe("solid");
    });

    it("deletes a marker left showing ⚠ STT: the audio for a retry died with the page", () => {
      const out = sweepGhostPlaceholders([
        marker("m1", { boundElements: [{ id: "t1", type: "text" }] }),
        text("t1", "⚠ STT", { containerId: "m1" }),
      ]);
      expect(byId(out, "m1").isDeleted).toBe(true);
      expect(byId(out, "t1").isDeleted).toBe(true);
    });

    it("deletes a LINE marker whose placeholder text was never bound to it", () => {
      const out = sweepGhostPlaceholders([marker("m1", { type: "line" }), text("t1", "·")]);
      expect(byId(out, "m1").isDeleted).toBe(true);
      expect(byId(out, "t1").isDeleted).toBe(true);
    });

    it("leaves a committed free text alone — a finished take has no marker left to sweep", () => {
      const input = [text("t1", "회의 목표", { containerId: null }), shape("c1")];
      expect(sweepGhostPlaceholders(input)).toEqual(input);
    });

    it("keeps a marker that a real bound label claims (hand-edited scenes only)", () => {
      const out = sweepGhostPlaceholders([
        marker("m1", { boundElements: [{ id: "t1", type: "text" }] }),
        text("t1", "a label somebody typed", { containerId: "m1" }),
      ]);
      expect(byId(out, "m1").isDeleted).toBe(false);
      expect(byId(out, "t1").isDeleted).toBe(false);
    });

    /**
     * Round 5. An interim preview carries REAL WORDS at 45 % opacity, so no content test can tell it from a
     * committed transcript — only `customData.voiceInterim` can. A reload in the middle of a sentence must not
     * leave half of it, faint, on the founder's board for ever, and it must not keep the dashed box either.
     */
    it("deletes an INTERIM preview and the marker it was previewed in", () => {
      const out = sweepGhostPlaceholders([
        marker("m1", { boundElements: [{ id: "t1", type: "text" }] }),
        text("t1", "회의 목표는", { containerId: "m1", customData: { voiceInterim: true } }),
      ]);
      expect(byId(out, "t1").isDeleted, "half a sentence is not a transcript").toBe(true);
      expect(byId(out, "m1").isDeleted, "and its region was never the founder's drawing").toBe(true);
    });

    it("deletes a free-standing interim preview (a line region's text is never bound)", () => {
      const out = sweepGhostPlaceholders([
        text("t1", "voice tool ships", { containerId: null, customData: { voiceInterim: true } }),
      ]);
      expect(byId(out, "t1").isDeleted).toBe(true);
    });

    it("unbinds rather than deletes a container that is NOT a marker", () => {
      const out = sweepGhostPlaceholders([
        shape("c1", { boundElements: [{ id: "t1", type: "text" }], strokeStyle: "dashed" }),
        text("t1", "·", { containerId: "c1" }),
      ]);
      expect(byId(out, "c1").isDeleted, "a shape the founder drew by hand stays").toBe(false);
      expect(byId(out, "c1").boundElements).toBe(null);
      expect(byId(out, "c1").strokeStyle).toBe("solid");
    });
  });
});
