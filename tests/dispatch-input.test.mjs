// Tests for the dispatch-input helper.
//
// Rationale: the share workflow hands the organization to the shell without printing it, so the two
// pieces that make that work - reading it from the event payload and quoting it for the shell - must
// be exact.
import test from "node:test";
import assert from "node:assert/strict";

import { dispatchInput, shellQuote } from "../ci/dispatch-input.mjs";

test("dispatchInput reads the named input and is empty when it is absent", () => {
  const payload = { inputs: { organization: "contoso", action: "share" } };
  assert.equal(dispatchInput(payload, "organization"), "contoso");
  assert.equal(dispatchInput(payload, "action"), "share");
  assert.equal(dispatchInput(payload, "missing"), "");
  assert.equal(dispatchInput({}, "organization"), "");
  assert.equal(dispatchInput(null, "organization"), "");
  assert.equal(dispatchInput({ inputs: { organization: 42 } }, "organization"), "");
});

test("shellQuote survives quotes and spaces", () => {
  assert.equal(shellQuote("contoso"), "'contoso'");
  assert.equal(shellQuote("two orgs"), "'two orgs'");
  assert.equal(shellQuote("it's"), "'it'\\''s'");
});
