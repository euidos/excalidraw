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
 */
export const displayNameFor = (identity: Identity): string =>
  identity.via === "wall"
    ? WALL_DISPLAY_NAME
    : identity.login || identity.name || WALL_DISPLAY_NAME;

/**
 * `via:"wall"` gets 403 on `PATCH`/`DELETE /api/boards/:id` (RETRO G-P3.1), so
 * those controls are not rendered for it — a button that always fails is worse
 * than no button.
 */
export const canManageBoards = (identity: Identity | null): boolean =>
  !!identity && identity.via !== "wall";
