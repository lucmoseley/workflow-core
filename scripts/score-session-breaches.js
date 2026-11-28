#!/usr/bin/env node
const fs = require("node:fs");
const { scriptPath } = require("./lib/script-path.js");
const path = require("node:path");
const {
	guardKey,
	needleIn,
	readRegisteredGuardSubjects,
	readTranscriptFiles,
} = require("./lib/guard-fires");
const { mainChainRecords } = require("./lib/transcript");
const { hostRoot } = require("./lib/host-root.js");
const { flagValue, parseOrExit } = require("./lib/cli-args");
const { writeFd } = require("./lib/write-fd.js");

/** @type {import("./lib/cli-args").CliSpec} */
const CLI = {
	usage: `Usage: node ${scriptPath("score-session-breaches.js")} (--dir <projects dir> | --file <transcript>) [--json]`,
	flags: { "--dir": "value", "--file": "value", "--json": "boolean" },
};

const {
	STOP_CLASS,
	ENVIRONMENT_DENY,
	INVENTORY,
	JOB_DIR,
	DENY_GUARD_JOIN,
	UNATTRIBUTED,
	guardNameOf,
} = require("./lib/breach-score-rule.js");

const DENY_HEAD = /^PreToolUse:\S+ hook error: /;
// guess, #2042
const STOP_KEY_CHARS = 200;

/**
 * @param {string} root
 * @returns {{name: string, needles: import("./lib/guard-fires").Needle[]}[]}
 */
function readDenyingGuards(root) {
	/** @type {Map<string, import("./lib/guard-fires").Needle[]>} */
	const byName = new Map();
	for (const s of readRegisteredGuardSubjects(root))
		for (const n of s.needles) {
			if (n.kind !== "deny") continue;
			const name = n.core ?? guardNameOf(s.id.slice("guard:".length));
			byName.set(name, [...(byName.get(name) ?? []), n]);
		}
	return [...byName].map(([name, needles]) => ({ name, needles }));
}

/** @returns {(text: string) => string[]} */
function buildDenyAttributor() {
	const guards = readDenyingGuards(hostRoot());
	return (text) =>
		guards
			.filter((g) => g.needles.some((n) => needleIn(text, n)))
			.map((g) => g.name);
}

/** @param {Record<string, number>} counts @param {string} key */
const bump = (counts, key) => {
	counts[key] = (counts[key] || 0) + 1;
};

/** @param {unknown} c @returns {string} */
function parseResultText(c) {
	if (typeof c === "string") return c;
	if (!Array.isArray(c)) return "";
	return c.map((q) => (typeof q?.text === "string" ? q.text : "")).join("");
}

/**
 * @typedef {{kind: "stop", key: string, guard: string}
 *   | {kind: "deny", key: string, text: string}} Refusal
 */

/**
 * @param {import("./lib/transcript.js").TranscriptRecord} record
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
				guard: guardNameOf(guardKey(a.blockingError?.command ?? "")),
			},
		];
	}
	const content = record.message?.content;
	if (!Array.isArray(content)) return [];
	/** @type {Refusal[]} */
	const out = [];
	content.forEach((part, i) => {
		if (part?.type !== "tool_result" || !part.is_error) return;
		const text = parseResultText(part.content);
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

/** @param {Tally} t @param {string} guard */
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

/** @param {Tally} t @param {string[]} guards */
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
	const listed = dir ? readTranscriptFiles(dir) : [];
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
