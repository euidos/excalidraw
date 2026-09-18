/**
 * The share dialog's "Your name" field.
 *
 * Phase 3 made the collaborator name the edge identity, but upstream's field
 * still wrote straight to `setUsername` — so the name a room showed was
 * whatever anyone typed, while the code claimed it was the login the edge
 * resolved. This pins the two halves: resolved identity -> read-only, no
 * identity -> upstream's editable field.
 */
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchIdentity = vi.fn();

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return { ...actual, fetchIdentity };
});

const { resetIdentityCache } = await import("../identity");
const { CollaboratorNameField } = await import("../CollaboratorNameField");

const collabAPI = {
  getUsername: vi.fn(() => "Whatever I typed"),
  setUsername: vi.fn(),
};

beforeEach(() => {
  resetIdentityCache();
  vi.clearAllMocks();
});

/** upstream's TextField renders its label as a <div>, so the input is the role */
const field = () => screen.getByRole("textbox") as HTMLInputElement;

describe("CollaboratorNameField", () => {
  it("shows the edge identity and refuses edits once /api/me answered", async () => {
    fetchIdentity.mockResolvedValue({
      login: "alice@euidos.ai",
      name: "Alice",
      via: "tailnet",
    });

    render(<CollaboratorNameField collabAPI={collabAPI} onEnter={() => {}} />);

    await waitFor(() => expect(field().value).toBe("alice@euidos.ai"));
    // typing a colleague's address into this field used to persist and
    // re-broadcast it to every peer in the room
    expect(field().readOnly).toBe(true);
    expect(collabAPI.setUsername).not.toHaveBeenCalled();
  });

  it("shows the wall as Wall", async () => {
    fetchIdentity.mockResolvedValue({ login: "wall", name: "", via: "wall" });

    render(<CollaboratorNameField collabAPI={collabAPI} onEnter={() => {}} />);

    await waitFor(() => expect(field().value).toBe("Wall"));
  });

  it("keeps upstream's editable field when there is no identity to protect", async () => {
    fetchIdentity.mockRejectedValue(new TypeError("Failed to fetch"));

    render(<CollaboratorNameField collabAPI={collabAPI} onEnter={() => {}} />);

    await waitFor(() => expect(fetchIdentity).toHaveBeenCalled());
    expect(field().readOnly).toBe(false);
    expect(field().value).toBe("Whatever I typed");
  });
});
