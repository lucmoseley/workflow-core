#!/usr/bin/env node
/*
 * measure-encoding-use.js — what did this repo encode that never fires, and
 * what is still being done by hand, read off the transcripts already on disk.
 *
 *   node scripts/measure-encoding-use.js [--dir <path>] [--json]
 *                                        [--min-count N] [--min-sessions N] [--top N]
 *
 * Built at mantahostels#1299; `scripts/count-guard-fires.js` is the hook half.
 *
 *   SECTION 1, top-down and primary: every skill in `.claude/skills/` and
 *   `.agents/skills/` and every `npm run` name in package.json, with its
 *   invocation count and last invocation (mantahostels#1241).
 *
 *   SECTION 2, bottom-up and secondary: the most frequent normalised Bash
 *   command shapes matching no script, skill or `npm run` name. IT IS EXPECTED
 *   TO REPORT NOTHING OFTEN.
 *
 * NEEDS NO MODEL, and streams each transcript line by line rather than loading
 * it — the `measure-*` family convention.
 *
 * HAND-RUN, on no trigger at all: mantahostels#1243 ruled it so, and mantahostels#1240 refused a
 * diff-triggered check that would fire ~31 times a day and find nothing.
 *
 * The routes, the mention problem and the corpus bound:
 * `scripts/lib/encoding-use.js`.
 *
 * IN NO §N3 FAMILY, DELIBERATELY, as `count-guard-fires.js` is not: it gates
 * nothing, runs from a prompt, writes no file and files no issue. It exits 0
 * having reported, and borrows §N4's BROKEN 2 for a bad invocation alone —
 * nothing was measured, so a 0 there would read as a corpus of no invocations.
 */

const fs = require("node:fs");
const { writeFd } = require("./lib/write-fd.js");
const path = require("node:path");
const {
	transcriptDir,
	readTranscriptFiles,
	sessionKeyFor,
} = require("./lib/guard-fires");
const {
	streamRecords,
	readSkillInventory,
	npmScripts,
	recordUses,
	recordShapes,
	tally,
	isEncoded,
} = require("./lib/encoding-use");
const { flagValue, parseOrExit } = require("./lib/cli-args");
const { hostRoot } = require("./lib/host-root.js");

const ROOT = hostRoot();
const SKILL_ROOTS = [
	path.join(ROOT, ".claude", "skills"),
	path.join(ROOT, ".agents", "skills"),
];

/**
 * Straight to the fd, never `console`: node buffers writes to a PIPE and drops
 * whatever is still buffered at `process.exit` (`lib/check.js` carries the
 * measurement behind that rule).
 * @param {string} text
 */
const say = (text) => writeFd(1, `${text}\n`);

/** @param {string|null} iso */
const day = (iso) => (iso ? iso.slice(0, 10) : "never");

/**
 * A number flag's value, or `fallback` where it was not given; null where it
 * is not a non-negative number.
 * @param {string | undefined} given
 * @param {number} fallback
 * @returns {number | null}
 */
function numberFlag(given, fallback) {
	if (given === undefined) return fallback;
	const n = Number(given);
	return Number.isFinite(n) && n >= 0 ? n : null;
}

const CLI = {
	usage:
		"usage: node scripts/measure-encoding-use.js [--dir <path>] [--json] [--min-count N] [--min-sessions N] [--top N]",
	flags: /** @type {const} */ ({
		"--dir": "value",
		"--json": "boolean",
		"--min-count": "value",
		"--min-sessions": "value",
		"--top": "value",
	}),
};

/**
 * @typedef {Array<{subject: string, needle: string, route: string, at: string|null}>} Uses
 * @typedef {{uses: Uses, shapes: Uses, sessions: Map<string, Set<string>>}} ScanAcc
 * @typedef {{seenUse: Set<string>, seenShape: Set<string>, sessionKey: string}} SessionSeen
 *   one session's dedupe sets: a tool call split across records is one use
 * @typedef {Record<string, any>} TranscriptRecord One parsed transcript line.
 *   `any` because JSON.parse types nothing and each field is read and guarded
 *   where it is used.
 */

/**
 * Records that session `key` saw `id`.
 * @param {Map<string, Set<string>>} sessions accumulator: `key` is added under `id`
 * @param {string} id
 * @param {string} key
 */
function markSeen(sessions, id, key) {
	if (!sessions.has(id)) sessions.set(id, new Set());
	sessions.get(id)?.add(key);
}

/**
 * One record's invocations, each counted once a session.
 * @param {TranscriptRecord} record
 * @param {SessionSeen} seen accumulator: seenUse is filled; sessionKey is read
 * @param {ScanAcc} acc accumulator: each new use is pushed to uses and sessions
 */
