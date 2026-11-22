#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { caught } = require("./lib/caught.js");
const { recordedLines } = require("./lib/commit-message.js");
const { runCheck } = require("./lib/check.js");
const { readCommit } = require("./lib/commit-sha.js");
const { escapeRe, requiredGroup } = require("./lib/regex-group.js");
const { readRuleTextOr } = require("./lib/rule-text");
const { COLLECTED_TEST } = require("./lib/test-kind.js");
const { gitReader, spawnGitSync, GIT_TIMEOUT_MS } = require("./lib/git.js");
const { CONFIG_PATH } = require("./lib/workflow-core-config.js");
const { MANIFEST_REL } = require("./lib/guard-cores.js");

/** @typedef {import("./lib/check").Ctx} Ctx */
/** @typedef {{ kind: string, name: string, what: string }} Weakening */
/** @typedef {{ before: string | null, after: string | null }} Sides */
/** @typedef {{ path: string, from: string | null, deleted: boolean }} Change */

const WEAKENS_LINE = /^\s*Weakens:\s*(\S.*|)$/i;
const WORKFLOW = /^\.github\/workflows\/[^/]+\.ya?ml$/;
const STAND_DOWN = /^WFC_[A-Z0-9_]+_OFF$/;
const GUARD_SCRIPT = /^scripts\/(guard-[\w-]+)\.js$/;

const GATE_COMMANDS = [
	/(?:^|[^\w-])((?:check|guard)-[\w.-]*\w)/g,
	/\b(npm\s+(?:run\s+)?(?:test|check)(?::[\w:-]*\w)?)(?![\w:-])/g,
	/\b(vitest|pytest)\b/g,
];

