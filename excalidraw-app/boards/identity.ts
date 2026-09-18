/**
 * Who the EDGE says we are.
 *
 * `GET /api/me` resolves identity from the Cloudflare Access JWT (public
 * origin) or from the `Tailscale-User-Login` header nginx's tailnet listener
 * passes through; a tagged device (the wall PC) carries neither and comes back
 * as `via:"wall"`. Nothing here is a client-side claim — the app cannot choose
 * an identity, it can only ask which one it already has.
 *
 * Cached for the page's lifetime because three call sites want it (the boards
 * list, the collaborator name, the rename/delete affordances) and it cannot
 * change without a reload: the Access cookie and the Serve headers are both
 * fixed for the document. A FAILED lookup is not cached, so a lost network
 * does not permanently mark the session dead.
 */
import { fetchIdentity } from "./api";

import type { Identity } from "./api";

export type { Identity, Via } from "./api";

/** What the wall is shown as, to itself and to its collaborators. */
export const WALL_DISPLAY_NAME = "Wall";

let pending: Promise<Identity> | null = null;

const normalize = (raw: Identity): Identity => ({
  login: typeof raw?.login === "string" ? raw.login : "",
  name: typeof raw?.name === "string" ? raw.name : "",
  via: raw?.via === "access" || raw?.via === "tailnet" ? raw.via : "wall",
});

export const getIdentity = (): Promise<Identity> => {
  if (!pending) {
    pending = fetchIdentity()
      .then(normalize)
      .catch((error) => {
        pending = null;
        throw error;
      });
  }
  return pending;
};

/** Test seam, and the only way to re-ask without a reload. */
export const resetIdentityCache = () => {
  pending = null;
};

/**
 * The wall is a display, not a person: it gets the literal "Wall" both in the
 * boards header and as its collaborator name, never the backend's `wall` login
 * string, which is an implementation detail.
 *
 * "Wall" is the ONE label that must never be borrowed by anyone else, so it is
 * returned only for an identity the backend actually resolved as the wall.
 * `normalize()` deliberately coerces an unknown `via` to `"wall"` (fail closed
 * for `canManageBoards`), and a future backend that adds a third named `via`
 * would otherwise broadcast every signed-in person into their boards as the
 * kiosk. A named identity with nothing to show reads "Unknown", which is
 * confusing about one person instead of wrong about the room.
 */
export const displayNameFor = (identity: Identity): string => {
  const named = identity.login || identity.name;
  if (identity.via === "wall") {
    return named && named !== "wall" ? named : WALL_DISPLAY_NAME;
  }
  return named || "Unknown";
};

/**
 * The collaborator name upstream's `Collab` should use, or `null` for "keep
 * what you have".
 *
 * This is the whole of the fork's username rule, kept out of `collab/Collab.tsx`
 * so that upstream file carries a single call (`euidos/docs/voice-tool-CLAUDE.md`
 * — every edited upstream line is a future rebase conflict).
 *
 * It is a DEFAULT, not an attestation: upstream's share dialog still owns the
 * field, and `boards/CollaboratorNameField.tsx` is what makes the resolved
 * identity read-only there. If `/api/me` never answers, upstream's random name
 * is still better than an empty one — but only for a browser that has no name
 * of its own, which is the one case that fallback was ever for.
 */
export const resolveCollaboratorName = async (
  currentUsername: string,
): Promise<string | null> => {
  try {
    return displayNameFor(await getIdentity());
  } catch {
    if (currentUsername) {
      return null;
    }
    const { getRandomUsername } = await import("@excalidraw/random-username");
    return getRandomUsername();
  }
};

/**
 * `via:"wall"` gets 403 on `PATCH`/`DELETE /api/boards/:id` (RETRO G-P3.1), so
 * those controls are not rendered for it — a button that always fails is worse
 * than no button.
 */
export const canManageBoards = (identity: Identity | null): boolean =>
  !!identity && identity.via !== "wall";
