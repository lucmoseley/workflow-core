#!/usr/bin/env node
/*
 * score-session-breaches.js — the before/after test's per-session score, read
 * off each main-session transcript in an arm's projects directory (#2042).
 *
 *   node scripts/score-session-breaches.js (--dir <projects dir> | --file <transcript>) [--json]
 *
 * With `lib/breach-score-rule.js`, which holds the classes, this is the
 * PRE-REGISTERED SCORING RULE (`docs/research/startup-load-before-after-test.md`
 * D3), committed before any run.
 *
 * Score = breach-class Stop refusals + every PreToolUse deny not of the
 * environment class, from the main transcript only:
 *
 *   A STOP REFUSAL is one `hook_blocking_error` attachment on `hookEvent:
 *     "Stop"`, deduped on its `toolUseID` plus the first 200 characters of its
 *     text (D3, by way of F2). Its "Stop hook feedback" user copy is never read. The guard is the
 *     script `blockingError.command` names.
 *   A PRETOOLUSE DENY is an `is_error` tool_result opening
 *     `PreToolUse:<Tool> hook error: `, deduped on its `tool_use_id`. Its guard
 *     comes from `guard-fire-needles.json`, on the deny route.
 *
 * A Stop guard with no class stops the scan (exit 2).
 *
 * Families reported beside the score: `inventory` and `jobDir`, which count
 * in it; `concision`, a demanded step, which does not.
 *
 * IN NO §N3 FAMILY, DELIBERATELY: it gates nothing, runs from a prompt, writes
 * no file and files no issue.
 */

const fs = require("node:fs");
const path = require("node:path");
const {
	guardKey,
	needleIn,
	registeredGuardSubjects,
	transcriptFiles,
} = require("./lib/guard-fires");
const { mainChainRecords } = require("./lib/transcript");
const { hostRoot } = require("./lib/host-root.js");
const { flagValue, parseOrExit } = require("./lib/cli-args");
const { writeFd } = require("./lib/write-fd.js");

/** @type {import("./lib/cli-args").CliSpec} */
const CLI = {
	usage:
		"Usage: node scripts/score-session-breaches.js (--dir <projects dir> | --file <transcript>) [--json]",
	flags: { "--dir": "value", "--file": "value", "--json": "boolean" },
};

const {
	STOP_CLASS,
	ENVIRONMENT_DENY,
	INVENTORY,
	JOB_DIR,
	DENY_GUARD_JOIN,
	UNATTRIBUTED,
} = require("./lib/breach-score-rule.js");

/** F2: the prefix the harness gives a denied call's error result. */
const DENY_HEAD = /^PreToolUse:\S+ hook error: /;
/** D3, by way of F2: a Stop refusal dedupes on its text's first 200 characters. */
const STOP_KEY_CHARS = 200;

/** @param {string} key */
const scriptOf = (key) => key.replace(/ .*/s, "");

/**
 * The guards whose deny needles a refusal's text carries, read against this
 * repo's own registry.
 * @returns {(text: string) => string[]}
 */
function buildDenyAttributor() {
	const subjects = registeredGuardSubjects(hostRoot());
	return (text) =>
		subjects
			.filter((s) =>
				s.needles.some((n) => n.kind === "deny" && needleIn(text, n)),
			)
			.map((s) => scriptOf(s.id.slice("guard:".length)));
}

/**
 * @param {Record<string, number>} counts accumulator: `key`'s count is raised
 * @param {string} key
 */
const bump = (counts, key) => {
	counts[key] = (counts[key] || 0) + 1;
};

/**
 * @param {unknown} c a tool_result's content
 * @returns {string}
 */
function resultText(c) {
	if (typeof c === "string") return c;
	if (!Array.isArray(c)) return "";
	return c.map((q) => (typeof q?.text === "string" ? q.text : "")).join("");
}

/**
 * @typedef {{kind: "stop", key: string, guard: string}
 *   | {kind: "deny", key: string, text: string}} Refusal
 */

/**
 * The Stop refusal and PreToolUse denies one record carries, each with the
 * key it dedupes on.
 * @param {import("./lib/guard-fires").LogRecord} record
 * @returns {Refusal[]}
 */
