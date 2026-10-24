/*
 * envelope-frame-keys.js — the `--json` envelope FRAME's own key names, in the
 * one place lib/check.js (the writer) and checker-new-faults.js (the reader)
 * both reach it (mantahostels#2600), on context-budget-tags.js's model.
 *
 * A SEPARATE FILE, DELIBERATELY: lib/check.js's `finish()` builds the frame,
 * and checker-new-faults.js's `doc-map` profile is a NEGATIVE predicate that
 * excludes it by name — everything not named is gate material by default.
 * Requiring lib/check.js FROM checker-new-faults.js would cycle back through
 * lib/check.js's own lazy require of checker-new-faults.js (`--against`'s
 * PROFILES lookup), which Biome's noImportCycles rule refuses.
 *
 * Constants only, and no requires — the same reason context-budget-tags.js
 * gives: a module pulled in behind two strings is a cost every session pays.
 */

/** @type {ReadonlySet<string>} */
const ENVELOPE_FRAME_KEYS = new Set([
	"checker",
	"outcome",
	"exit",
	"count",
	"keys",
	"text",
	"noun",
	"summary",
	"findings",
]);

module.exports = { ENVELOPE_FRAME_KEYS };