function collectUses(record, seen, acc) {
	for (const use of recordUses(record)) {
		if (seen.seenUse.has(use.key)) continue;
		seen.seenUse.add(use.key);
		const id = `${use.kind}:${use.name}`;
		acc.uses.push({ subject: id, needle: "", route: use.route, at: use.at });
		markSeen(acc.sessions, id, seen.sessionKey);
	}
}

/**
 * One record's Bash shapes, each counted once a session.
 * @param {TranscriptRecord} record
 * @param {SessionSeen} seen accumulator: seenShape is filled; sessionKey is read
 * @param {ScanAcc} acc accumulator: each new shape is pushed to shapes and sessions
 */
function collectShapes(record, seen, acc) {
	for (const s of recordShapes(record)) {
		if (seen.seenShape.has(s.key)) continue;
		seen.seenShape.add(s.key);
		acc.shapes.push({
			subject: s.shape,
			needle: "",
			route: "shape",
			at: s.at,
		});
		markSeen(acc.sessions, `shape:${s.shape}`, seen.sessionKey);
	}
}

/**
 * Scan every transcript once, for invocations and for Bash shapes.
 *
 * A transcript that will not open is COUNTED AND NAMED rather than skipped
 * silently: it makes a count read low for a reason that is not the skill.
 *
 * @param {Array<{file: string, tier: "main" | "subagent"}>} files
 */
function scan(files) {
	// `subject` and `needle` are the shared roll-up's field names — a subject
	// there is a guard, here a skill, an `npm run` name or a Bash shape.
	/** @type {ScanAcc} */
	const acc = { uses: [], shapes: [], sessions: new Map() };
	/** @type {string[]} */
	const unreadable = [];

	for (const { file, tier } of files) {
		/** @type {SessionSeen} */
		const seen = {
			seenUse: new Set(),
			seenShape: new Set(),
			sessionKey: sessionKeyFor(file, tier),
		};
		try {
			for (const record of streamRecords(file, tier)) {
				collectUses(record, seen, acc);
				collectShapes(record, seen, acc);
			}
		} catch {
			unreadable.push(file);
		}
	}
	return {
		uses: tally(acc.uses),
		shapes: tally(acc.shapes),
		sessions: acc.sessions,
		unreadable,
	};
}

/**
 * Everything the report shows, as data: `--json` and the human table read it.
 *
 * @param {ReturnType<typeof scan>} scanned
 * @param {{minCount: number, minSessions: number, top: number}} bar
 */
function rows(scanned, bar) {
	const { skills, unreadable: unreadableRoots } =
		readSkillInventory(SKILL_ROOTS);
	const pkg = JSON.parse(
		fs.readFileSync(path.join(ROOT, "package.json"), "utf8"),
	);
	const npm = npmScripts(pkg);

	/** @param {Map<string, any>} rolled @param {string} id */
	const of = (rolled, id) => {
		const t = rolled.get(id);
		return {
			total: t?.total ?? 0,
			last: t?.last ?? null,
			byRoute: t?.byRoute ?? {},
			sessions: scanned.sessions.get(id)?.size ?? 0,
		};
	};

	// ONE ROW SHAPE for both halves, `note` carrying whatever only one of them
	// has, so the renderer never has to be told which half it is printing.
	const skillRows = skills.map((s) => ({
		name: s.name,
		note: [
			// The path, not the bare directory name: two roots can define one skill.
			`[${s.roots.map((r) => path.relative(ROOT, r)).join(", ")}]`,
			s.modelInvocable
				? ""
				: "— disable-model-invocation: the founder must type it",
		]
			.filter(Boolean)
			.join("  "),
		...of(scanned.uses, `skill:${s.name}`),
	}));

	const npmRows = npm.map((name) => ({
		name,
		note: "",
		...of(scanned.uses, `npm:${name}`),
	}));

	const encoded = {
		npm: new Set(npm),
		skills: new Set(skills.map((s) => s.name)),
	};
	const hand = [...scanned.shapes.entries()]
		.filter(([shape]) => !isEncoded(shape, encoded))
		.map(([shape, t]) => ({
			shape,
			total: t.total,
			last: t.last,
			sessions: scanned.sessions.get(`shape:${shape}`)?.size ?? 0,
		}))
		.filter((r) => r.total >= bar.minCount && r.sessions >= bar.minSessions)
		.sort((a, b) => b.total - a.total)
		.slice(0, bar.top);

	return { skills: skillRows, npm: npmRows, hand, bar, unreadableRoots };
}

/**
 * @param {{name: string, total: number, sessions: number, last: string|null, byRoute: Record<string, number>}} r
 */
