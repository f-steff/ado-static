// Tests for the share-reporting helper.
//
// Rationale: the access list is the only record of who can install the private dev edition, so the
// formatting the share workflow reports must be predictable for the shapes the Marketplace returns.
import test from "node:test";
import assert from "node:assert/strict";

import { formatSharedWith } from "../ci/shared-with.mjs";

test("formatSharedWith lists the shared organizations as markdown bullets", () => {
  const info = { sharedWith: [{ name: "contoso" }, { name: "SampleOrg" }] };
  assert.equal(formatSharedWith(info), "- `contoso`\n- `SampleOrg`");
});

test("formatSharedWith reports an empty list and unreadable input distinctly", () => {
  assert.equal(formatSharedWith({ sharedWith: [] }), "_Not shared with any organization yet._");
  assert.equal(formatSharedWith({}), "_Not shared with any organization yet._");
  assert.equal(formatSharedWith(null), "_Could not read the access list from the Marketplace._");
  assert.equal(formatSharedWith("not json"), "_Could not read the access list from the Marketplace._");
});

test("formatSharedWith ignores malformed entries", () => {
  const info = { sharedWith: [{ name: "contoso" }, { id: 1 }, null, { name: "" }] };
  assert.equal(formatSharedWith(info), "- `contoso`");
});
