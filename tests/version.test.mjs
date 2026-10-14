// Tests for the release version rules.
//
// Rationale: both editions now share one tag sequence and a release publishes both at the same
// version, so these rules decide what reaches the Marketplace - they were previously untested.
import test from "node:test";
import assert from "node:assert/strict";

import { nextVersion, parseTags } from "../ci/version.mjs";

/** Builds the tag list from `vX.Y.Z` strings. */
const tags = (...list) => parseTags(list.join("\n"));

test("parseTags ignores anything that is not vX.Y.Z", () => {
  assert.deepEqual(parseTags("v0.1.0\nnot-a-tag\nv1\nv0.2.3\n"), [
    { minor: 1, revision: 0 },
    { minor: 2, revision: 3 }
  ]);
  assert.deepEqual(parseTags(""), []);
});

test("with no tags the first stable is 0.1.0 and the first dev is 0.0.1", () => {
  assert.equal(nextVersion("stable", tags()), "0.1.0");
  assert.equal(nextVersion("dev", tags()), "0.0.1");
});

test("dev revisions bump while no stable exists, and the first release resets the line", () => {
  const devOnly = tags("v0.0.1", "v0.0.2", "v0.0.9");
  assert.equal(nextVersion("dev", devOnly), "0.0.10");
  assert.equal(nextVersion("stable", devOnly), "0.1.0");
});

test("after the 0.1.0 release, dev continues on the released minor", () => {
  const afterRelease = tags("v0.0.9", "v0.1.0");
  assert.equal(nextVersion("dev", afterRelease), "0.1.1");
  assert.equal(nextVersion("stable", afterRelease), "0.2.0");
});

test("dev revisions accumulate on the current minor and a release moves both editions", () => {
  const midCycle = tags("v0.1.0", "v0.1.1", "v0.1.2", "v0.1.3");
  assert.equal(nextVersion("dev", midCycle), "0.1.4");
  assert.equal(nextVersion("stable", midCycle), "0.2.0");
  // The release publishes both editions at 0.2.0, so that tag starts the next cycle.
  const afterNext = tags("v0.1.3", "v0.2.0");
  assert.equal(nextVersion("dev", afterNext), "0.2.1");
  assert.equal(nextVersion("stable", afterNext), "0.3.0");
});

test("the highest revision-0 tag decides the base minor", () => {
  const odd = tags("v0.1.0", "v0.2.0", "v0.3.5");
  assert.equal(nextVersion("stable", odd), "0.3.0");
  // Dev follows the released minor, so a stray higher revision does not move the line.
  assert.equal(nextVersion("dev", odd), "0.2.1");
});
