/*
 * hook-block.js — blocking a Stop, at most a few times.
 *
 * A Stop hook that blocks opens a correction loop with the session, and a loop
 * with no bound traps the turn. So every block is counted against a per-session
 * file and the cap ends it (mantahostels#844). Each guard keeps its own counter prefix, so
 * one guard's three blocks never spend another's.
 *
 * THE COUNTER PATH IS RESOLVED HERE, NOT BY THE CALLER (mantahostels#1798): never
 * `process.chdir` before calling, and never resolve the path yourself.
 *
 * THE BLOCK HAS ONE CHANNEL, AND IT IS `reason` (mantahostels#2319, mantahostels#2335, mantahostels#2350): it
 * reaches the founder and the model alike, so it carries the whole correction.
 * The measured channel rule lives in `docs/agents/guard-authoring.md` §Which
 * channel reaches the model.
 */

const fs = require("node:fs");
const path = require("node:path");
const { hostRoot } = require("./host-root.js");
const { markersDir } = require("./marker-root.js");
const { resolveScriptPaths } = require("./script-path.js");

/* Three allows a real correction cycle — the first block is the one that
 * teaches — while ending a session that still cannot produce the shape. */
const MAX_BLOCKS = 3;

/**
 * Where the per-session markers live: `.claude/tmp/markers` under the
 * repository root (mantahostels#3515 F8, #2) — root itself until that
 * move. The `.hook-ran-*` breadcrumbs sat beside them until mantahostels#3382
 * and are now a directory below — `hook-record.js`'s `recordsDir`, itself under
 * the same markers directory since F8.
 *
 * `WFC_REPO_ROOT` is first because it is the test-injection point: reverse the
 * order and the real `CLAUDE_PROJECT_DIR` of the session running the suite
 * wins, minting every test's counters in the shared tree. `hostRoot()` (#1)
 * supplies the rest — `CLAUDE_PROJECT_DIR` where the harness sets it, else the
 * git top level — so this function does not read `CLAUDE_PROJECT_DIR` itself.
 * @returns {string}
 */
function repoRoot() {
	return process.env.WFC_REPO_ROOT || hostRoot();
}

/**
 * Which guard is going dark, for the last-block notice. The entry script names
 * it in the spelling the session can grep for; a caller reached with no
 * `argv[1]` — `node -e`, an in-process harness — falls back to the counter
 * prefix, which is unique per call site either way.
 * @param {string} prefix
 * @returns {string}
 */
function guardName(prefix) {
	const entry = process.argv[1];
	return entry ? path.basename(entry) : prefix;
}

/**
 * The sentence appended to the last block a counter allows (mantahostels#2348).
 *
 * IT SPEAKS FOR THE COUNTER, NOT THE SCRIPT, and the two are not the same: a
 * guard holding two prefixes spends them independently, so
 * `guard-priced-options.js` exhausting `.green-suite-nagged-` still has three
 * `.priced-options-nagged-` blocks in hand.
 * @param {string} prefix
 * @param {number} max
 * @returns {string}
 */
function lastBlockNotice(prefix, max) {
	const spent =
		max === 1 ? "the single block" : `all ${String(max)} of the blocks`;
	return (
		`\n\nThis was ${guardName(prefix)}'s last Stop block on this check — its \`${prefix}\` counter has now spent ${spent} its cap allows. ` +
		"The rule still binds; nothing will refuse a repeat of this defect for the rest of the session. " +
		"Other checks in the same guard count on their own prefixes and may still block."
	);
}

/**
 * The per-session counter file for one guard's prefix.
 * @param {string} prefix
 * @param {string} sessionId
 * @returns {string}
 */
function counterPath(prefix, sessionId) {
	return path.join(markersDir(repoRoot()), prefix + sessionId);
}

/**
 * How many blocks this counter has recorded. A counter that will not read —
 * absent, or holding something that is not a number — reads as ZERO, so it
 * fails OPEN: a block otherwise owed is never silenced by a counter nobody can
 * count (mantahostels#844).
 *
 * A counter that reads as zero because it is SEALED is a different case, and it
 * ends the other way: `blockStop`'s own write then fails and it returns false
 * anyway.
 * @param {string} prefix
 * @param {string} sessionId
 * @returns {number}
 */