const SKIP_LINES = [
	/^\s*(?:describe|it|test|suite)(?:\.\w+)*\.(?:skip|skipIf)\b/,
	/^\s*x(?:describe|it|test)\(/,
	/^\s*@(?:pytest\.)?mark\.(?:skip|skipif|xfail)\b/,
	/^\s*pytestmark\s*=.*\bmark\.(?:skip|skipif|xfail)\b/,
	/^\s*pytest\.(?:skip|xfail)\(/,
	/^\s*@unittest\.(?:skip|skipIf|skipUnless|expectedFailure)\b/,
	/^\s*self\.skipTest\(/,
];

function readWeakensRule() {
	return readRuleTextOr(
		"weakens-line",
		"Name each weakened check on a `Weakens:` line",
		"check-weakens-line",
	).split("\n");
}

/**
 * @param {Ctx} ctx
 * @param {string[]} args
 */
function git(ctx, args) {
	const r = spawnGitSync(["-c", "core.quotePath=false", ...args], {
		encoding: "utf8",
		timeout: GIT_TIMEOUT_MS,
	});
	if (r.status !== 0)
		ctx.broken(
			`git ${args.join(" ")} would not answer — ${(r.stderr ?? r.error?.message ?? "").trim()}`,
		);
	return r.stdout;
}

/**
 * @param {Ctx} ctx
 * @returns {Change[]}
 */
function readStagedChanges(ctx) {
	const fields = git(ctx, [
		"diff",
		"--cached",
		"--name-status",
		"-M",
		"-z",
		"HEAD",
	]).split("\0");
	/** @type {Change[]} */
	const out = [];
	/** @param {number} i */
	const field = (i) => {
		const f = fields[i];
		if (f === undefined)
			ctx.broken("git diff --name-status -z ended mid-record");
		return f;
	};
	for (let i = 0; i < fields.length - 1; ) {
		const status = field(i);
		const first = field(i + 1);
		if (status.startsWith("R") || status.startsWith("C")) {
			const to = field(i + 2);
			out.push({
				path: to,
				from: status.startsWith("R") ? first : null,
				deleted: false,
			});
			i += 3;
			continue;
		}
		out.push({
			path: first,
			from: status === "A" ? null : first,
			deleted: status === "D",
		});
		i += 2;
	}
	return out;
}

/**
 * @param {Ctx} ctx
 * @param {Change} change
 * @returns {Sides}
 */
function readSides(ctx, change) {
	return {
		before:
			change.from === null ? null : git(ctx, ["show", `HEAD:${change.from}`]),
		after: change.deleted ? null : git(ctx, ["show", `:${change.path}`]),
	};
}

/**
 * @param {Ctx} ctx
 * @param {string | null} text
 * @param {string} side
 * @param {string} file
 * @returns {any}
 */
function parseSide(ctx, text, side, file) {
	if (text === null) return null;
	try {
		return JSON.parse(text);
	} catch (e) {
		ctx.broken(`${side} ${file} is not JSON — ${caught(e).message}`);
	}
}

/**
 * @param {Ctx} ctx
 * @param {string | null} text
 * @param {string} side
 * @returns {{ disabled: string[], modules: string[] }}
 */
function configLists(ctx, text, side) {
	const value = parseSide(ctx, text, side, CONFIG_PATH);
	const list = (/** @type {unknown} */ v) =>
		Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
	return { disabled: list(value?.disabled), modules: list(value?.modules) };
}

/**
 * @param {Ctx} ctx
 * @param {Sides} sides
 * @returns {Weakening[]}
 */
function modulesOff(ctx, { before, after }) {
	const was = configLists(ctx, before, "HEAD's");
	const now = configLists(ctx, after, "the staged");
	return [
		...now.disabled
			.filter((d) => !was.disabled.includes(d))
			.map((name) => ({
				kind: "MODULE-OFF",
				name,
				what: `${name} added to ${CONFIG_PATH}'s disabled`,
			})),
		...was.modules
			.filter((m) => !now.modules.includes(m))
			.map((name) => ({
				kind: "MODULE-OFF",
				name,
				what: `${name} dropped from ${CONFIG_PATH}'s modules`,
			})),
	];
}

/**
 * @param {Ctx} ctx
 * @param {string | null} text
 * @param {string} side
 * @returns {{ event: string, name: string, core: string }[]}
 */
function manifestRows(ctx, text, side) {
	const value = parseSide(ctx, text, side, MANIFEST_REL);
	return Object.entries(value ?? {}).flatMap(([event, rows]) =>
		(Array.isArray(rows) ? rows : [])
			.filter((r) => typeof r?.name === "string")
			.map((r) => ({ event, name: r.name, core: String(r.core ?? "") })),
	);
}

/**
 * @param {Ctx} ctx
 * @param {Sides} sides
 * @returns {Weakening[]}
 */
function coresDropped(ctx, { before, after }) {
	const was = manifestRows(ctx, before, "HEAD's");
	const now = manifestRows(ctx, after, "the staged");
	/** @param {{ event: string, name: string }} r */
	const key = (r) => `${r.event}\0${r.name}`;
	const wasKeys = new Set(was.map(key));
	const nowKeys = new Set(now.map(key));
	const renamed = new Set(
		now.filter((r) => !wasKeys.has(key(r))).map((r) => `${r.event}\0${r.core}`),
	);
	return was
		.filter(
			(r) => !nowKeys.has(key(r)) && !renamed.has(`${r.event}\0${r.core}`),
		)
		.map((r) => ({
			kind: "GUARD-GONE",
			name: r.name,
			what: `${r.name} dropped from ${MANIFEST_REL}'s ${r.event}`,
		}));
}

/**
 * @param {string | null} text
 * @returns {Map<string, number>}
 */
function gateCommands(text) {
	/** @type {Map<string, number>} */
	const counts = new Map();
	for (const raw of (text ?? "").split("\n")) {
		const line = raw.replace(/(?:^|\s)#.*$/, "");
		if (/^\s*(?:-\s+)?name:/.test(line)) continue;
		for (const pattern of GATE_COMMANDS)
			for (const m of line.matchAll(pattern)) {
				const name = requiredGroup(m, 1, pattern).replace(/\s+/g, " ");
				counts.set(name, (counts.get(name) ?? 0) + 1);
			}
	}
	return counts;
}

/**
 * @param {string} file
 * @param {Sides} sides
 * @returns {Weakening[]}
 */
function ciStepsDropped(file, { before, after }) {
	const now = gateCommands(after);
	return [...gateCommands(before)]
		.filter(([name, n]) => (now.get(name) ?? 0) < n)
		.map(([name]) => ({
			kind: "CI-STEP",
			name,
			what: `${name} runs less often in ${file}`,
		}));
}

/** @param {string | null} text */
const countSkipLines = (text) =>
	(text ?? "").split("\n").filter((l) => SKIP_LINES.some((p) => p.test(l)))
		.length;

/**
 * @param {string} file
 * @param {Sides} sides
 * @returns {Weakening[]}
 */
function skipsAdded(file, { before, after }) {
	if (before === null) return [];
	const added = countSkipLines(after) - countSkipLines(before);
	if (added <= 0) return [];
	const name = path.basename(file);
	return [
		{ kind: "TEST-SKIP", name, what: `${added} skip line(s) added to ${file}` },
	];
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @returns {Weakening[]}
 */
function standDowns(env) {
	return Object.keys(env)
		.filter((name) => STAND_DOWN.test(name) && (env[name] ?? "") !== "")
		.sort()
		.map((name) => ({
			kind: "STAND-DOWN",
			name,
			what: `${name} is set, standing a gate down for this commit`,
		}));
}

/** @param {string} message */
function parseWeakensLines(message) {
	return recordedLines(message).flatMap((l) => {
		const m = WEAKENS_LINE.exec(l);
		return m ? [requiredGroup(m, 1, WEAKENS_LINE)] : [];
	});
}

/**
 * @param {Ctx} ctx
 * @param {Change[]} changes
 * @returns {Weakening[]}
 */
function weakenings(ctx, changes) {
	const found = changes.flatMap((change) => {
		const script = change.deleted ? GUARD_SCRIPT.exec(change.path) : null;
		if (script)
			return [
				{
					kind: "GUARD-GONE",
					name: requiredGroup(script, 1, GUARD_SCRIPT),
					what: `${change.path} deleted`,
				},
			];
		if (change.path === MANIFEST_REL)
			return coresDropped(ctx, readSides(ctx, change));
		if (change.path === CONFIG_PATH)
			return modulesOff(ctx, readSides(ctx, change));
		if (
			WORKFLOW.test(change.path) ||
			(change.from && WORKFLOW.test(change.from))
		)
			return ciStepsDropped(change.path, readSides(ctx, change));
		if (COLLECTED_TEST.test(change.path))
			return skipsAdded(change.path, readSides(ctx, change));
		return [];
	});
	return found.filter(
		(w, i) => found.findIndex((o) => o.what === w.what) === i,
	);
}

/**
 * @param {string} line
 * @param {string} name
 */
function names(line, name) {
	const escaped = escapeRe(name);
	return new RegExp(`(?<![\\w.:-])${escaped}(?![\\w.:-])`).test(line);
}

/** @param {Ctx} ctx */
function run(ctx) {
	const [messageFile] = ctx.args;
	if (messageFile === undefined)
		ctx.broken(
			"no message file given.\nusage: node check-weakens-line.js <message-file>",
		);
	let message;
	try {
		message = fs.readFileSync(messageFile, "utf8");
	} catch (e) {
		ctx.broken(
			`cannot read the message file ${messageFile} — ${caught(e).message}`,
		);
	}
	const head = readCommit(gitReader(process.cwd()), "HEAD");
	if (!head.ok) ctx.broken(`git rev-parse HEAD would not answer — ${head.why}`);
	if (head.sha === null)
		return ctx.skip("no HEAD, so nothing existed to weaken.");

	const found = [
		...weakenings(ctx, readStagedChanges(ctx)),
		...standDowns(process.env),
	];
	const named = parseWeakensLines(message);
	const unnamed = found.filter((w) => !named.some((l) => names(l, w.name)));
	if (unnamed.length === 0) {
		return {
			okLine:
				found.length > 0
					? `${found.length} weakening(s), each named on a Weakens: line.`
					: "no weakened check staged.",
		};
	}
	ctx.say("This commit weakens a check its message does not name:");
	for (const w of unnamed) {
		ctx.fail(w.kind, w.what, { name: w.name, key: `${w.kind} ${w.name}` });
		ctx.say(`  ${w.what} — name it: Weakens: ${w.name} — <why>`);
	}
	ctx.say("");
	for (const line of readWeakensRule()) ctx.say(line);
	return { noun: "unnamed weakening(s)", count: unnamed.length };
}

const SPEC = {
	name: "weakens-line",
	usage: "node check-weakens-line.js <message-file> [--json] [--warn]",
	run,
};

module.exports = { SPEC };

if (require.main === module) runCheck(SPEC);
