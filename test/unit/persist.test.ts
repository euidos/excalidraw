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
  extra: { boundElements?: Bound[] | null; strokeStyle?: string; isDeleted?: boolean } = {},
) =>
  ({
    id,
    type: "rectangle",
    isDeleted: false,
    strokeStyle: "solid",
    boundElements: null,
    ...extra,
  }) as unknown as ExcalidrawElement;

const text = (
  id: string,
  content: string,
  extra: { containerId?: string | null; isDeleted?: boolean } = {},
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
});