function readCount(prefix, sessionId) {
	try {
		return (
			Number.parseInt(
				fs.readFileSync(counterPath(prefix, sessionId), "utf8").trim(),
				10,
			) || 0
		);
	} catch {
		return 0;
	}
}

/**
 * Would `blockStop` refuse on this counter's cap alone? READ-ONLY: it never
 * mints or increments the counter, so asking costs nothing.
 *
 * It exists for a caller whose work BEFORE the block is expensive (mantahostels#2383): ask
 * here first and return early.
 *
 * IT ANSWERS ON THE CAP AND NOTHING ELSE. `blockStop` also refuses on an
 * unwritable counter, which is only knowable by attempting the write — so a
 * false here is "not capped", never "the block will be emitted".
 * @param {{prefix: string, sessionId: string, max?: number}} spec
 * @returns {boolean}
 */
function capSpent({ prefix, sessionId, max = MAX_BLOCKS }) {
	return readCount(prefix, sessionId) >= max;
}

/**
 * Spend one of a counter's blocks WITHOUT emitting anything (mantahostels#2786).
 *
 * It exists for a caller that reports several defects in ONE refusal: exactly
 * one of the contributing counters can pay through `blockStop`, which owns the
 * single stdout channel, and the rest are charged here.
 * @param {{prefix: string, sessionId: string, max?: number}} spec
 * @returns {boolean} whether a block was spent
 */
function charge({ prefix, sessionId, max = MAX_BLOCKS }) {
	const count = readCount(prefix, sessionId);
	if (count >= max) return false;
	try {
		fs.writeFileSync(counterPath(prefix, sessionId), `${String(count + 1)}\n`);
	} catch {
		/* Unwritable counter, and the caller has ALREADY emitted the block this
		 * charge was paying for — so unlike `blockStop`, refusing here cannot
		 * un-say anything. A machine that cannot write this file cannot bound the
		 * loop either way (mantahostels#2786). */
		return false;
	}
	return true;
}

/* IT CAPS SILENTLY, DELIBERATELY: no `lastBlockNotice`. The notice speaks on
 * stdout, which `blockStop` owns, so a limb capped through this path goes dark
 * unannounced. The session ceiling is what a reader is told about instead. */

/**
 * Whether the next block this counter allows is its last — what `blockStop`
 * appends `lastBlockNotice` on.
 * @param {{prefix: string, sessionId: string, max?: number}} spec
 * @returns {boolean}
 */
const isLastBlock = ({ prefix, sessionId, max = MAX_BLOCKS }) =>
	readCount(prefix, sessionId) === max - 1;

/**
 * Emit a Stop block on stdout, unless this session has had its cap already.
 * @param {{prefix: string, sessionId: string, reason: string,
 *   max?: number}} spec
 *   `prefix` names the counter file, so each guard counts separately.
 * @returns {boolean} whether the block was emitted
 */
function blockStop({ prefix, sessionId, reason, max = MAX_BLOCKS }) {
	const counter = counterPath(prefix, sessionId);
	const count = readCount(prefix, sessionId);
	if (count >= max) return false;
	const isLast = isLastBlock({ prefix, sessionId, max });
	try {
		fs.writeFileSync(counter, `${String(count + 1)}\n`);
	} catch {
		/* Unwritable counter means the loop cannot be bounded, so do not start
		 * one. */
		return false;
	}

	/* `isLast` is read before the write above, so it means "that write just
	 * took this counter to its cap". The core paths it names are spelled where
	 * an adopter can open them (#1010). */
	const text = isLast ? reason + lastBlockNotice(prefix, max) : reason;
	process.stdout.write(
		JSON.stringify({ decision: "block", reason: resolveScriptPaths(text) }),
	);
	return true;
}

module.exports = {
	blockStop,
	capSpent,
	charge,
	counterPath,
	isLastBlock,
	readCount,
	repoRoot,
	MAX_BLOCKS,
};
