/**
 * The "Your name" field in upstream's share dialog.
 *
 * Owned here rather than spelled out in `share/ShareDialog.tsx` (same pattern as
 * `BoardsMenuItem`), so that upstream file costs one import and one element.
 *
 * WHY IT IS READ-ONLY. Phase 3 made the collaborator name the EDGE identity
 * (`/api/me`), so a name in a room means "this is who the edge said was
 * drawing". Upstream's field wrote straight to `collabAPI.setUsername`, which
 * persists to localStorage and re-broadcasts to every peer — i.e. anyone in the
 * room could type a colleague's email and be shown as them. Internal and
 * all-staff-trusted is not a reason to ship a name that looks authoritative and
 * is not.
 *
 * The free-text field is still what a browser gets when `/api/me` never
 * answered: no identity, no claim to protect, and a nameless cursor is worse
 * than a typed one.
 */
import { KEYS } from "@excalidraw/common";
import { TextField } from "@excalidraw/excalidraw/components/TextField";
import { useEffect, useState } from "react";

import { displayNameFor, getIdentity } from "./identity";

import type { CollabAPI } from "../collab/Collab";

export const CollaboratorNameField = ({
  collabAPI,
  onEnter,
}: {
  collabAPI: Pick<CollabAPI, "getUsername" | "setUsername">;
  onEnter: () => void;
}) => {
  const [edgeName, setEdgeName] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    getIdentity()
      .then((identity) => {
        if (alive) {
          setEdgeName(displayNameFor(identity));
        }
      })
      .catch(() => {
        // no identity: upstream's editable field stays, see the note above
      });
    return () => {
      alive = false;
    };
  }, []);

  if (edgeName) {
    return (
      // keyed: swapping a `defaultValue` field for a `value` one in place is
      // React's "uncontrolled input became controlled" warning
      <TextField
        key="edge-identity"
        label="Your name"
        value={edgeName}
        readonly
        onKeyDown={(event) => event.key === KEYS.ENTER && onEnter()}
      />
    );
  }

  return (
    <TextField
      key="free-text"
      defaultValue={collabAPI.getUsername()}
      placeholder="Your name"
      label="Your name"
      onChange={collabAPI.setUsername}
      onKeyDown={(event) => event.key === KEYS.ENTER && onEnter()}
    />
  );
};
