-- scenes.elements was `jsonb`. jsonb cannot represent a NUL character, so a
-- single U+0000 anywhere in the scene (a paste into a text element, an imported
-- .excalidraw with one in customData) made EVERY later save of that board fail
-- with a 500 — permanently. `json` stores the document verbatim and accepts it.
-- Idempotent: does nothing once the column is already json.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'scenes'
       AND column_name = 'elements'
       AND udt_name = 'jsonb'
  ) THEN
    ALTER TABLE scenes ALTER COLUMN elements DROP DEFAULT;
    ALTER TABLE scenes ALTER COLUMN elements TYPE json USING elements::text::json;
    ALTER TABLE scenes ALTER COLUMN elements SET DEFAULT '[]'::json;
  END IF;
END
$$;

-- elementCount used to be computed on the fly from the stored document, but
-- every per-element SQL operator (`->`, `->>`, json_array_elements) unescapes
-- text and therefore chokes on exactly the NUL this migration makes storable.
-- Count at write time instead, and count LIVE elements: the stored array keeps
-- deleted elements as tombstones for 24 h, which made an emptied board look
-- full for a day. Existing rows are backfilled with the (tombstone-inclusive)
-- array length until their next save.
ALTER TABLE scenes ADD COLUMN IF NOT EXISTS element_count integer;
UPDATE scenes SET element_count = json_array_length(elements) WHERE element_count IS NULL;
