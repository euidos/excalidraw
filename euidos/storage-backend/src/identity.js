export class IdentityError extends Error {
  constructor(message, { status = 401, code = "unauthorized" } = {}) {
    super(message);
    this.name = "IdentityError";
    this.status = status;
    this.code = code;
  }
}

/**
 * Identity resolution, in this order:
 *   1. X-Euidos-Listener: login (set by nginx's :80 block only, reached only by
 *      the login server's Authentik outpost)
 *        -> X-authentik-email present -> via "login"
 *        -> absent                    -> 401
 *   2. X-Euidos-Listener: tailnet (set by nginx's tailnet server block only)
 *        -> Tailscale-User-Login present -> via "tailnet"
 *        -> absent (tagged device, i.e. the wall PC)       -> via "wall"
 *   3. otherwise 401.
 *
 * Any other value of X-Euidos-Listener is untrusted and ignored. nginx sets the
 * marker unconditionally on both listeners and blanks the other listener's
 * identity headers; this module only trusts a header family when the marker
 * says it came through the matching listener.
 */
export function resolveIdentity(req) {
  const h = req.headers;
  const listener = h["x-euidos-listener"];

  if (listener === "login") {
    const email = h["x-authentik-email"];
    if (!email) throw new IdentityError("No identity on this request");
    return { login: email, name: h["x-authentik-name"] || email, via: "login" };
  }

  if (listener === "tailnet") {
    const login = h["tailscale-user-login"];
    if (login) {
      return { login, name: h["tailscale-user-name"] || login, via: "tailnet" };
    }
    return { login: "wall", name: "Wall", via: "wall" };
  }

  throw new IdentityError("No identity on this request");
}
