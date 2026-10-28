/*
 * registrations.js — a host repo's own registry of its hooks, guards and
 * checkers, and the whole-repo predicates check-registrations.js judges over
 * it (#1456).
 *
 * The core holds these invariants as vitest tests over its own tables:
 * `scripts/hook-registrations.test.ts`, `scripts/checker-registrations.test.ts`
 * and, for the needles, `scripts/count-guard-fires.test.ts`. A repo with no
 * test runner cannot carry those, so it carries the data as JSON and a node
 * checker asserts the same predicates.
 *
 * the guard-registry-atomicity core judges a commit against the same host files,
 * through lib/registry-atomicity.js.
 */

const { siblingTests, spellSiblingTests } = require("./test-kind.js");

/** The host registry, every adopter seeded with `emptyRegistry()`. */
const HOST_REGISTRATIONS = ".claude/registrations.json";

/** The host's own fire-count needles, merged by count-guard-fires.js (#1267). */
const HOST_NEEDLES = ".claude/guard-fire-needles.json";

/** The husky hooks that run a checker unasked, as checker-registrations.test.ts lists them. */
const CALLER_HOOKS = [
	"pre-commit",
	"prepare-commit-msg",
	"pre-merge-commit",
	"post-commit",
	"pre-push",
];

/** @typedef {{event: string, id: string, narrowing?: string, matcher: string | null, covers?: string[], unbounded?: true, note?: string}} Row */
/** @typedef {{hooks: Row[], registeredElsewhere: Record<string, string>, calledElsewhere: Record<string, string>}} Registry */
/** @typedef {{event: string, matcher?: string, command: string, args?: string[], if?: string, timeout?: number}} Registration */
/** @typedef {{key: string, message: string}} Fault */

/** @returns {string} the seeded file's bytes */
function emptyRegistry() {
	return `${JSON.stringify(
		{
			_comment: [
				"This repo's own hooks, guards and checkers, held to the core's registry rule (workflow-core#1456).",
				"`hooks` pins every .claude/settings.json registration: event, id (a substring of its command line,",
				"arguments included), narrowing (its `if`), matcher (null on an event taking none), covers (tools it",
				"must fire on) and unbounded (true where it declares no timeout). `registeredElsewhere` keys a",
				"scripts/guard-* no hook runs, and `calledElsewhere` a scripts/check-*.js nothing calls unasked, each",
				"to its reason. List what is unregistered: node <plugin root>/scripts/check-registrations.js",
			],
			hooks: [],
			registeredElsewhere: {},
			calledElsewhere: {},
		},
		null,
		"\t",
	)}\n`;
}

/** @returns {string} the seeded needles file's bytes */
function emptyNeedles() {
	return `${JSON.stringify(
		{
			_comment: [
				"The text each hook this repo registers in .claude/settings.json prints, so the core's",
				"count-guard-fires.js can count it (workflow-core#1267). Shape and rules: the core's",
				"scripts/guard-fire-needles.json `_comment`.",
			],
			guards: {},
		},
		null,
		"\t",
	)}\n`;
}

/**
 * The registry's shape faults, each a sentence; empty where it is well formed.
 * @param {any} json  the parsed file, of any shape: this is what narrows it
 * @returns {string[]}
 */
function shapeFaults(json) {
	if (json === null || typeof json !== "object" || Array.isArray(json))
		return ["is not a JSON object"];
	const faults = [];
	if (!Array.isArray(json.hooks)) faults.push("`hooks` is not an array");
	for (const key of ["registeredElsewhere", "calledElsewhere"]) {
		const v = json[key];
		if (v === null || typeof v !== "object" || Array.isArray(v))
			faults.push(`\`${key}\` is not an object`);
	}
	for (const [i, row] of (Array.isArray(json.hooks)
		? json.hooks
		: []
	).entries())
		if (
			typeof row?.event !== "string" ||
			typeof row?.id !== "string" ||
			!(row.matcher === null || typeof row.matcher === "string")
		)
			faults.push(
				`\`hooks[${i}]\` needs a string \`event\`, a string \`id\` and a \`matcher\` that is a string or null`,
			);
	return faults;
}

/**
 * Every hook registration in a settings-shaped object, flattened out of the
 * entry carrying its matcher — `lib/hook-wiring.ts`'s `allRegistrations`,
 * which its TypeScript keeps from being shared.
 * @param {any} settings  `{hooks}` as lib/core-hooks.js's `readOwnHooks` reads it,
 *   read defensively at each level
 * @returns {Registration[]}
 */
