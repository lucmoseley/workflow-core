#!/usr/bin/env node
/*
 * check-weakens-line.js — refuses a commit that weakens a check unless its
 * message names each weakening on a `Weakens:` line (workflow-core#2235, ruled at workflow-core#2203).
 *
 * Usage:
 *   node check-weakens-line.js <message-file> [--json] [--warn]
 *
 * The rule lives in docs/agents/rules/weakens-line.txt and reaches a session
 * only here. .husky/commit-msg runs it: the one hook that sees both the
 * finished message and the commit's index.
 *
 * A WEAKENING is one of three staged changes against HEAD:
 *   - MODULE-OFF   an entry added to `.claude/workflow-core.json`'s
 *                  `disabled`, or dropped from its `modules`. A config new at
 *                  this commit counts every `disabled` entry it carries.
 *   - CI-STEP      a gate command a workflow under `.github/workflows/` runs
 *                  fewer times than it did at HEAD: a `check-*` or `guard-*`
 *                  script, an `npm run check:*` or `npm run test*` script, or
 *                  vitest or pytest. Counted over the file's lines with YAML
 *                  comments and `name:` keys dropped, so a moved step or a
 *                  renamed one is none, and a commented-out one is.
 *   - TEST-SKIP    more skip lines in a test file than HEAD held, the file
 *                  existing at HEAD under this name or the one a rename left.
 *                  A test file new at this commit is never one.
 * And one the environment carries, not the diff:
 *   - STAND-DOWN   a `WFC_<NAME>_OFF` variable set non-empty in the commit's
 *                  environment, the shape a gate's one-commit stand-down takes
 *                  (workflow-core#2394).
 *
 * NAMED means some `Weakens:` line holds the weakening's name as a whole
 * token, as the refusal prints it: the module or guard, the command, the test
 * file's basename, the variable.
 *
 * NOT SEEN: a step stood down by `if: false` or `continue-on-error`, or
 * narrowed by its arguments, as `npm run test -- --full` becoming
 * `npm run test` (counting whole command lines would refuse every argument
 * edit); a skip removed and another added in one file, which nets to none; a
 * weakening made while resolving a merge conflict, the hook standing a merge
 * down; a gate command reached through a variable or a script that is not a
 * gate's; a skip spelled on the line after its call, or as `ctx.skip()`; and
 * an amend, whose diff against HEAD leaves out what the amended commit
 * weakened.
 *
 * IMPLICIT:  on every commit, refuses one whose staged diff turns a module off, drops a CI gate command, adds a skip to an existing test file or runs under a WFC_*_OFF stand-down, until its message names each on a `Weakens:` line; the refusal prints rule:weakens-line.
 * JUSTIFIED: fail-safe — a check weakened inside a large commit goes unseen until it bites (workflow-core#2203); the fix is one message line.
 * DEFEAT:    --warn caps the finding below the gating line, and the hook never passes it. `--no-verify` skips commit-msg, and HUSKY=0 or core.hooksPath off .husky/_ skip every hook (scripts/guard-commit-form.sh's LIMITS). A replay or a merge stands it down in the hook.
 */

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { caught } = require("./lib/caught.js");
const { runCheck } = require("./lib/check.js");
const { CHILD_MAX_BUFFER } = require("./lib/child-buffer.js");
const { isCommit } = require("./lib/commit-sha.js");
const { GIT_TIMEOUT_MS } = require("./lib/dirty-tree.js");
const { requiredGroup } = require("./lib/regex-group.js");
const { ruleTextOr } = require("./lib/rule-text");
const { COLLECTED_TEST } = require("./lib/test-kind.js");

/** @typedef {import("./lib/check").CheckContext} Ctx */
/** @typedef {{ kind: string, name: string, what: string }} Weakening */
/** @typedef {{ before: string | null, after: string | null }} Sides */
/** @typedef {{ path: string, from: string | null, deleted: boolean }} Change */

const CONFIG = ".claude/workflow-core.json";
const WEAKENS_LINE = /^\s*Weakens:\s*(.*)$/i;
const WORKFLOW = /^\.github\/workflows\/[^/]+\.ya?ml$/;
const STAND_DOWN = /^WFC_[A-Z0-9_]+_OFF$/;

