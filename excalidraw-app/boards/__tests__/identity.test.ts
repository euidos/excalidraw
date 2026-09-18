import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  canManageBoards,
  displayNameFor,
  getIdentity,
  resetIdentityCache,
  resolveCollaboratorName,
} from "../identity";

const response = (status: number, body: unknown) =>
  ({
    ok: status < 400,
    status,
    text: async () => JSON.stringify(body),
  } as unknown as Response);

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  resetIdentityCache();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

describe("getIdentity", () => {
  it("asks /api/me once and shares the answer with every caller", async () => {
    fetchMock.mockResolvedValue(
      response(200, {
        login: "alice@euidos.ai",
        name: "Alice",
        via: "tailnet",
      }),
    );

    const [a, b] = await Promise.all([getIdentity(), getIdentity()]);
    expect(await getIdentity()).toBe(a);
    expect(b).toBe(a);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does NOT cache a failure — a blip must not mark the session dead for the page's life", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await expect(getIdentity()).rejects.toBeTruthy();

    fetchMock.mockResolvedValue(
      response(200, { login: "alice@euidos.ai", name: "Alice", via: "access" }),
    );
    expect((await getIdentity()).via).toBe("access");
  });

  it("treats an unknown `via` as the wall — the restricted identity, never the permissive one", async () => {
    fetchMock.mockResolvedValue(
      response(200, { login: "x", name: "x", via: "something-new" }),
    );
    expect((await getIdentity()).via).toBe("wall");
  });
});

describe("displayNameFor / canManageBoards", () => {
  it("shows the wall as 'Wall', not as its backend login", () => {
    expect(displayNameFor({ login: "wall", name: "wall", via: "wall" })).toBe(
      "Wall",
    );
  });

  it("shows a signed-in person as their login email", () => {
    expect(
      displayNameFor({ login: "bob@euidos.ai", name: "Bob", via: "access" }),
    ).toBe("bob@euidos.ai");
  });

  it("only a named identity may rename/delete (the backend answers the wall 403)", () => {
    expect(canManageBoards({ login: "wall", name: "wall", via: "wall" })).toBe(
      false,
    );
    expect(
      canManageBoards({ login: "bob@euidos.ai", name: "Bob", via: "tailnet" }),
    ).toBe(true);
    expect(canManageBoards(null)).toBe(false);
  });
});

describe("displayNameFor — 'Wall' is never borrowed", () => {
  it("does not label a signed-in person as the kiosk when the backend tells us nothing", () => {
    // via:"access" with an empty login/name used to read "Wall", and so did
    // every identity if the backend ever added a third named `via` (normalize
    // fails those closed to "wall" on purpose, for canManageBoards)
    expect(displayNameFor({ login: "", name: "", via: "access" })).toBe(
      "Unknown",
    );
    expect(displayNameFor({ login: "", name: "Bob", via: "tailnet" })).toBe(
      "Bob",
    );
  });

  it("still shows a real wall identity as Wall", () => {
    expect(displayNameFor({ login: "wall", name: "", via: "wall" })).toBe(
      "Wall",
    );
    expect(displayNameFor({ login: "", name: "", via: "wall" })).toBe("Wall");
  });
});

describe("resolveCollaboratorName", () => {
  it("is the edge identity — the rule lives here, not in upstream's Collab.tsx", async () => {
    fetchMock.mockResolvedValue(
      response(200, { login: "bob@euidos.ai", name: "Bob", via: "tailnet" }),
    );
    expect(await resolveCollaboratorName("")).toBe("bob@euidos.ai");
  });

  it("keeps a name this browser already has when the lookup fails", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    expect(await resolveCollaboratorName("Existing name")).toBeNull();
  });

  it("falls back to a random name only for a nameless browser with no identity", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    const name = await resolveCollaboratorName("");
    expect(name).toBeTruthy();
    expect(name).not.toBe("Wall");
  });
});
