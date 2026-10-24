/*
 * dispatch-ledger.js — `.pick-next/dispatched.jsonl`, the record
 * scripts/dispatch-sessions.sh appends to as each session launches.
 *
 * TWO READERS, ONE SEAM (mantahostels#1528). check-duplicate-dispatch.js drops a set member
 * whose issues are already in here; pick-next.js holds those same issues out of
 * the frontier, so a run never offers work the launcher will then delete. They
 * must agree on the path, the window, what counts as an issue number and what
 * counts as the command (workflow-core#752), so both read it from here rather than
 * restating it.
 */

const fs = require("node:fs");
const { markersDir } = require("./marker-root.js");
const path = require("node:path");
const { hostRoot } = require("./host-root.js");
const { requiredGroup } = require("./regex-group.js");
const { caught } = require("./caught.js");

/** A prompt's leading `/<skill>`, any `<plugin>:` namespace aside. */
const COMMAND_RE = /^\s*\/(?:[\w.-]+:)?([\w.-]+)/;

/*
 * THE WINDOW IS A JUDGEMENT, NOT A MEASUREMENT. One hour. mantahostels#1337's six, and the
 * two that replaced it, each hid an issue whose launch had already finished
 * from the re-pick for most of a working session.
 * A legitimate re-dispatch of the same issue inside it takes `--force`.
 */
const DEFAULT_WINDOW_HOURS = 1;

/**
 * The tree the ledger lives under.
 *
 * WFC_DISPATCH_ROOT redirects the ledger ALONE, leaving WFC_REPO_ROOT to
 * mean what it means everywhere else: `scripts/dispatch-sessions.test.ts` drives
 * the real launcher against a stubbed `claude`, so without it those runs would
 * append fake launches to the working ledger and refuse the next real dispatch.
 * Every reader resolves it here, so a caller passing its own repo root cannot
 * silently read a different file from the one the launcher wrote (mantahostels#1528).
 * @returns {string}
 */
function ledgerRoot() {
	return (
		process.env.WFC_DISPATCH_ROOT || process.env.WFC_REPO_ROOT || hostRoot()
	);
}

/** @returns {string} the ledger path — one JSON object per line, append-only. */
function ledgerPath(root = ledgerRoot()) {
	return path.join(markersDir(root), ".pick-next", "dispatched.jsonl");
}

/**
 * Every issue number in a launch prompt. Prompts are `/<skill> <issues>`, so
 * every integer in one is an issue number.
 *
 * Residual: a prompt carrying a non-issue integer records a phantom issue, which
 * then refuses an unrelated dispatch of that number and hides it from the
 * frontier for the window. `--force` is the way out (mantahostels#1337).
 * @param {string} prompt
 * @returns {number[]}
 */
function issuesIn(prompt) {
	return (prompt.match(/\d+/g) || []).map(Number);
}

/**
 * The command a launch prompt runs — its leading `/<skill>` token, slash and
 * any `<plugin>:` namespace dropped — or `null` where the prompt opens with
 * none (workflow-core#752). The skill names the `takes:` values carry, so `/triage 34` and
 * `/workflow-core:triage 34` both read `triage`, which the picker compares with
 * the issue's label.
 * @param {unknown} prompt
 * @returns {string|null}
 */
function commandOf(prompt) {
	if (typeof prompt !== "string") return null;
	const m = prompt.match(COMMAND_RE);
	return m ? requiredGroup(m, 1, COMMAND_RE) : null;
}

/**
 * Whether a ledger entry holds its issues against a launch of `command` (workflow-core#752).
 * The hold keys on issue AND command, so `/wayfinder 34` after `/triage 34`
 * passes and a second `/triage 34` does not. It FAILS TOWARD THE HOLD: an
 * entry or a launch whose command cannot be read — a hand-written
 * prompt, a flat `--issues 341,353` — holds.
 * @param {{prompt?: unknown}|undefined} rec
 * @param {string|null} command
 */
function entryHolds(rec, command) {
	const held = commandOf(rec?.prompt);
	return held === null || command === null || held === command;
}

/**
 * One line of `.pick-next/dispatched.jsonl`.
 *
 * `session` is the LAUNCHING session — the one that ran dispatch-sessions.sh —
 * never the launched job's own session (mantahostels#3488). `jobId` is that
 * job's own short id, the one `claude --bg` prints and
 * `claude stop`/`claude attach` take — `null` on an entry written before
 * mantahostels#3488 landed, which is the "unknown" case downstream readers
 * fall back to.
 * An entry written before workflow-core#1200 may carry a `successorOf` field; nothing
 * reads it.
 * @typedef {{ts: string, issues: number[], model: string, prompt: string,
 *            session: string|null, jobId: string|null}} DispatchRecord
 */

/**
 * Ledger entries inside the window. A malformed line is skipped rather than
 * failing the read — the ledger is append-only and a torn write must not
 * disarm every later check.
 * @param {string|undefined} root
 * @param {number} windowHours
 * @returns {{ok: boolean, entries: DispatchRecord[], error?: string}}
 */
function recentEntries(root, windowHours) {
	const file = ledgerPath(root);
	let text;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch (err) {
		if (caught(err).code === "ENOENT") {
			return { ok: true, entries: [] }; // never launched from here: not a failure
		}
		return { ok: false, entries: [], error: String(err) };
	}
	const cutoff = Date.now() - windowHours * 3600 * 1000;
	const entries = /** @type {DispatchRecord[]} */ ([]);
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		let rec;
		try {
			rec = JSON.parse(line);
		} catch {
			continue;
		}
		const at = Date.parse(rec.ts);
		if (Number.isNaN(at) || at < cutoff) continue;
		entries.push(rec);
	}
	return { ok: true, entries };
}

/**
 * The latest launch's time in ms, any age, or null where this tree never
 * launched — the refill loop's cross-repo tie-break, which reads null as
 * launched longest ago. An unreadable ledger fails open to null too: it only
 * orders full ties, so the cost is that repo winning them (workflow-core#2003).
 * @param {string} root
 * @returns {number|null}
 */
function lastLaunchAt(root) {
	const { entries } = recentEntries(root, Number.POSITIVE_INFINITY);
	return entries.reduce(
		(/** @type {number|null} */ latest, e) =>
			Math.max(latest ?? 0, Date.parse(e.ts)),
		null,
	);
}

/**
 * Append one launch. Never throws: a ledger that cannot be written must not
 * stop a launch that has already been permitted.
 * @param {{issues: number[], model: string, prompt: string, root?: string, jobId?: string|null}} entry
 * @returns {boolean} whether it was written
 */
function record(entry) {
	const file = ledgerPath(entry.root);
	const line = `${JSON.stringify({
		ts: new Date().toISOString(),
		issues: entry.issues,
		model: entry.model,
		prompt: entry.prompt,
		session: process.env.CLAUDE_CODE_SESSION_ID || null,
		jobId: entry.jobId || null,
	})}\n`;
	try {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.appendFileSync(file, line);
		return true;
	} catch {
		return false;
	}
}

module.exports = {
	DEFAULT_WINDOW_HOURS,
	ledgerPath,
	issuesIn,
	commandOf,
	entryHolds,
	recentEntries,
	lastLaunchAt,
	record,
};
