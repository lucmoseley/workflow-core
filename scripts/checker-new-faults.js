#!/usr/bin/env node
/*
 * Which of a checker's faults THIS COMMIT introduced (mantahostels#1688, mantahostels#1753, mantahostels#1797).
 *
 *   node scripts/checker-new-faults.js <profile> <staged.json> <baseline.json>
 *
 * The two arguments are one checker's `--json` output read twice — this
 * commit's, and a HEAD baseline. Why a gate asks at all: lib/fault-diff.js.
 *
 * NOT A `check-*` SCRIPT, and deliberately (§N3/§G4): it gates nothing and reads
 * no repository state, so runCheck's five-outcome alphabet has nothing to say
 * here — these three codes are a set-difference verdict, not a severity.
 *
 *   exit 0  every fault is inherited — WARN and pass
 *   exit 1  the lines printed are faults this commit adds — refuse
 *   exit 2  could not answer — the caller must refuse, not assume inherited
 */

const { parseOrExit } = require("./lib/cli-args");
const { runCli } = require("./lib/fault-diff");
const { ENVELOPE_FRAME_KEYS } = require("./lib/envelope-frame-keys.js");
const {
	OVER_CAP_TAGS,
	CLOSED_TRIGGER,
	SESSION_SURFACE_PREFIX,
	FRAGMENT_SURFACE_PREFIX,
} = require("./lib/context-budget-tags");

/** A finding's identity as the named fields, in the order given. */
const { REFUSES_COMMIT } = require("./lib/refuses-commit.js");

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
 * @returns {import("./lib/fault-diff").FaultDiffProfile}
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
 * fragments are over GP_RULE_CAP is whatever the fragment store and the wired
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

/** @type {Record<string, import("./lib/fault-diff").FaultDiffProfile>} */
const PROFILES = {
	/*
	 * `file` + `rule` rather than the whole object: every FAIL kind this checker
	 * raises carries both, and together they name which rule in which file is
	 * unbacked. A staleness warning carries neither, and `guard` names its path.
	 *
	 * It gates a WARN too (#2617): a commit that leaves an anchor expired is
	 * refused, while the full run only warns. The checker marks which
	 * warnings those are, so REPRINTED stays a note.
	 */
	"guard-registry": {
		...findingsProfile(on("severity", "tag", "file", "rule", "guard")),
		gating: (/** @type {unknown} */ item) =>
			failsOnly(item) ||
			(typeof item === "object" &&
				item !== null &&
				Object.hasOwn(item, REFUSES_COMMIT) &&
				/** @type {Record<string, unknown>} */ (item)[REFUSES_COMMIT] === true),
	},
	/*
	 * The subject is the test file. `guards` is excluded deliberately: the list
	 * grows when an unrelated guard starts sourcing lib/guard-log.sh, and that
	 * must not turn an inherited fault into a new one.
	 */
	"guard-test-isolation": findingsProfile(on("severity", "tag", "file")),
	/*
	 * The subject is the test file, matching `guard-test-isolation` above.
	 * `scripts` is excluded deliberately: the list grows when an unrelated
	 * script starts requiring lib/host-root.js, and that must not turn an
	 * inherited fault into a new one (#160).
	 */
	"host-root-test-isolation": findingsProfile(on("severity", "tag", "file")),
	/*
	 * The subject is the script file (#917). `line` is excluded: an edit
	 * higher in the file moves an inherited fault, and that is no new one.
	 */
	"host-root": findingsProfile(on("severity", "tag", "file")),
	/*
	 * The subject is the test file (mantahostels#2355). `repos` is excluded deliberately,
	 * matching `guard-test-isolation`'s `guards` exclusion above: a second repo
	 * key joining an already-faulted file's finding must not read as a new
	 * fault.
	 */
	"git-fixture-identity": findingsProfile(on("severity", "tag", "file")),
	/*
	 * The subject is one banned tell in one file. `line` is excluded for the
	 * reason above — an edit higher up the file moves every tell below it — and
	 * `context` with it, that being the surrounding words, which a rewrite of the
	 * neighbouring sentence changes without touching the tell.
	 *
	 * Two identical tells in one file therefore share an identity, so removing
	 * one of them alone reads as unchanged. That is the right answer here: what
	 * refuses a commit is introducing a tell, and the file still carries it.
	 */
	"website-copy": findingsProfile(on("severity", "tag", "file", "match")),
	/*
	 * The subject is the skill file (#887). `at` is excluded: a line added
	 * above an inherited parse error moves it, and that is no new fault.
	 */
	"skill-frontmatter": findingsProfile(on("severity", "tag", "file")),
	/* `key` names the member and what it lacks, so an adopter's inherited gaps
	 * never refuse and a new one does (#1456). */
	registrations: findingsProfile(on("severity", "tag", "key")),
	/*
	 * The subject is the script file AT ITS CONTENT (#920): `content` is the
	 * file's hash, so a commit editing an inherited script still on no strict
	 * parser refuses — the ratchet that moves each onto one when next touched.
	 */
	"cli-args": findingsProfile(on("severity", "tag", "file", "content")),
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

if (require.main === module) {
	const [profile, stagedFile, baselineFile] = parseOrExit(
		process.argv.slice(2),
		{
			usage:
				"usage: node scripts/checker-new-faults.js <profile> <staged.json> <baseline.json>",
			min: 3,
		},
	).positionals;
	const chosen = profile === undefined ? undefined : PROFILES[profile];
	if (!chosen) {
		/* writeSync, not console: the hook reads this through a pipe (§N6). */
		require("node:fs").writeSync(
			2,
			`checker-new-faults: unknown profile ${JSON.stringify(profile ?? "")} — ` +
				`expected one of ${Object.keys(PROFILES).join(", ")}.\n`,
		);
		process.exit(2);
	}
	runCli("checker-new-faults", stagedFile, baselineFile, chosen);
}