/* Each alternative's first group is the command's name. */
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

/* An unreadable fragment is check-guard-registry.js's assertion, not a reason
 * to call this verdict BROKEN (mantahostels#1649's split, as in
 * check-lockfile-sync.js). */
function weakensRule() {
	return ruleTextOr(
		"weakens-line",
		"Name each weakened check on a `Weakens:` line.",
		"check-weakens-line",
	).split("\n");
}

/**
 * @param {Ctx} ctx
 * @param {string[]} args
 */
function git(ctx, args) {
	const r = spawnSync("git", ["-c", "core.quotePath=false", ...args], {
		encoding: "utf8",
		timeout: GIT_TIMEOUT_MS,
		maxBuffer: CHILD_MAX_BUFFER,
	});
	if (r.status !== 0)
		ctx.broken(
			`git ${args.join(" ")} would not answer — ${(r.stderr ?? r.error?.message ?? "").trim()}`,
		);
	return r.stdout;
}

/**
 * The staged paths against HEAD, each with the path HEAD holds it at: null for
 * one this commit adds, the source for a rename.
 * @param {Ctx} ctx
 * @returns {Change[]}
 */
function stagedChanges(ctx) {
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
 * HEAD's and the index's text for one change; null where that side has none.
 * @param {Ctx} ctx
 * @param {Change} change
 * @returns {Sides}
 */
function sidesOf(ctx, change) {
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
 * @returns {{ disabled: string[], modules: string[] }}
 */
function configLists(ctx, text, side) {
	if (text === null) return { disabled: [], modules: [] };
	let value;
	try {
		value = JSON.parse(text);
	} catch (e) {
		ctx.broken(`${side} ${CONFIG} is not JSON — ${caught(e).message}`);
	}
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
				what: `${name} added to ${CONFIG}'s disabled`,
			})),
		...was.modules
			.filter((m) => !now.modules.includes(m))
			.map((name) => ({
				kind: "MODULE-OFF",
				name,
				what: `${name} dropped from ${CONFIG}'s modules`,
			})),
	];
}

/**
 * How many times each gate command appears on a workflow's command lines.
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
const skipLines = (text) =>
	(text ?? "").split("\n").filter((l) => SKIP_LINES.some((p) => p.test(l)))
		.length;

/**
 * @param {string} file
 * @param {Sides} sides
 * @returns {Weakening[]}
 */
function skipsAdded(file, { before, after }) {
	if (before === null) return [];
	const added = skipLines(after) - skipLines(before);
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

/**
 * The text of each `Weakens:` line, past git's `#` template lines and the
 * `--verbose` diff below the scissors line, as check-commit-message-closes.sh
 * strips them.
 * @param {string} message
 */
function weakensLines(message) {
	const end = message.search(/^# -+ >8 -+/m);
	return (end === -1 ? message : message.slice(0, end))
		.split("\n")
		.filter((l) => !l.startsWith("#"))
		.flatMap((l) => {
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
	return changes.flatMap((change) => {
		if (change.path === CONFIG) return modulesOff(ctx, sidesOf(ctx, change));
		if (
			WORKFLOW.test(change.path) ||
			(change.from && WORKFLOW.test(change.from))
		)
			return ciStepsDropped(change.path, sidesOf(ctx, change));
		if (COLLECTED_TEST.test(change.path))
			return skipsAdded(change.path, sidesOf(ctx, change));
		return [];
	});
}

/**
 * Whether a `Weakens:` line names `name` as a whole token, so `data.test.ts`
 * never names `a.test.ts`, nor `npm run test:py` `npm run test`.
 * @param {string} line
 * @param {string} name
 */
function names(line, name) {
	const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
	if (!isCommit(process.cwd(), "HEAD"))
		return ctx.skip("no HEAD, so nothing existed to weaken.");

	const found = [
		...weakenings(ctx, stagedChanges(ctx)),
		...standDowns(process.env),
	];
	const named = weakensLines(message);
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
	for (const line of weakensRule()) ctx.say(line);
	return { noun: "unnamed weakening(s)", count: unnamed.length };
}

if (require.main === module) {
	runCheck({
		name: "weakens-line",
		usage: "node check-weakens-line.js <message-file> [--json] [--warn]",
		run,
	});
}
