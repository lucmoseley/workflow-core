/*
 * fault-profiles.js — each direction-gated checker's rule for what makes two
 * of its faults the same fault (mantahostels#1688). A whole-repo pre-commit
 * gate's identity fields, and why, sit on its lib/precommit-gates.js row. checker-new-faults.js,
 * report-new-shared-faults.js and lib/check.js's `--against` limb read
 * PROFILES; why a gate asks at all: lib/fault-diff.js.
 */

const { ENVELOPE_FRAME_KEYS } = require("./envelope-frame-keys.js");
const {
	OVER_CAP_TAGS,
	CLOSED_TRIGGER,
	SESSION_SURFACE_PREFIX,
	FRAGMENT_SURFACE_PREFIX,
} = require("./context-budget-tags");

const { REFUSES_COMMIT } = require("./refuses-commit.js");
const { GATES, SITE_IDENTITY } = require("./precommit-gates.js");

/** A finding's identity as the named fields, in the order given. */
const on =
	(/** @type {string[]} */ ...fields) =>
	(/** @type {any} */ item) =>
		JSON.stringify(fields.map((f) => item?.[f] ?? null));

/** Gate material: a FAIL finding. WARN findings never refuse a commit. */
const failsOnly = (/** @type {any} */ item) => item?.severity === "FAIL";

/** The finding's own message, which is what the hook prints back at the session. */
const message = (/** @type {any} */ item) =>
	typeof item?.message === "string" ? item.message : JSON.stringify(item);

/**
 * A checker whose faults ARE the `findings` list, one item per fault, each
 * carrying its own severity.
 *
 * 1. ONLY FAIL FINDINGS GATE, by default: a direction gate that refused on a
 *    new WARN would turn an advisory signal into a blocker. `guard-registry`
 *    widens it below, for the one WARN ruled a blocker on the commit.
 * 2. IDENTITY IS NAMED FIELDS, and it excludes `message`, `detail` and `line`.
 *    A staleness warning's message embeds anchor hashes — "anchored b75160cf…,
 *    now 7c36bffb…" — that move on any edit to the guard, and a FAIL's message
 *    embeds its line number, so the whole value would read an unchanged fault
 *    as new and refuse a bystander whose edit merely pushed it down the file.
 *
 * @param {(item: unknown) => string} identity
 * @returns {import("./fault-diff").FaultDiffProfile}
 */
const findingsProfile = (identity) => ({
	keys: (key) => key === "findings",
	identity,
	gating: failsOnly,
	label: message,
});

/*
 * The doc-map envelope keys that are not GATE material (mantahostels#1688, mantahostels#1785, mantahostels#2594).
 * `unreached` is report text, never a fault (check-doc-map.js's header).
 * `findings` is that checker's severity ENVELOPE rather than its item list —
 * its message carries the fault count, so comparing it would read a commit
 * that repairs one of three inherited faults as adding an object the baseline
 * lacks, and refuse the repair. `untracked` and `untrackedRoutes` are WARN
 * ONLY, always (mantahostels#1193, mantahostels#1403) — a register row or route naming a file that
 * merely has not been committed yet, normal mid-ticket state the checker
 * itself never fails on — so without this exclusion this profile's missing
 * `gating` predicate (unlike `findings`'s exclusion above) would still refuse
 * a commit adding one of these the moment the doc map ALSO carries any
 * unrelated, already-inherited FAIL, the same defeat mantahostels#1785 fixed for
 * `uncovered`/`dead`'s in-grace half.
 *
 * `keys` (mantahostels#2594) is not this checker's payload at all: it is lib/check.js's
 * envelope FRAME, the deduplicated key line of EVERY finding, WARN ones
 * included.
 *
 * THE RESIDUAL (mantahostels#2594) AND ITS FIX (mantahostels#2600): this is the table's only NEGATIVE
 * predicate, so every array lib/check.js ever grows on the frame is gate
 * material here by default. Neither of two other shapes is taken:
 *   - lib/fault-diff.js skipping the frame centrally, for every profile —
 *     cuts against its own documented contract that key policy is the
 *     caller's (lib/fault-diff.js's "EVERY POLICY IS THE CALLER'S").
 *   - naming check-doc-map.js's own ~21 `data` keys positively instead
 *     (mantahostels#2594) — that list goes stale against the checker
 *     rather than against this file, the harder staleness to see.
 * Taken instead: the frame stays this profile's call (so the contract holds),
 * but the SET OF FRAME KEYS is not hand-copied here — it is read off
 * lib/envelope-frame-keys.js's ENVELOPE_FRAME_KEYS, the one place both this
 * file and lib/check.js's `finish()` (which builds the frame) reach it,
 * chosen over requiring lib/check.js directly to avoid cycling back through
 * its own lazy require of this file (`--against`'s PROFILES lookup). A key
 * `finish()` adds to the frame joins this exclusion automatically PROVIDED it
 * also joins that Set — `finish()` itself throws before writing the envelope
 * if it ever doesn't, which is what keeps the two lists in step rather than a
 * comment.
 */