function refusalsIn(record) {
	const a = record.attachment;
	if (a?.type === "hook_blocking_error" && a.hookEvent === "Stop") {
		const blockText = String(a.blockingError?.blockingError ?? "");
		return [
			{
				kind: "stop",
				key: `stop ${a.toolUseID ?? record.uuid} ${blockText.slice(0, STOP_KEY_CHARS)}`,
				guard: scriptOf(guardKey(a.blockingError?.command ?? "")),
			},
		];
	}
	const content = record.message?.content;
	if (!Array.isArray(content)) return [];
	/** @type {Refusal[]} */
	const out = [];
	content.forEach((part, i) => {
		if (part?.type !== "tool_result" || !part.is_error) return;
		const text = resultText(part.content);
		if (DENY_HEAD.test(text))
			out.push({
				kind: "deny",
				key: `deny ${part.tool_use_id || `${record.uuid}#${i}`}`,
				text,
			});
	});
	return out;
}

/**
 * @typedef {{score: number, stop: Record<string, number>,
 *   deny: Record<string, number>, notice: Record<string, number>,
 *   unclassified: Record<string, number>,
 *   families: {inventory: number, jobDir: number, concision: number, environment: number}}} Tally
 */

/**
 * @param {Tally} t accumulator: the refusal is counted into it
 * @param {string} guard
 */
function countStop(t, guard) {
	const cls = STOP_CLASS[guard];
	if (cls === "breach") {
		t.score++;
		bump(t.stop, guard);
		if (guard === INVENTORY) t.families.inventory++;
	} else if (cls === "notice") bump(t.notice, guard);
	else if (cls === "concision") t.families.concision++;
	else bump(t.unclassified, guard || "(no command)");
}

/**
 * @param {Tally} t accumulator: the deny is counted into it
 * @param {string[]} guards
 */
function countDeny(t, guards) {
	if (guards.some((g) => ENVIRONMENT_DENY.has(g))) {
		t.families.environment++;
		return;
	}
	t.score++;
	bump(t.deny, guards.join(DENY_GUARD_JOIN) || UNATTRIBUTED);
	if (guards.includes(JOB_DIR)) t.families.jobDir++;
}

/**
 * @param {string} text
 * @param {(text: string) => string[]} attribute
 */
function scoreTranscript(text, attribute) {
	/** @type {Tally} */
	const t = {
		score: 0,
		stop: {},
		deny: {},
		notice: {},
		unclassified: {},
		families: { inventory: 0, jobDir: 0, concision: 0, environment: 0 },
	};
	const seen = new Set();
	const messages = new Set();
	const versions = new Set();

	for (const record of mainChainRecords(text, "main")) {
		if (typeof record.version === "string") versions.add(record.version);
		if (record.type === "assistant" && record.message?.id)
			messages.add(record.message.id);
		for (const r of refusalsIn(record)) {
			if (seen.has(r.key)) continue;
			seen.add(r.key);
			if (r.kind === "stop") countStop(t, r.guard);
			else countDeny(t, attribute(r.text));
		}
	}

	return {
		...t,
		assistantMessages: messages.size,
		versions: [...versions],
	};
}

/** @param {string[]} argv */
function main(argv) {
	const { flags } = parseOrExit(argv, CLI);
	const dir = flagValue(flags, "--dir");
	const file = flagValue(flags, "--file");
	if (!dir === !file) {
		writeFd(2, `${CLI.usage}\n`);
		return 1;
	}
	const listed = dir ? transcriptFiles(dir) : [];
	if (!listed) {
		writeFd(2, `✗ ${dir} cannot be read as a transcript directory.\n`);
		return 1;
	}
	const files = file
		? [file]
		: listed.filter((f) => f.tier === "main").map((f) => f.file);

	const attribute = buildDenyAttributor();
	const sessions = files.map((f) => ({
		session: path.basename(f, ".jsonl"),
		...scoreTranscript(fs.readFileSync(f, "utf8"), attribute),
	}));

	if (flags["--json"]) writeFd(1, `${JSON.stringify(sessions, null, 2)}\n`);
	else
		for (const s of sessions)
			writeFd(
				1,
				`${s.session}  score ${s.score}  inventory ${s.families.inventory}  jobDir ${s.families.jobDir}  concision ${s.families.concision}  environment ${s.families.environment}  messages ${s.assistantMessages}\n`,
			);

	const unclassed = [
		...new Set(sessions.flatMap((s) => Object.keys(s.unclassified))),
	];
	if (unclassed.length > 0) {
		writeFd(
			2,
			`✗ Stop guard(s) with no class: ${unclassed.join(", ")}. Class each in STOP_CLASS (scripts/lib/breach-score-rule.js), in a commit, before scoring.\n`,
		);
		return 2;
	}
	return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { main };
