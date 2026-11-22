const fs = require("node:fs");
const { ignoreFailure } = require("./caught.js");
const { readText } = require("./file-read.js");
const { stampFile } = require("./delivery-stamp.js");
const {
	readSessionStartRoster,
	KEY_OVERRIDES,
} = require("./session-start-roster.js");

/**
 * @typedef {{ key: string, script: string, outcomes?: string[],
 *   volatile?: boolean, knownGap?: number, stampKeys?: string[] }} Producer
 * @typedef {{ stdout: string, stderr: string, code: number|null,
 *   killed: boolean, ms: number }} RunOutcome
 */

const CHECKER_OUTCOMES = ["OK", "SKIP", "WARN", "FAIL", "BROKEN"];

/** @type {Record<string, Omit<Producer, "key" | "script">>} */
const PRODUCER_META = {
	"ci-status": {
		volatile: true,
	},
	"idle-efforts": {
		volatile: true,
	},
	"reap-finished-sessions": {
		outcomes: ["OK", "WARN", "BROKEN"],
		volatile: true,
	},
};

/**
 * @param {string} repoRoot
 * @returns {Producer[]}
 */
function readPersistingProducers(repoRoot) {
	const producers = readSessionStartRoster(repoRoot, {
		keyOverrides: KEY_OVERRIDES,
	}).map(({ key, script }) => ({ key, script, ...(PRODUCER_META[key] ?? {}) }));
	const wired = new Set(producers.map((p) => p.key));
	const orphaned = Object.keys(PRODUCER_META).filter((k) => !wired.has(k));
	if (orphaned.length > 0)
		throw new Error(
			`PRODUCER_META names ${orphaned.join(", ")}, which the repo's hooks wire as no persisting producer — a stale or misspelt key`,
		);
	return producers;
}

/** @param {string} text */
function mask(text) {
	return String(text)
		.replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z?/g, "<ts>")
		.replace(/\d{4}-\d{2}-\d{2}/g, "<date>")
		.replace(
			/\b\d+(\.\d+)?\s*(ms|s|m|h|d|min|minute|minutes|hour|hours|day|days)\b/gi,
			"<dur>",
		)
		.replace(/\bpid\s*\d+/gi, "pid <n>")
		.replace(/\b(in \d+ of )\d+ session\(s\)/g, "$1<n> session(s)")
		.replace(/\b(?=[0-9a-f]{7,40}\b)[0-9]*[a-f][0-9a-f]*\b/g, "<sha>")
		.replace(/(?<![ \t])[ \t]+$/gm, "")
		.replace(/\n{2,}/g, "\n")
		.trim();
}

/**
 * @param {Pick<Producer, "key"|"outcomes">} producer
 * @param {import("./notify-report.js").Report|null} report
 * @param {{ from: number, to: number }} window
 */
function faultsIn(producer, report, window) {
	if (!report) return ["no report file, or one too malformed to read back"];
	const bad = [];
	const allowed = producer.outcomes ?? CHECKER_OUTCOMES;
	if (report.checker !== producer.key)
		bad.push(
			`report names checker "${report.checker}", expected "${producer.key}"`,
		);
	if (!allowed.includes(report.outcome))
		bad.push(
			`outcome "${report.outcome}" is outside its alphabet (${allowed.join("/")})`,
		);
	if (typeof report.text !== "string") bad.push("text is not a string");
	const at = Date.parse(report.at);
	if (Number.isNaN(at)) {
		bad.push(`unparseable timestamp "${report.at}"`);
	} else if (at < window.from - 1000 || at > window.to + 1000) {
		// guess, lucmoseley/mantahostels#1949
		bad.push(
			`report is from ${report.at}, outside this run — the producer wrote nothing`,
		);
	}
	if (report.durationMs !== null && typeof report.durationMs !== "number")
		bad.push("durationMs is neither a number nor null");
	return bad;
}

/**
 * @param {Omit<Producer, "script">} producer
 * @param {{
 *   persistRun: RunOutcome,
 *   controlRun: RunOutcome|null,
 *   report: import("./notify-report.js").Report|null,
 *   runOpen: boolean,
 *   window: { from: number, to: number },
 *   stampSeen: boolean,
 * }} phases
 */
function judge(
	producer,
	{ persistRun, controlRun, report, runOpen, window, stampSeen },
) {
	const faults = faultsIn(producer, report, window);
	if (persistRun.killed)
		faults.push(`killed at the harness timeout after ${persistRun.ms} ms`);
	if (persistRun.stdout.trim())
		faults.push(
			`printed ${persistRun.stdout.trim().length} bytes to stdout under persist mode`,
		);
	if (runOpen)
		faults.push(
			"left its open run record behind — the reader will call it cancelled",
		);

	const { match, diff } = compareRuns(
		producer,
		{ controlRun, report, stampSeen },
		faults,
	);
	return {
		key: producer.key,
		outcome: report?.outcome ?? null,
		bytes: report?.text.length ?? 0,
		persistMs: persistRun.ms,
		controlMs: controlRun?.ms ?? null,
		exit: persistRun.code,
		match,
		diff,
		faults,
	};
}

/**
 * @param {Omit<Producer, "script">} producer
 * @param {{
 *   controlRun: RunOutcome|null,
 *   report: import("./notify-report.js").Report|null,
 *   stampSeen: boolean,
 * }} runs
 * @param {string[]} faults
 * @returns {{match: string, diff: {persisted: string, control: string}|null}}
 */
function compareRuns(producer, { controlRun, report, stampSeen }, faults) {
	if (controlRun?.killed) {
		faults.push(
			`its control run was killed after ${controlRun.ms} ms — nothing to compare against`,
		);
		return { match: "control run killed", diff: null };
	}
	if (!controlRun || !report) return { match: "not compared", diff: null };
	const a = mask(report.text);
	const b = mask(controlRun.stdout);
	if (report.text.trim() === controlRun.stdout.trim())
		return { match: "identical", diff: null };
	if (a === b) return { match: "same finding", diff: null };
	if (a && !b && stampSeen) return { match: "stamp-held live", diff: null };
	const diff = { persisted: a, control: b };
	if (producer.knownGap)
		return { match: `differs (known: #${producer.knownGap})`, diff };
	if (!producer.volatile)
		faults.push(
			"persisted report does not match the same checker's live report",
		);
	return { match: "differs", diff };
}

/**
 * @param {Producer[]} producers
 * @param {Record<string, import("./notify-report.js").Report|null>} [reports]
 */
function parkStamps(producers, reports = {}) {
	/** @type {[string, string|null][]} */
	const held = [];
	for (const p of producers) {
		const fromReport = Object.keys(reports[p.key]?.stamps ?? {});
		for (const key of new Set([p.key, ...(p.stampKeys ?? []), ...fromReport])) {
			const file = stampFile(key);
			const read = readText(file);
			if (read.state === "unreadable") continue;
			const text = read.state === "read" ? read.data : null;
			ignoreFailure(() => {
				fs.rmSync(file, { force: true });
				held.push([file, text]);
			});
		}
	}
	return () => {
		for (const [file, text] of held) {
			ignoreFailure(() => {
				if (text === null) fs.rmSync(file, { force: true });
				else fs.writeFileSync(file, text);
			});
		}
	};
}

module.exports = { readPersistingProducers, judge, parkStamps };