const renderUse = (r) =>
	`  ${String(r.total).padStart(6)}  ${String(r.sessions).padStart(8)}  ${day(r.last)}  ${r.name}`;

/**
 * @param {ReturnType<typeof rows>} data
 * @param {{dir: string, files: number, unreadable: string[]}} corpus
 * @returns {string}
 */
function render(data, corpus) {
	const out = [];
	out.push(
		`CORPUS  ${corpus.files} transcripts in ${corpus.dir}, read ${new Date().toISOString().slice(0, 10)}.`,
		"        It grows daily — sessions write into it while this runs — so carry the count with",
		"        the figures. Both tiers are read: a main session's own file and every subagent",
		"        it dispatched, under that session's subagents/ directory (mantahostels#1779).",
	);
	if (corpus.unreadable.length > 0)
		out.push(
			`        ⚠ ${corpus.unreadable.length} transcript(s) could not be read, so every count below is a floor:`,
			...corpus.unreadable.map((f) => `          ${f}`),
		);
	out.push("");

	for (const root of data.unreadableRoots)
		out.push(
			`        ⚠ skill root ${root} could not be read, so the skills below are a floor —`,
			"          check the path rather than reading this as a repo with no skills.",
			"",
		);

	for (const [label, all] of /** @type {const} */ ([
		["SKILLS", data.skills],
		["NPM RUN NAMES", data.npm],
	])) {
		const used = all
			.filter((r) => r.total > 0)
			.sort((a, b) => b.total - a.total);
		const never = all.filter((r) => r.total === 0);
		out.push(
			`${label} — USED (${used.length} of ${all.length})`,
			"  INVOCS  SESSIONS  LAST USE    NAME",
		);
		for (const r of used) {
			out.push(renderUse(r));
			const routes = Object.entries(r.byRoute)
				.sort((a, b) => b[1] - a[1])
				.map(([route, n]) => `${route} ${n}`)
				.join(" · ");
			out.push(`          ${routes}`);
		}
		out.push(
			"",
			`${label} — NEVER USED (${never.length} of ${all.length}) — under the deterrence caveat`,
			"  A zero here is evidence about retrieval, never about a rule's worth: it may be a thing",
			"  nothing needed, or a thing nothing could find. Only the second is a defect.",
		);
		for (const r of never)
			out.push(`  0  ${r.name}${r.note ? `  ${r.note}` : ""}`);
		out.push("");
	}

	out.push(
		"STILL DONE BY HAND — Bash shapes matching no script, skill or `npm run` name",
		`  Bar: at least ${data.bar.minCount} invocations across at least ${data.bar.minSessions} sessions, top ${data.bar.top}.`,
		"  A frequent shape is NOT a thing that should be encoded — `git commit` and `cat` are",
		"  frequent and unencodable. This is a frequency table to read, never a finding.",
	);
	if (data.hand.length === 0) {
		out.push("  Nothing clears the bar.");
		return out.join("\n");
	}
	out.push("  INVOCS  SESSIONS  LAST USE    SHAPE");
	for (const r of data.hand)
		out.push(
			`  ${String(r.total).padStart(6)}  ${String(r.sessions).padStart(8)}  ${day(r.last)}  ${r.shape}`,
		);
	return out.join("\n");
}

/**
 * @param {string[]} argv
 * @returns {number} the exit code
 */
function main(argv) {
	const { flags } = parseOrExit(argv, CLI);
	const dir = flagValue(flags, "--dir") ?? transcriptDir(ROOT);
	// The defaults are first guesses: 25 invocations across 5 sessions is low
	// enough that this corpus prints ~30 shapes rather than a handful.
	const bar = { minCount: 25, minSessions: 5, top: 25 };
	for (const [key, flag] of /** @type {const} */ ([
		["minCount", "--min-count"],
		["minSessions", "--min-sessions"],
		["top", "--top"],
	])) {
		const value = numberFlag(flagValue(flags, flag), bar[key]);
		if (value === null) {
			// Name the flag as TYPED, never the field it fills.
			writeFd(2, `${flag} needs a non-negative number after it.\n`);
			return 2;
		}
		bar[key] = value;
	}

	const files = readTranscriptFiles(dir);
	if (files === null) {
		writeFd(2, `Cannot read transcripts in ${dir}.\n`);
		return 2;
	}

	const scanned = scan(files);
	const data = rows(scanned, bar);

	if (flags["--json"]) {
		say(
			JSON.stringify(
				{
					corpus: {
						dir,
						transcripts: files.length,
						unreadable: scanned.unreadable,
						read: new Date().toISOString(),
					},
					...data,
				},
				null,
				2,
			),
		);
		return 0;
	}

	say(
		render(data, { dir, files: files.length, unreadable: scanned.unreadable }),
	);
	return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
