#!/usr/bin/env node
/*
 * run-pinned-guards.js — runs this repo's guard entry from the pinned guard code
 * (#4227, #4203): `node run-pinned-guards.js <link>/scripts/guard-dispatch.js`, the
 * link lib/guard-code.js keeps at the last guard code that passed its probe.
 *
 * DEPENDENCY-FREE, node's own modules alone: it is the one file the hook line
 * runs from the main checkout, so no edit to a shared lib can break it.
 *
 * FAIL-CLOSED STAYS TOTAL. Where the entry is missing or throws while it
 * loads or runs, the shim refuses with exit 2, the error's first line and the
 * founder's one-line `!` repair: point the link back at the previous code
 * and never adopt the failing sha again, or, with no previous code (a fresh
 * machine), set the link up with scripts/adopt-guard-code.js. A throw while
 * judging the call offers that repair only where every call fails so.
 *
 * IMPLICIT: on every call the guard entry's registrations match, runs scripts/guard-dispatch.js from the pinned guard code, and refuses the call with exit 2 where that code is missing or throws.
 * JUSTIFIED: fail-safe — a guard that cannot run must not let the call through (#4125), and the refusal carries the founder's repair, as the refused session cannot make it (#4203).
 * DEFEAT: `WFC_GUARD_CODE_DIR` in the environment Claude Code was started in names another code directory, and a link repointed by hand runs whatever it names.
 * TREE: host — the pinned guard code; the dispatcher it runs picks each core's tree (#4242).
 *
 * LIMITS
 *  - An entry's asynchronous throw after its first tick is not caught here:
 *    it exits non-zero, which the PreToolUse registration's `onFailure:
 *    "block"` refuses, without the repair line.
 */

const fs = require("node:fs");
const path = require("node:path");

/* lib/sh-quote.js's shellQuote and lib/pinned-code.js's SHA_SHOWN, copied:
 * the shim requires nothing of the repo's (local §LG1's marked copy). Its
 * refusals' openings are in lib/core-fault.js's lockout texts, copied too, as
 * the refill loop reads a session refused only so as locked out (#4228). */
/** @param {string} word */
const shellQuote = (word) => `'${word.replaceAll("'", "'\\''")}'`;
const SHA_SHOWN = 9;

/** @param {string} text */
function refuse(text) {
	fs.writeSync(2, `${text}\n`);
	process.exit(2);
}

// cli-args-exempt: every word after the entry is the entry's own, handed through unparsed.
const target = process.argv[2];
if (!target)
	refuse(
		"run-pinned-guards.js: no guard entry named — usage: run-pinned-guards.js <entry>",
	);
const entry = /** @type {string} */ (target);
const link = path.dirname(path.dirname(entry));
const previous = link.replace(/\.current$/, ".previous");
const refused = link.replace(/\.current$/, ".refused");
const adopt = `node ${shellQuote(path.join(__dirname, "adopt-guard-code.js"))}`;

if (!fs.existsSync(entry))
	refuse(
		`Guard code missing: no ${entry}, so ${link} is absent or names nothing (as on a fresh machine). Every call is refused until it is set up. The repair, for the founder to paste:\n  ! ${adopt}`,
	);

/**
 * Refuse on `err`, thrown by the code the link names.
 * @param {unknown} err
 * @param {boolean} loading
 */
function refuseOn(err, loading) {
	const first = String(err instanceof Error ? err.message : err).split("\n")[0];
	let sha = "";
	try {
		sha = path.basename(fs.realpathSync(link));
	} catch {
		// A link gone mid-call: the repair below still names it.
	}
	const back = fs.existsSync(previous);
	const repair = back
		? `mv -T ${shellQuote(previous)} ${shellQuote(link)} && echo ${shellQuote(sha)} >> ${shellQuote(refused)}`
		: adopt;
	const when = loading
		? "It fails to load, so every guarded call is refused and every PostToolUse core silenced until it is repaired."
		: "It threw judging this call. Where every call fails so, it is the code's fault, and";
	refuse(
		`Guard code failed in ${link}${sha ? ` (${sha.slice(0, SHA_SHOWN)})` : ""}: ${first}\n${when} The repair, for the founder to paste, which ${back ? "points the link back at the previous guard code and never adopts this one again" : "adopts the newest guard code that loads, once a fix for this one reaches origin/main"}:\n  ! ${repair}`,
	);
}

try {
	require(path.join(path.dirname(entry), "lib", "guard-dispatch.js"));
} catch (err) {
	refuseOn(err, true);
}
/* The entry reads its own name and flags from argv, as if run directly. */
process.argv.splice(1, 2, entry);
try {
	require(entry);
} catch (err) {
	refuseOn(err, false);
}
