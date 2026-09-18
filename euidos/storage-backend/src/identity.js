import { createRemoteJWKSet, jwtVerify } from "jose";

export class IdentityError extends Error {
  constructor(message, { status = 401, code = "unauthorized" } = {}) {
    super(message);
    this.name = "IdentityError";
    this.status = status;
    this.code = code;
  }
}

const normaliseIssuer = (teamDomain) => {
  const trimmed = String(teamDomain ?? "").trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  return /^https?:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;
};

/**
 * Identity resolution, in the order fixed by the plan:
 *   1. Cf-Access-Jwt-Assertion  -> verified against the team JWKS -> via "access"
 *   2. X-Euidos-Listener: tailnet (set by nginx's tailnet server block only)
 *        -> Tailscale-User-Login present -> via "tailnet"
 *        -> absent (tagged device, i.e. the wall PC)       -> via "wall"
 *   3. otherwise 401.
 *
 * Any other value of X-Euidos-Listener is untrusted and ignored. Client copies
 * of these headers are stripped by nginx on both listeners; this module only
 * ever trusts the tailnet headers when the listener marker says tailnet.
 *
 * @param {object} opts
 * @param {string} opts.aud            ACCESS_AUD (the Access application's aud tag)
 * @param {string} opts.teamDomain     ACCESS_TEAM_DOMAIN, e.g. euidos.cloudflareaccess.com
 * @param {Function} [opts.jwks]       injected key resolver (tests); defaults to the
 *                                     cached remote JWKS, which refetches on an unknown kid
 */
export function createIdentityResolver({ aud, teamDomain, jwks, log = console.log } = {}) {
  const issuer = normaliseIssuer(teamDomain);
  let keys = jwks ?? null;

  const keySet = () => {
    if (keys) return keys;
    if (!issuer) return null;
    keys = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`), {
      cacheMaxAge: 10 * 60 * 1000, // cached; jose refetches when a kid is unknown
      cooldownDuration: 30 * 1000,
      timeoutDuration: 5000,
    });
    return keys;
  };

  return async function resolveIdentity(req) {
    const h = req.headers;
    const assertion = h["cf-access-jwt-assertion"];

    if (assertion) {
      const resolver = keySet();
      if (!resolver) {
        throw new IdentityError("Access verification is not configured");
      }
      if (!aud) {
        throw new IdentityError("Access verification is not configured");
      }
      let payload;
      try {
        ({ payload } = await jwtVerify(assertion, resolver, {
          audience: aud,
          issuer,
          algorithms: ["RS256", "ES256"],
        }));
      } catch (err) {
        log(`identity access token rejected: ${err.code ?? err.name}`);
        throw new IdentityError("Invalid Access token");
      }
      const login = payload.email ?? payload.common_name;
      if (!login) throw new IdentityError("Access token carries no identity");
      return { login, name: payload.name ?? login, via: "access" };
    }

    if (h["x-euidos-listener"] === "tailnet") {
      const login = h["tailscale-user-login"];
      if (login) {
        return { login, name: h["tailscale-user-name"] || login, via: "tailnet" };
      }
      return { login: "wall", name: "Wall", via: "wall" };
    }

    throw new IdentityError("No identity on this request");
  };
}
