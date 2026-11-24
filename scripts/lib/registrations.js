const { isToolCovered, MatcherError } = require("./core-hooks.js");
const { siblingTests, spellSiblingTests } = require("./test-kind.js");

const HOST_REGISTRATIONS = ".claude/registrations.json";

const HOST_NEEDLES = ".claude/guard-fire-needles.json";

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

/** @returns {string} */
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

/** @returns {string} */
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
 * @param {any} json
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
 * @param {any} settings
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
 * @param {Pick<Registration, "command" | "args">} r
 */
function buildCommandLine(r) {
	return [r.command, ...(Array.isArray(r.args) ? r.args : [])].join(" ");
}

/** @param {Registration} r */
const labelOf = (r) =>
	`${r.event}: ${buildCommandLine(r)}${r.if ? ` if: ${r.if}` : ""}`;

/**
 * @param {Row} row
 * @param {Registration} r
 */
const isPinnedBy = (row, r) =>
	row.event === r.event &&
	buildCommandLine(r).includes(row.id) &&
	(row.narrowing ?? null) === (r.if ?? null);

/**
 * @param {string} s
 * @param {RegExp} re
 */
function upTo(s, re) {
	const at = s.search(re);
	return at === -1 ? s : s.slice(0, at);
}

/**
 * @param {Registration} r
 * @returns {Row}
 */
function suggestedRow(r) {
	const line = buildCommandLine(r);
	const at = line.search(/scripts\/[\w.-]+/);
	const candidate =
		at === -1
			? line
			: upTo(
					line.slice(at).replace(/"/g, ""),
					/(?<!\s)\s+(?:\|\||&&|;|2>\/dev\/null)/,
				).trim();
	const id = line.includes(candidate) ? candidate : upTo(candidate, /\s/);
	const matcher = r.matcher ?? null;
	return {
		event: r.event,
		id,
		...(r.if ? { narrowing: r.if } : {}),
		matcher,
		covers:
			matcher && /ToolUse/.test(r.event) && /^[\w|]+$/.test(matcher)
				? matcher.split("|")
				: [],
		...(typeof r.timeout === "number" ? {} : { unbounded: true }),
	};
}

/**
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
	try {
		for (const tool of row.covers ?? [])
			if (!isToolCovered(r.matcher ?? undefined, tool))
				out.push(
					`says it covers ${tool}, and the registered matcher no longer fires on it`,
				);
	} catch (err) {
		if (!(err instanceof MatcherError)) throw err;
		out.push(`says what it covers, and ${err.message}`);
	}
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
 * @param {string} file
 * @param {(rel: string) => boolean} exists
 */
const spellSiblingTestsIfUntested = (file, exists) => {
	const stem = `scripts/${file.replace(/\.[^.]*$/, "")}`;
	return siblingTests(stem).some(exists) ? null : spellSiblingTests(stem);
};

/**
 * @param {string} file
 * @param {(rel: string) => boolean} exists
 * @returns {Fault[]}
 */
const untestedFaults = (file, exists) => {
	const names = spellSiblingTestsIfUntested(file, exists);
	return names === null
		? []
		: [
				{
					key: `untested scripts/${file}`,
					message: `scripts/${file} has no sibling test (${names})`,
				},
			];
};

/**
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
		out.push(...untestedFaults(file, exists));
	}
	return out;
}

/** @param {string} text */
function stripCommentLines(text) {
	return text
		.split("\n")
		.filter((line) => !/^\s*(#|\/\/|\*|\/\*)/.test(line))
		.join("\n");
}

/**
 * @param {{checkers: string[], callers: Record<string, string>, elsewhere: Record<string, string>, exists: (rel: string) => boolean}} at
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
		out.push(...untestedFaults(file, exists));
	}
	for (const file of Object.keys(elsewhere))
		if (!checkers.includes(file))
			out.push({
				key: `gone ${file}`,
				message: `\`calledElsewhere\` names ${file}, which is no scripts/check-*.js here — remove the entry`,
			});
	return out;
}

/** @param {Record<string, string>} elsewhere */
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
	spellSiblingTestsIfUntested,
	unexplained,
};
