import { randomBytes } from "node:crypto";
import http from "node:http";

import { loadConfig } from "./config.js";
import { createPool, migrate, waitForDb } from "./db.js";
import { createIdentityResolver, IdentityError } from "./identity.js";

const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const ROOM_KEY_RE = /^[A-Za-z0-9_\-+/=]{0,256}$/;
const MAX_NAME_LENGTH = 200;

const BINARY_CONTENT_TYPE = "application/octet-stream";

/**
 * The ONLY content types a stored file may be served with. Anything else (and
 * in particular text/html, image/svg+xml, application/javascript) is coerced to
 * application/octet-stream: /api/files is served from the app's own origin, so
 * replaying a caller-chosen content type would be a stored-XSS primitive.
 * The real client only ever uploads MIME_TYPES.binary; the image types are here
 * so that a file fetched directly in a browser tab still previews.
 */
const ALLOWED_FILE_CONTENT_TYPES = new Set([
  BINARY_CONTENT_TYPE,
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/bmp",
  "image/avif",
]);

/** Belt and braces on top of the allowlist: a stored file can never be a page. */
const FILE_RESPONSE_GUARDS = {
  "content-disposition": "attachment",
  "content-security-policy": "default-src 'none'; sandbox",
  "x-content-type-options": "nosniff",
};

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const badRequest = (message) => new HttpError(400, "bad_request", message);
const notFound = (message = "Not found") => new HttpError(404, "not_found", message);
const forbidden = (message) => new HttpError(403, "forbidden", message);

/**
 * Identity on both listeners is ambient (it comes from the connection, not from
 * a cookie the browser could withhold), so EVERY state-changing request is
 * "authenticated" even when a hostile page triggers it. Refuse the ones a
 * browser tells us are cross-site.
 *   - Sec-Fetch-Site is sent by every browser that can mount this attack;
 *     "none" is a typed URL, "same-origin" is our own app. Anything else goes.
 *   - Origin is the fallback for the (older) browsers that omit Sec-Fetch-*.
 *   - Neither header present => not a browser (curl, the e2e script) => allow.
 */
function requireSameOrigin(req) {
  if (SAFE_METHODS.has(req.method)) return;
  const site = req.headers["sec-fetch-site"];
  if (site && site !== "same-origin" && site !== "none") {
    throw forbidden("Cross-site request rejected");
  }
  const origin = req.headers.origin;
  if (origin && origin !== "null") {
    let host;
    try {
      ({ host } = new URL(origin));
    } catch {
      throw forbidden("Cross-site request rejected");
    }
    if (host !== req.headers.host) throw forbidden("Cross-site request rejected");
  }
}

/** A path parameter may be percent-encoded garbage; that is a 400, not a 500. */
function decodeId(raw, what = "id") {
  let value;
  try {
    value = decodeURIComponent(raw);
  } catch {
    throw badRequest(`Invalid ${what}`);
  }
  return requireId(value, what);
}

function sendJson(res, status, body) {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": payload.length,
    "cache-control": "no-store",
  });
  res.end(payload);
}

function sendError(res, status, code, message) {
  const body = { error: code, message };
  if (code === "too_large") {
    // upstream's exportToBackend branches on this exact name to show the
    // "scene is too big" message instead of the generic link failure
    body.error_class = "RequestTooLargeError";
  }
  sendJson(res, status, body);
}

/** Read the body, refusing oversized payloads BEFORE anything is parsed. */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number.parseInt(req.headers["content-length"] ?? "", 10);
    if (Number.isFinite(declared) && declared > limit) {
      reject(new HttpError(413, "too_large", `Body exceeds ${limit} bytes`));
      req.resume();
      return;
    }
    const chunks = [];
    let size = 0;
    let done = false;
    const fail = (err) => {
      if (done) return;
      done = true;
      req.removeListener("data", onData);
      req.removeListener("end", onEnd);
      req.removeListener("error", fail);
      req.resume();
      reject(err);
    };
    const onData = (chunk) => {
      size += chunk.length;
      if (size > limit) {
        fail(new HttpError(413, "too_large", `Body exceeds ${limit} bytes`));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks));
    };
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", fail);
  });
}

