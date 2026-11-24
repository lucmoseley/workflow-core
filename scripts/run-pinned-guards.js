#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

// workflow-core#4227 workflow-core#4228
/** @param {string} word */
const shellQuote = (word) => `'${word.replaceAll("'", "'\\''")}'`;
const SHA_SHOWN = 9;

/** @param {string} text */
function refuse(text) {
	fs.writeSync(2, `${text}\n`);
	process.exit(2);
}

// cli-args-exempt: workflow-core#5540
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
 * @param {unknown} err
 * @param {boolean} loading
 */
function refuseOn(err, loading) {
	const first = String(err instanceof Error ? err.message : err).split("\n")[0];
	let sha;
	try {
		sha = path.basename(fs.realpathSync(link));
	} catch {
		sha = "";
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
process.argv.splice(1, 2, entry);
try {
	require(entry);
} catch (err) {
	refuseOn(err, false);
}