function allRegistrations(settings) {
	/** @type {Registration[]} */
	const out = [];
	for (const [event, entries] of Object.entries(settings?.hooks ?? {}))
		for (const entry of Array.isArray(entries) ? entries : [])
			for (const h of entry?.hooks ?? [])
				out.push({ event, matcher: entry?.matcher, ...h });
	return out;
}

/**
 * One registration as a single command line.
 * @param {Pick<Registration, "command" | "args">} r
 */
function buildCommandLine(r) {
	return [r.command, ...(Array.isArray(r.args) ? r.args : [])].join(" ");
}

/** @param {Registration} r */
const labelOf = (r) =>
	`${r.event}: ${buildCommandLine(r)}${r.if ? ` if: ${r.if}` : ""}`;

/**
 * Does `row` pin `r`? The core's own match: same event, the id a substring of
 * the command line, the same narrowing.
 * @param {Row} row
 * @param {Registration} r
 */
const isPinnedBy = (row, r) =>
	row.event === r.event &&
	buildCommandLine(r).includes(row.id) &&
	(row.narrowing ?? null) === (r.if ?? null);

/**
 * A row a reader can paste for an unpinned registration. Its id is the
 * script path and arguments where the command names one under scripts/.
 * @param {Registration} r
 * @returns {Row}
 */
