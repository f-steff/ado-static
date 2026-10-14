// Tests for the share-reporting helper.
//
// Rationale: the share workflow's summary is public, so it must report a *count* and never the names of
// the organizations that may install the private dev edition.
import test from "node:test";
import assert from "node:assert/strict";

import { summariseSharedWith } from "../ci/shared-with.mjs";

test("summariseSharedWith counts the organizations without naming them", () => {
  const summary = summariseSharedWith({ sharedWith: [{ name: "contoso" }, { name: "SampleOrg" }] });
  assert.equal(summary, "**2** organizations have access (the names are on the publisher page).");
  // The names must never leak into the summary.
  assert.equal(summary.includes("contoso"), false);
  assert.equal(summary.includes("SampleOrg"), false);
});

test("summariseSharedWith uses the singular for one organization", () => {
  assert.equal(
    summariseSharedWith({ sharedWith: [{ name: "contoso" }] }),
    "**1** organization has access (the names are on the publisher page)."
  );
});

test("summariseSharedWith reports an empty list and unreadable input distinctly", () => {
  assert.equal(summariseSharedWith({ sharedWith: [] }), "_No organization currently has access._");
  assert.equal(summariseSharedWith({}), "_No organization currently has access._");
  assert.equal(summariseSharedWith(null), "_Could not read the access list from the Marketplace._");
  assert.equal(summariseSharedWith("not json"), "_Could not read the access list from the Marketplace._");
});

test("summariseSharedWith ignores malformed entries", () => {
  assert.equal(
    summariseSharedWith({ sharedWith: [{ name: "contoso" }, { id: 1 }, null, { name: "" }] }),
    "**1** organization has access (the names are on the publisher page)."
  );
});