async function readJson(req, limit) {
  // A JSON content type cannot be produced by a cross-origin <form>, and a
  // fetch() that sets it is preflighted — so this is the second half of the
  // CSRF defence in `requireSameOrigin`.
  const type = String(req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
  if (type !== "application/json") {
    throw new HttpError(415, "unsupported_media_type", "Content-Type must be application/json");
  }
  const raw = await readBody(req, limit);
  if (raw.length === 0) throw badRequest("Empty body");
  try {
    return JSON.parse(raw.toString("utf8"));
  } catch {
    throw badRequest("Body is not valid JSON");
  }
}

const boardFromRow = (row) => ({
  id: row.id,
  name: row.name,
  roomKey: row.room_key,
  createdBy: row.created_by,
  createdAt: row.created_at.toISOString(),
  updatedBy: row.updated_by,
  updatedAt: row.updated_at.toISOString(),
  elementCount: Number(row.element_count ?? 0),
});

// elementCount is what a human would count on the canvas, so tombstones (the
// deleted elements the sync protocol keeps for 24 h) do not count. It is stored
// at write time rather than derived in SQL because every per-element json
// operator unescapes text and would then fail on a scene containing a NUL.
const BOARD_SELECT = `
  SELECT b.id, b.name, b.room_key, b.created_by, b.created_at, b.updated_by, b.updated_at,
         COALESCE(s.element_count, 0) AS element_count
    FROM boards b
    LEFT JOIN scenes s ON s.board_id = b.id
`;

/** elements the user can still see (isDeleted tombstones do not count) */
const countLiveElements = (elements) =>
  elements.reduce((n, el) => (el && el.isDeleted === true ? n : n + 1), 0);

function requireId(value, what = "id") {
  if (typeof value !== "string" || !ID_RE.test(value)) {
    throw badRequest(`Invalid ${what}`);
  }
  return value;
}

/**
 * The wall display is a tagged tailnet device: it carries no login at all, so
 * "wall" is what every credential-free request on the tailnet listener becomes.
 * Reading and saving the room it is showing is its job; destroying other
 * people's boards is not, and a soft-delete has no UI to undo it.
 */
/**
 * Never let a caller choose the content type a file is served with — see
 * ALLOWED_FILE_CONTENT_TYPES. Unknown/absent/hostile => binary download.
 */
function safeFileContentType(declared) {
  if (typeof declared !== "string") return BINARY_CONTENT_TYPE;
  const type = declared.split(";")[0].trim().toLowerCase();
  return ALLOWED_FILE_CONTENT_TYPES.has(type) ? type : BINARY_CONTENT_TYPE;
}

function requireNamedIdentity(identity, action) {
  if (!identity || identity.via === "wall") {
    throw forbidden(`Sign in on a personal device to ${action}`);
  }
  return identity;
}

function requireName(value) {
  if (typeof value !== "string") throw badRequest("name must be a string");
  const name = value.trim();
  if (!name) throw badRequest("name must not be empty");
  if (name.length > MAX_NAME_LENGTH) throw badRequest("name is too long");
  return name;
}

export function createRequestHandler({ pool, config, resolveIdentity, log = console.log }) {
  const routes = [];
  const route = (method, pattern, handler, opts = {}) =>
    routes.push({ method, pattern, handler, ...opts });

  // ---- health (the only route without identity) ---------------------------
  route(
    "GET",
    /^\/api\/health$/,
    async (ctx) => {
      try {
        await pool.query("SELECT 1");
      } catch {
        sendJson(ctx.res, 503, { ok: false, db: "error" });
        return;
      }
      sendJson(ctx.res, 200, { ok: true, db: "ok" });
    },
    { anonymous: true },
  );

  // ---- me -----------------------------------------------------------------
  route("GET", /^\/api\/me$/, async ({ res, identity }) => {
    sendJson(res, 200, { login: identity.login, name: identity.name, via: identity.via });
  });

  // ---- boards -------------------------------------------------------------
  route("GET", /^\/api\/boards$/, async ({ res }) => {
    const { rows } = await pool.query(
      `${BOARD_SELECT} WHERE b.deleted_at IS NULL ORDER BY b.updated_at DESC, b.id`,
    );
    sendJson(res, 200, { boards: rows.map(boardFromRow) });
  });

  route("POST", /^\/api\/boards$/, async ({ req, res, identity }) => {
    const body = await readJson(req, 64 * 1024);
    const id = requireId(body?.id, "board id");
    const name = requireName(body?.name ?? "Untitled");
    const roomKey = body?.roomKey ?? "";
    if (typeof roomKey !== "string" || !ROOM_KEY_RE.test(roomKey)) {
      throw badRequest("Invalid roomKey");
    }
    const inserted = await pool.query(
      `INSERT INTO boards (id, name, room_key, created_by, updated_by)
            VALUES ($1, $2, $3, $4, $4)
       ON CONFLICT (id) DO NOTHING
         RETURNING id`,
      [id, name, roomKey, identity.login],
    );
    if (inserted.rowCount === 0) {
      throw new HttpError(409, "conflict", "A board with this id already exists");
    }
    const { rows } = await pool.query(`${BOARD_SELECT} WHERE b.id = $1`, [id]);
    sendJson(res, 201, boardFromRow(rows[0]));
  });

  route("PATCH", /^\/api\/boards\/([^/]+)$/, async ({ req, res, params, identity }) => {
    requireNamedIdentity(identity, "rename a board");
    const id = decodeId(params[0], "board id");
    const body = await readJson(req, 64 * 1024);
    const name = requireName(body?.name);
    const updated = await pool.query(
      "UPDATE boards SET name = $2 WHERE id = $1 AND deleted_at IS NULL RETURNING id",
      [id, name],
    );
    if (updated.rowCount === 0) throw notFound("No such board");
    const { rows } = await pool.query(`${BOARD_SELECT} WHERE b.id = $1`, [id]);
    sendJson(res, 200, boardFromRow(rows[0]));
  });

  route("DELETE", /^\/api\/boards\/([^/]+)$/, async ({ res, params, identity }) => {
    requireNamedIdentity(identity, "delete a board");
    const id = decodeId(params[0], "board id");
    const { rowCount } = await pool.query(
      "UPDATE boards SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL",
      [id],
    );
    if (rowCount === 0) {
      const exists = await pool.query("SELECT 1 FROM boards WHERE id = $1", [id]);
      if (exists.rowCount === 0) throw notFound("No such board");
    }
    res.writeHead(204).end();
  });

  // ---- rooms (the live scene of a board) ----------------------------------
  route("GET", /^\/api\/rooms\/([^/]+)$/, async ({ res, params }) => {
    const id = decodeId(params[0], "room id");
    const { rows } = await pool.query(
      `SELECT s.elements, s.version, s.updated_at
         FROM scenes s
         JOIN boards b ON b.id = s.board_id
        WHERE s.board_id = $1 AND b.deleted_at IS NULL`,
      [id],
    );
    if (rows.length === 0) throw notFound("This room has never been saved");
    sendJson(res, 200, {
      elements: rows[0].elements,
      version: rows[0].version,
      updatedAt: rows[0].updated_at.toISOString(),
    });
  });

  route("PUT", /^\/api\/rooms\/([^/]+)$/, async ({ req, res, params, identity }) => {
    const id = decodeId(params[0], "room id");
    const body = await readJson(req, config.maxSceneBytes);
    const elements = body?.elements;
    if (!Array.isArray(elements)) throw badRequest("elements must be an array");
    // Optimistic concurrency. The client's save is a read-modify-write (GET,
    // reconcile, PUT), which without a precondition silently drops whatever
    // another writer committed in between — Firestore's runTransaction is what
    // used to prevent that. `baseVersion` is the version the client merged
    // against; 0 means "there was no scene". Omitting it keeps the old
    // last-writer-wins behaviour for non-browser callers.
    const baseVersion = body?.baseVersion;
    if (baseVersion !== undefined && baseVersion !== null) {
      if (!Number.isInteger(baseVersion) || baseVersion < 0) {
        throw badRequest("baseVersion must be a non-negative integer");
      }
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      let board = await client.query(
        "SELECT deleted_at FROM boards WHERE id = $1 FOR UPDATE",
        [id],
      );
      if (board.rowCount === 0) {
        // A "#room=" link opened before the board was ever listed.
        await client.query(
          `INSERT INTO boards (id, name, created_by, updated_by)
                VALUES ($1, 'Untitled', $2, $2)
           ON CONFLICT (id) DO NOTHING`,
          [id, identity.login],
        );
        board = await client.query("SELECT deleted_at FROM boards WHERE id = $1 FOR UPDATE", [id]);
      }
      if (board.rows[0].deleted_at !== null) {
        await client.query("ROLLBACK");
        throw notFound("No such board");
      }
      if (baseVersion !== undefined && baseVersion !== null) {
        const current = await client.query(
          "SELECT version FROM scenes WHERE board_id = $1 FOR UPDATE",
          [id],
        );
        const version = current.rowCount === 0 ? 0 : current.rows[0].version;
        if (version !== baseVersion) {
          await client.query("ROLLBACK");
          throw new HttpError(
            409,
            "conflict",
            `The scene changed since version ${baseVersion} (it is now at ${version})`,
          );
        }
      }
      const saved = await client.query(
        // elements is `json`, not `jsonb`: jsonb cannot represent a NUL, so one
        // pasted \u0000 anywhere in the scene would make the board permanently
        // unsaveable (every PUT 500s). json keeps the document verbatim.
        `INSERT INTO scenes (board_id, elements, element_count, version, updated_at)
              VALUES ($1, $2::json, $3, 1, now())
         ON CONFLICT (board_id) DO UPDATE
            SET elements = EXCLUDED.elements,
                element_count = EXCLUDED.element_count,
                version = scenes.version + 1,
                updated_at = now()
          RETURNING version, updated_at`,
        [id, JSON.stringify(elements), countLiveElements(elements)],
      );
      await client.query("UPDATE boards SET updated_at = now(), updated_by = $2 WHERE id = $1", [
        id,
        identity.login,
      ]);
      await client.query("COMMIT");
      sendJson(res, 200, {
        version: saved.rows[0].version,
        updatedAt: saved.rows[0].updated_at.toISOString(),
      });
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  });

  // ---- files (binary, one row per excalidraw file id) ----------------------
  route("GET", /^\/api\/files\/([^/]+)$/, async ({ res, params }) => {
    const id = decodeId(params[0], "file id");
    const { rows } = await pool.query("SELECT content_type, bytes FROM files WHERE id = $1", [id]);
    if (rows.length === 0) throw notFound("No such file");
    res.writeHead(200, {
      ...FILE_RESPONSE_GUARDS,
      "content-type": safeFileContentType(rows[0].content_type),
      "content-length": rows[0].bytes.length,
      "cache-control": "private, max-age=31536000, immutable",
    });
    res.end(rows[0].bytes);
  });

  route("PUT", /^\/api\/files\/([^/]+)$/, async ({ req, res, params, url }) => {
    const id = decodeId(params[0], "file id");
    const boardParam = url.searchParams.get("board");
    const boardId = boardParam ? requireId(boardParam, "board id") : null;
    const bytes = await readBody(req, config.maxFileBytes);
    if (bytes.length === 0) throw badRequest("Empty body");
    const contentType = safeFileContentType(req.headers["content-type"]);
    await pool.query(
      `INSERT INTO files (id, board_id, content_type, bytes)
            VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO UPDATE
          SET board_id = COALESCE(EXCLUDED.board_id, files.board_id),
              content_type = EXCLUDED.content_type,
              bytes = EXCLUDED.bytes`,
      [id, boardId, contentType, bytes],
    );
    sendJson(res, 201, { id });
  });

  // ---- opaque blobs behind "#json=" share links ---------------------------
  route("POST", /^\/api\/v2\/scenes$/, async ({ req, res }) => {
    const bytes = await readBody(req, config.maxSceneBytes);
    if (bytes.length === 0) throw badRequest("Empty body");
    const id = randomBytes(16).toString("hex");
    await pool.query("INSERT INTO blobs (id, bytes) VALUES ($1, $2)", [id, bytes]);
    sendJson(res, 201, { id });
  });

  route("GET", /^\/api\/v2\/scenes\/([^/]+)$/, async ({ res, params }) => {
    const id = decodeId(params[0], "scene id");
    const { rows } = await pool.query("SELECT bytes FROM blobs WHERE id = $1", [id]);
    if (rows.length === 0) throw notFound("No such scene");
    res.writeHead(200, {
      ...FILE_RESPONSE_GUARDS,
      "content-type": BINARY_CONTENT_TYPE,
      "content-length": rows[0].bytes.length,
      "cache-control": "private, max-age=31536000, immutable",
    });
    res.end(rows[0].bytes);
  });

  return async function handle(req, res) {
    const started = process.hrtime.bigint();
    const url = new URL(req.url, "http://localhost");
    const pathname = url.pathname.replace(/\/+$/, "") || "/";
    let login = "-";

    res.on("finish", () => {
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      // one line per request; never the body
      log(`${req.method} ${pathname} ${res.statusCode} ${ms.toFixed(1)}ms ${login}`);
    });

    try {
      requireSameOrigin(req);
      // node:http drops the body of a HEAD response by itself, so a HEAD route
      // is a GET route; without this every monitor probing HEAD /api/health
      // reports the service down.
      const method = req.method === "HEAD" ? "GET" : req.method;
      const byPath = routes.filter((r) => r.pattern.test(pathname));
      if (byPath.length === 0) throw notFound("Unknown route");
      const matched = byPath.find((r) => r.method === method);
      if (!matched) throw new HttpError(405, "method_not_allowed", "Method not allowed");

      let identity = null;
      if (!matched.anonymous) {
        identity = await resolveIdentity(req);
        login = identity.login;
      }
      const params = pathname.match(matched.pattern).slice(1);
      await matched.handler({ req, res, url, params, identity });
      if (!res.writableEnded) res.end();
    } catch (err) {
      if (!res.headersSent) {
        if (err instanceof IdentityError) {
          sendError(res, err.status, err.code, err.message);
        } else if (err instanceof HttpError) {
          sendError(res, err.status, err.code, err.message);
        } else {
          log(`error ${req.method} ${pathname}: ${err.stack ?? err.message}`);
          sendError(res, 500, "internal_error", "Internal error");
        }
      } else {
        res.destroy();
      }
    }
  };
}

export function createServer(options) {
  const server = http.createServer(createRequestHandler(options));
  server.headersTimeout = 30_000;
  server.requestTimeout = 120_000;
  return server;
}

export async function main() {
  const config = loadConfig();
  const pool = createPool(config.pg);
  await waitForDb(pool);
  await migrate(pool);
  const resolveIdentity = createIdentityResolver({
    aud: config.accessAud,
    teamDomain: config.accessTeamDomain,
  });
  const server = createServer({ pool, config, resolveIdentity });
  await new Promise((resolve) => server.listen(config.port, "0.0.0.0", resolve));
  console.log(`boards-storage listening on :${config.port}`);

  const shutdown = (signal) => {
    console.log(`${signal} received, shutting down`);
    server.close(async () => {
      await pool.end().catch(() => {});
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
