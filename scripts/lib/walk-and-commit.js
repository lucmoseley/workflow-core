const { execFileSync } = require("node:child_process");
const { execGit } = require("./git.js");
const fs = require("node:fs");
const path = require("node:path");
const { upgrade } = require("./upgrade-walk.js");
const { measurerFor } = require("./core-context-cost.js");
const { ghLabels } = require("./core-owned-files.js");
const { readDirtyTracked, readUntrackedFiles } = require("./dirty-tree.js");
const { readStepsOwed } = require("./steps-owed.js");
const { caught } = require("./caught.js");
const { noop } = require("./noop.js");
const { CONFIG_PATH } = require("./workflow-core-config.js");

/**
 * @param {string} root
 * @returns {string|null}
 */
function readWalkedTo(root) {
	try {
		const doc = JSON.parse(
			fs.readFileSync(path.join(root, CONFIG_PATH), "utf8"),
		);
		return typeof doc.walkedTo === "string" ? doc.walkedTo : null;
	} catch {
		return null;
	}
}

/**
 * @param {string[]} args
 * @param {string} root
 */
function git(args, root) {
	return execGit(args, {
		cwd: root,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
}

/** @param {string} root */
function resetToClean(root) {
	git(["checkout", "--", "."], root);
	git(["clean", "-fd", "--"], root);
}

/** @param {string} root @returns {string[]|null} */
function readDirtyPaths(root) {
	const tracked = readDirtyTracked(root);
	const untracked = readUntrackedFiles(root);
	if (tracked === null || untracked === null) return null;
	return [...new Set([...tracked, ...untracked])].sort();
}

/** @param {unknown} err */
function reasonOf(err) {
	const e = caught(err);
	return e.stderr || e.stdout || e.message;
}

/**
 * @param {{root: string, paths: string[], message: string}} at
 * @returns {{ok: true}|{ok: false, step: "stage"|"commit", reason: string}}
 */
function commitPaths({ root, paths, message }) {
	try {
		git(["add", "--", ...paths], root);
	} catch (err) {
		return { ok: false, step: "stage", reason: reasonOf(err) };
	}
	try {
		git(["commit", "-q", "-m", message, "--", ...paths], root);
	} catch (err) {
		return { ok: false, step: "commit", reason: reasonOf(err) };
	}
	return { ok: true };
}

// workflow-core#682
/**
 * @param {{root: string, pluginRoot: string, out?: (line: string) => void,
 *   claudeBin?: string, configDir?: string}} at
 * @returns {{action: "dirty"|"unreadable"|"broken"|"committed"|"up-to-date",
 *   lines: string[]}}
 */
function walkAndCommit({ root, pluginRoot, out = noop, claudeBin, configDir }) {
	const measureCore = claudeBin
		? measurerFor({ root, claudeBin, configDir })
		: undefined;
	const labels = ghLabels(root);
	/** @type {string[]} */
	const lines = [];
	/** @param {string} line */
	const say = (line) => {
		lines.push(line);
		out(line);
	};

	const before = readDirtyPaths(root);
	if (before === null) {
		say(
			"migration walk: could not read the adopter tree's git status — skipped.",
		);
		return { action: "unreadable", lines };
	}
	if (before.length > 0) {
		say(
			"migration walk: the adopter tree is not clean — deferring to the next session's exit. " +
				"The walker's edits can never be mixed into the founder's own uncommitted work.",
		);
		return { action: "dirty", lines };
	}

	const stepsBefore = readStepsOwed(root);
	const walkLines = /** @type {string[]} */ ([]);
	const result = upgrade({
		root,
		pluginRoot,
		out: (l) => walkLines.push(l),
		measureCore,
		labels,
	});

	if (result.status === 2) {
		say(`migration walk: ${result.reason}`);
		return { action: "broken", lines };
	}

	if (result.status === 1) {
		const replayFault = replayFailure({
			root,
			pluginRoot,
			measureCore,
			labels,
		});
		if (replayFault !== null) {
			say(replayFault);
			return { action: "broken", lines };
		}
	}

	const after = readDirtyPaths(root);
	if (after === null) {
		say(
			"migration walk: could not read the adopter tree's git status after walking — skipped.",
		);
		return { action: "unreadable", lines };
	}

	const reasons = walkReasons(result);

	if (after.length === 0) {
		for (const line of reasons) say(line);
		say("migration walk: nothing to commit.");
		return { action: "up-to-date", lines };
	}

	const walkedTo = readWalkedTo(root);
	const message = buildCommitMessage(
		walkedTo,
		readStepsOwed(root),
		stepsBefore.length,
	);

	const fault = anchorAndCommit({ root, written: after, message });
	if (fault !== null) {
		say(fault);
		return { action: "broken", lines };
	}

	for (const line of reasons) say(line);
	say(
		walkedTo
			? `migration walk: committed, reaching ${walkedTo}.`
			: "migration walk: committed housekeeping output (no note verified).",
	);
	return { action: "committed", lines };
}

/**
 * @param {{root: string, written: string[], message: string}} at
 * @returns {string|null}
 */
function anchorAndCommit({ root, written, message }) {
	const left =
		"Nothing committed; the walk's output is left in the tree for inspection, " +
		"and the next session's exit will not retry until it is cleared by hand.";
	try {
		git(["add", "--", ...written], root);
	} catch (err) {
		return `migration walk: ${REFUSAL_CAUSE.stage} — ${reasonOf(err)}. ${left}`;
	}
	const anchored = anchorWalkOutput(root, written);
	if (!anchored.ok)
		return `migration walk: re-anchoring the walk's output failed — ${anchored.reason}. ${left}`;
	const paths = readDirtyPaths(root);
	if (paths === null)
		return `migration walk: could not read the adopter tree's git status after anchoring. ${left}`;
	const committed = commitPaths({ root, paths, message });
	if (!committed.ok)
		return [
			`migration walk: ${REFUSAL_CAUSE[committed.step]} — ${committed.reason}. ${left}`,
			...anchored.skipped,
		].join("\n");
	return null;
}

/**
 * @param {string} root
 * @param {string[]} written
 * @returns {{ok: true, skipped: string[]}|{ok: false, reason: string}}
 */
function anchorWalkOutput(root, written) {
	const checker = path.join(__dirname, "..", "check-guard-registry.js");
	const own = written.flatMap((p) => ["--own", p]);
	try {
		const stdout = execFileSync(
			process.execPath,
			[checker, "--review", ...written, ...own],
			{
				cwd: root,
				env: { ...process.env, CLAUDE_PROJECT_DIR: root },
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		const skipped = stdout
			.split("\n")
			.filter((l) => l.startsWith("not anchored "));
		return { ok: true, skipped };
	} catch (err) {
		return { ok: false, reason: reasonOf(err) };
	}
}

/**
 * @param {{root: string, pluginRoot: string,
 *   measureCore: import("./core-context-cost.js").Measurer|undefined,
 *   labels: import("./core-owned-files.js").Labels}} at
 * @returns {string|null}
 */
function replayFailure({ root, pluginRoot, measureCore, labels }) {
	const lastVerified = readWalkedTo(root);
	resetToClean(root);
	const replay = upgrade({
		root,
		pluginRoot,
		ceiling: lastVerified,
		out: noop,
		measureCore,
		labels,
	});
	if (replay.status === 0) return null;
	return (
		`migration walk: the half-way replay through ${lastVerified ?? "the start"} ` +
		`did not reproduce cleanly (${replay.reason ?? replay.status}) — ` +
		"leaving the tree as the replay left it for inspection."
	);
}

/** @param {{status: 0|1|2|3, reason?: string}} result @returns {string[]} */
function walkReasons(result) {
	const halfWayReason = result.status === 1 ? result.reason : null;
	const gapReason = result.status === 3 ? result.reason : null;
	return [gapReason, halfWayReason]
		.filter(Boolean)
		.map((reason) => `migration walk: ${reason}`);
}

/**
 * @param {string|null} walkedTo
 * @param {ReturnType<typeof readStepsOwed>} owedNow
 * @param {number} owedBefore
 * @returns {string}
 */
function buildCommitMessage(walkedTo, owedNow, owedBefore) {
	const newlyOwed = owedNow.slice(owedBefore);
	const summary = walkedTo
		? `migration walk: reached ${walkedTo}`
		: "migration walk: housekeeping only, no note verified";
	const body =
		newlyOwed.length > 0
			? [
					"",
					"stepsOwed:",
					...newlyOwed.map((s) => `- [${s.type}] (${s.tag}) ${s.text}`),
				]
			: [];
	return [summary, ...body].join("\n");
}

const REFUSAL_CAUSE = {
	commit:
		"the commit was refused — a rejecting pre-commit hook, a missing " +
		"commit identity, or another git problem",
	stage: "staging the walk's output failed",
};

module.exports = { walkAndCommit };
