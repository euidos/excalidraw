-- Boards storage, initial schema.
-- Applied by src/db.js at start-up; must stay idempotent (re-running is a no-op).

CREATE TABLE IF NOT EXISTS boards (
  id          text PRIMARY KEY,
  name        text        NOT NULL,
  room_key    text        NOT NULL DEFAULT '',
  created_by  text        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  text        NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz
);

-- The board list is "not deleted, newest edit first".
CREATE INDEX IF NOT EXISTS boards_updated_at_idx
  ON boards (updated_at DESC)
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS scenes (
  board_id   text PRIMARY KEY REFERENCES boards (id) ON DELETE CASCADE,
  elements   jsonb       NOT NULL DEFAULT '[]'::jsonb,
  version    integer     NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Binary files (images) referenced by a scene. board_id is informational only
-- (no FK): the client may upload a file before the board row exists.
CREATE TABLE IF NOT EXISTS files (
  id           text PRIMARY KEY,
  board_id     text,
  content_type text        NOT NULL DEFAULT 'application/octet-stream',
  bytes        bytea       NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS files_board_id_idx ON files (board_id);

-- Opaque blobs behind "#json=" share links (upstream exportToBackend).
CREATE TABLE IF NOT EXISTS blobs (
  id         text PRIMARY KEY,
  bytes      bytea       NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