function suggestedRow(r) {
	const line = buildCommandLine(r);
	const at = line.search(/scripts\/[\w.-]+/);
	const candidate =
		at === -1
			? line
			: line
					.slice(at)
					.replace(/"/g, "")
					.replace(/\s+(?:\|\||&&|;|2>\/dev\/null)[\s\S]*$/, "")
					.trim();
	/* A quote closing after the path splits it from its arguments, and the id
	 * must stay a substring of the command line. */
	const id = line.includes(candidate)
		? candidate
		: candidate.replace(/\s[\s\S]*$/, "");
	const matcher = r.matcher ?? null;
	return {
		event: r.event,
		id,
		...(r.if ? { narrowing: r.if } : {}),
		matcher,
		/* A tool event's matcher names tools; SessionStart's names a source. */
		covers:
			matcher && /ToolUse/.test(r.event) && /^[\w|]+$/.test(matcher)
				? matcher.split("|")
				: [],
		...(typeof r.timeout === "number" ? {} : { unbounded: true }),
	};
}

/**
 * How the one registration a row pins has drifted from it, a clause each.
 * @param {Row} row
 * @param {Registration} r
 * @returns {string[]}
 */
function rowDrift(row, r) {
	const matcher = r.matcher ?? null;
	const out = [];
	if (matcher !== row.matcher)
		out.push(
			`pins matcher ${JSON.stringify(row.matcher)}, but the hook is registered with ${JSON.stringify(matcher)}`,
		);
	for (const tool of row.covers ?? [])
		if (!new RegExp(`^(${matcher ?? ""})$`).test(tool))
			out.push(
				`says it covers ${tool}, and the registered matcher no longer fires on it`,
			);
	const bounded = typeof r.timeout === "number";
	if (row.unbounded && bounded)
		out.push("says unbounded, but the hook has gained a timeout");
	if (!row.unbounded && !bounded)
		out.push(
			"expects a timeout, and the hook has none, so it runs unbounded — add one, or mark the row unbounded",
		);
	return out;
}

/**
 * The hooks half: every registration pinned by exactly one row, and every
 * row matching what is registered.
 * @param {Row[]} rows
 * @param {Registration[]} regs
 * @returns {{unpinned: Fault[], drifted: Fault[]}}
 */
function hookFaults(rows, regs) {
	const unpinned = regs
		.filter((r) => !rows.some((row) => isPinnedBy(row, r)))
		.map((r) => ({
			key: labelOf(r),
			message: `${labelOf(r)} has no \`hooks\` row — add ${JSON.stringify(suggestedRow(r))}`,
		}));
	const drifted = rows.flatMap((row) => {
		const label = `${row.event} ${row.id}${row.narrowing ? ` if: ${row.narrowing}` : ""}`;
		const found = regs.filter((r) => isPinnedBy(row, r));
		let clauses = [
			`matches ${found.length} registrations — lengthen its id or give it a narrowing so it names one`,
		];
		if (found.length === 0)
			clauses = [
				"matches no registration in .claude/settings.json — remove the row, or restore the hook",
			];
		const [only] = found;
		if (found.length === 1 && only) clauses = rowDrift(row, only);
		return clauses.map((what) => ({
			key: label,
			message: `the \`hooks\` row for ${label} ${what}`,
		}));
	});
	return { unpinned, drifted };
}

/**
 * Does `scripts/<stem>` have a test of any form a host runner collects? The
 * core's own tests take `.test.ts` alone.
 * @param {string} stem
 * @param {(rel: string) => boolean} exists
 */
const hasSibling = (stem, exists) =>
	siblingTests(`scripts/${stem}`).some(exists);

/**
 * The guards half: every scripts/guard-* run by a hook or allowlisted, and
 * every one with a sibling test.
 * @param {{guards: string[], regs: Registration[], elsewhere: Record<string, string>, exists: (rel: string) => boolean}} at
 * @returns {Fault[]}
 */
function guardFaults({ guards, regs, elsewhere, exists }) {
	/** @type {Fault[]} */
	const out = [];
	for (const file of guards) {
		const rel = `scripts/${file}`;
		if (
			!regs.some((r) => buildCommandLine(r).includes(rel)) &&
			!Object.hasOwn(elsewhere, file)
		)
			out.push({
				key: `unwired ${rel}`,
				message: `${rel} is run by no hook in .claude/settings.json — register it, or give it a \`registeredElsewhere\` entry naming the script that runs it`,
			});
		const stem = file.replace(/\.(sh|js)$/, "");
		if (!hasSibling(stem, exists))
			out.push({
				key: `untested ${rel}`,
				message: `${rel} has no sibling test (${spellSiblingTests(`scripts/${stem}`)})`,
			});
	}
	return out;
}

/**
 * Whole-line comments dropped, as checker-registrations.test.ts drops them, so
 * a hook that only mentions a checker in prose is no caller.
 * @param {string} text
 */
function stripCommentLines(text) {
	return text
		.split("\n")
		.filter((line) => !/^\s*(#|\/\/|\*|\/\*)/.test(line))
		.join("\n");
}

/**
 * The checkers half: every scripts/check-*.js called by one of the four
 * surfaces or allowlisted, every allowlist key still a checker, and every
 * checker with a sibling test.
 * @param {{checkers: string[], callers: Record<string, string>, elsewhere: Record<string, string>, exists: (rel: string) => boolean}} at
 *   `callers` maps each caller surface's repo-relative path to its text
 * @returns {Fault[]}
 */
function checkerFaults({ checkers, callers, elsewhere, exists }) {
	/** @type {Fault[]} */
	const out = [];
	const stripped = Object.entries(callers).map(
		([label, text]) => /** @type {const} */ ([label, stripCommentLines(text)]),
	);
	for (const file of checkers) {
		const rel = `scripts/${file}`;
		const called = stripped.some(
			([label, text]) => label !== rel && text.includes(file),
		);
		if (!called && !Object.hasOwn(elsewhere, file))
			out.push({
				key: `uncalled ${rel}`,
				message: `${rel} is run by no husky hook, workflow, .claude/settings.json hook or other script — wire it, or give it a \`calledElsewhere\` entry with its reason`,
			});
		const stem = file.replace(/\.js$/, "");
		if (!hasSibling(stem, exists))
			out.push({
				key: `untested ${rel}`,
				message: `${rel} has no sibling test (${spellSiblingTests(`scripts/${stem}`)})`,
			});
	}
	for (const file of Object.keys(elsewhere))
		if (!checkers.includes(file))
			out.push({
				key: `gone ${file}`,
				message: `\`calledElsewhere\` names ${file}, which is no scripts/check-*.js here — remove the entry`,
			});
	return out;
}

/**
 * Allowlist entries whose reason is blank.
 * @param {Record<string, string>} elsewhere
 */
const unexplained = (elsewhere) =>
	Object.entries(elsewhere)
		.filter(([, why]) => typeof why !== "string" || why.trim() === "")
		.map(([file]) => file);

module.exports = {
	HOST_REGISTRATIONS,
	HOST_NEEDLES,
	CALLER_HOOKS,
	emptyRegistry,
	emptyNeedles,
	shapeFaults,
	allRegistrations,
	buildCommandLine,
	isPinnedBy,
	hookFaults,
	guardFaults,
	checkerFaults,
	unexplained,
};
