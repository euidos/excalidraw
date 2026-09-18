import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  canManageBoards,
  displayNameFor,
  getIdentity,
  resetIdentityCache,
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