const DOC_MAP_NOT_A_FAULT = new Set([
	...ENVELOPE_FRAME_KEYS,
	"unreached",
	"untracked",
	"untrackedRoutes",
]);

/**
 * Where each FIXED capped surface's own total sits in a check-context-budget.js
 * envelope (mantahostels#1939). A table rather than a ternary so that a surface it does not
 * name measures nothing by default, and so that a further capped surface is one
 * entry here and no edit to the profile. Surfaces whose NAMES are derived go
 * through surfaceTotal() below instead.
 *
 * @type {Record<string, (envelope: any) => number | undefined>}
 */
const SURFACE_TOTAL = {
	pool: (envelope) => envelope?.total,
	injection: (envelope) => envelope?.injection?.total,
	"rule-ratchet": (envelope) => envelope?.session?.ratchet?.total,
};

/**
 * One surface's total out of an envelope.
 *
 * The session cap opens a surface PER TOOL (`session:Bash`), and which tools exist
 * is whatever `self-plugin/hooks/hooks.json` wires — so those cannot be table entries
 * without a list that goes stale the moment a matcher group is added. The
 * prefix is read instead, and the tool name is the rest of the string.
 *
 * `fragment:<id>` (mantahostels#2054) is the same idea over a THIRD derived set: which
 * fragments are over RULE_CAP is whatever the fragment store and the wired
 * guards make true, not a list kept here.
 *
 * It reads `session.fragmentBytes`, which carries every id a wired guard
 * reaches by either route, and not `session.overCap`, which names an id only
 * once it has already breached (mantahostels#2260).
 *
 * `Object.hasOwn` rather than a bare lookup: the envelope is JSON, so its
 * record carries Object.prototype, and an id spelling `constructor` would
 * resolve to a function.
 *
 * @param {unknown} surface
 * @param {any} envelope
 * @returns {number | undefined}
 */
function surfaceTotal(surface, envelope) {
	if (typeof surface !== "string") return;
	const fixed = Object.hasOwn(SURFACE_TOTAL, surface)
		? SURFACE_TOTAL[surface]
		: undefined;
	if (fixed) return fixed(envelope);
	if (surface.startsWith(FRAGMENT_SURFACE_PREFIX)) {
		const byId = envelope?.session?.fragmentBytes;
		const id = surface.slice(FRAGMENT_SURFACE_PREFIX.length);
		return byId && Object.hasOwn(byId, id) ? byId[id] : undefined;
	}
	if (!surface.startsWith(SESSION_SURFACE_PREFIX)) return;
	return envelope?.session?.tools?.[
		surface.slice(SESSION_SURFACE_PREFIX.length)
	]?.bytes;
}

/** @type {Record<string, import("./fault-diff").FaultDiffProfile>} */
const GATE_PROFILES = Object.fromEntries(
	GATES.map((g) => [
		g.id,
		findingsProfile(on(...(g.identity ?? SITE_IDENTITY))),
	]),
);

/**
 * @param {string} id a lib/precommit-gates.js row's id
 * @returns {import("./fault-diff").FaultDiffProfile}
 */
function gateProfile(id) {
	const profile = GATE_PROFILES[id];
	if (!profile) throw new Error(`lib/precommit-gates.js has no ${id} row`);
	return profile;
}

/** @type {Record<string, import("./fault-diff").FaultDiffProfile>} */
const PROFILES = {
	...GATE_PROFILES,
	/*
	 * guard-registry gates a WARN too (#2617): a commit that leaves an anchor
	 * expired is refused, while the full run only warns. The checker marks
	 * which warnings those are, so REPRINTED stays a note.
	 */
	"guard-registry": {
		...gateProfile("guard-registry"),
		gating: (/** @type {unknown} */ item) =>
			failsOnly(item) ||
			(typeof item === "object" &&
				item !== null &&
				Object.hasOwn(item, REFUSES_COMMIT) &&
				/** @type {Record<string, unknown>} */ (item)[REFUSES_COMMIT] === true),
	},
	/*
	 * check-doc-map.js (mantahostels#1688), whose envelope is the other shape: the faults are
	 * the TOP-LEVEL lists — `uncovered`, `dead`, `pointerFaults`, the route lists —
	 * one list per fault kind, so the key IS the kind.
	 *
	 * IDENTITY IS THE WHOLE JSON VALUE: `pointerFaults` and the route lists hold
	 * objects, and comparing them by any one field would read an entry whose id
	 * was reused as unchanged.
	 */
	/*
	 * check-context-budget.js (mantahostels#1834), the one profile whose faults carry a
	 * MEASUREMENT, and the reason lib/fault-diff.js has `family`/`worse` at all.
	 *
	 * GATE MATERIAL DESPITE BEING WARN. The two over-cap findings are WARN by
	 * design — the caps are ratchets against drift, not measured limits, and
	 * gating on the LEVEL teaches the reader to skip the gate (mantahostels#1224). What
	 * refuses a commit is the DIRECTION, which is this table's question, so the
	 * predicate tests membership of the over-cap tag set rather than reading
	 * severity — lib/context-budget-tags.js, which the checker raises them from,
	 * so a rename cannot leave this gate matching nothing (mantahostels#1938).
	 *
	 * IDENTITY CARRIES `total`, FAMILY DOES NOT. Two readings of one surface at
	 * different byte totals are different faults, or a commit that adds bytes to
	 * an already-over-cap pool would read as inherited and pass — the exact
	 * refusal mantahostels#1224 exists for. `worse` is then what stops the mirror image: a
	 * commit that SHEDS bytes and leaves the surface still over cap shares the
	 * family, is not worse, and passes.
	 *
	 * `admissibility` is the checker's own top-level key, one item, no severity —
	 * so it is not gate material, and --against reports it as a note. It is a
	 * measurement for exactly the same reason: the prompt fires on growth.
	 *
	 * `unadmitted` is every pool rule the admission ledger does not admit, empty
	 * where the gate is switched off (#2033). Gate material only as an addition:
	 * the pool held rules before the ledger did, so one already at <rev> is no
	 * fault.
	 *
	 * `CLOSED_TRIGGER` is index-side only (lib/context-budget-tags.js).
	 */
	"context-budget": {
		keys: (key) =>
			key === "findings" || key === "admissibility" || key === "unadmitted",
		gating: (/** @type {any} */ item, key) =>
			key === "unadmitted" ||
			(key === "findings" &&
				(item?.severity === "FAIL" || OVER_CAP_TAGS.has(item?.tag))),
		newOnly: (key) => key === "unadmitted",
		indexOnly: (item, key) =>
			key === "findings" &&
			/** @type {{ tag?: unknown } | undefined} */ (item)?.tag ===
				CLOSED_TRIGGER,
		identity: (/** @type {any} */ item, key) => {
			if (key === "unadmitted") return on("file", "headline")(item);
			return key === "findings"
				? on("tag", "surface", "total")(item)
				: on("surface", "bytes")(item);
		},
		family: (/** @type {any} */ item, key) => {
			if (key === "unadmitted") return on("file", "headline")(item);
			return key === "findings"
				? on("tag", "surface")(item)
				: on("surface")(item);
		},
		worse: (/** @type {any} */ a, /** @type {any} */ b, key) => {
			if (key === "unadmitted") return false;
			return key === "findings" ? a?.total > b?.total : a?.bytes > b?.bytes;
		},
		/*
		 * lib/check.js runs this over the staged item against BOTH envelopes, so
		 * the pair is one surface read twice (mantahostels#1939).
		 *
		 * READ OFF THE ENVELOPE, NEVER OFF A BASELINE FAULT: the checker raises a
		 * finding only where the cap is breached, and the envelope carries both
		 * totals whether anything breached or not (check-context-budget.js's
		 * `data`).
		 *
		 * `UNPARSEABLE-SETTINGS` is why the table's default matters: it carries no
		 * `surface` and no measurement, so a delta beside it would tell a session to
		 * shed pool bytes to answer a JSON syntax error. A run carrying it is BROKEN
		 * before any diff is composed (mantahostels#2004), so the guard is asserted against
		 * this profile directly rather than through the gate.
		 */
		unit: "B",
		measure: (/** @type {any} */ item, key, /** @type {any} */ envelope) => {
			if (key === "unadmitted") return;
			return key === "findings"
				? surfaceTotal(item?.surface, envelope)
				: envelope?.admissibility?.find(
						(/** @type {any} */ a) => a?.surface === item?.surface,
					)?.bytes;
		},
		label: (/** @type {any} */ item, key) =>
			key === "findings" ? message(item) : String(item?.message ?? ""),
	},
	"doc-map": {
		keys: (key) => !DOC_MAP_NOT_A_FAULT.has(key),
		identity: (item) => JSON.stringify(item),
	},
};

module.exports = { PROFILES };
