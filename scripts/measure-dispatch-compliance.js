#!/usr/bin/env node
/*
 * measure-dispatch-compliance.js — mantahostels#766's re-measure, kept as a script.
 *
 * Prints the share of subagent dispatch prompts that instruct the agent to
 * write its artefact incrementally. Method and thresholds: ./lib/dispatch-compliance.js.
 *
 * mantahostels#766's own run, on or after 2 Sept 2026 — the window opens at 20 August, so
 * that the 19 August landing-day spike is excluded and the rate is steady-state:
 *
 *   node scripts/measure-dispatch-compliance.js --since 2026-08-20 --daily
 *
 * Windows are half-open, [since, until), and compared in UTC — the operator is
 * +08:00, so a local day boundary is not a window boundary. The corpus is
 * every seat's projects directory (#375); `--dir` reads one instead.
 *
 * The needle matches case-insensitively, which mantahostels#689 did not state either way;
 * it is worth ~60 extra hits corpus-wide (849 vs 789).
 *
 * REPORTS ONLY. Exit 0 on a reading; exit 2 only where no corpus directory
 * can be read at all, which must not be confused with a low rate.
 */

const fs = require("node:fs");
const { writeFd } = require("./lib/write-fd.js");
const {
	extractDispatches,
	groupByDay,
	readCorpusLines,
	summarise,
	verdict,
	HOLD_THRESHOLD,
} = require("./lib/dispatch-compliance.js");
const {
	listTranscripts,
	oneCopyEach,
	projectDirs,
} = require("./lib/project-dirs.js");
const { flagValue, parseOrExit } = require("./lib/cli-args");

/* Reference points, for the report to sit the new figure against.
 *
 * mantahostels#689 published its baseline as "8.6% (145/1,677) all-time BEFORE 19 August
 * 2026". That label is wrong, and this script disproves it: 1,677 = 1,436
 * pre-19-Aug + 241 on the day, and 145 = 13 + 18 + 114. So 8.6% is the
 * all-time rate INCLUDING 19 August. Strictly before the rule landed the rate
 * was 0.9% (13/1,436) — reproduce with `--until 2026-08-19`. Corrected at mantahostels#766;
 * the mislabel understates the rule's effect roughly tenfold. */
const REFERENCES = [
	["strictly before 19 Aug 2026 (true pre-rule baseline)", "0.9% (13/1,436)"],
	["19 Aug 2026, before the rule landed", "15% (18/121)"],
	["19 Aug 2026, after the rule landed", "95% (114/120)"],
	[
		"all time through 19 Aug 2026 (mantahostels#689's mislabelled 8.6%)",
		"8.6% (145/1,677)",
	],
];

/** The file's header comment, which is its `--help`. */
function buildHelpText() {
	const source = fs.readFileSync(__filename, "utf8");
	const end = source.indexOf("*/");
	const header = end === -1 ? source : source.slice(0, end);
	return header
		.split("\n")
		.filter((l) => l.startsWith(" *"))
		.map((l) => l.replace(/^ \*ance?/, "").replace(/^ \* ?/, ""))
		.join("\n")
		.trim();
}

/**
 * @param {string[]} argv
 * @returns {{dir: string|undefined, since: string|undefined, until: string|undefined,
 *   daily: boolean}}
 */
function parseArgs(argv) {
	const { flags } = parseOrExit(argv, {
		usage: buildHelpText(),
		flags: {
			"--daily": "boolean",
			"--dir": "value",
			"--since": "value",
			"--until": "value",
		},
	});
	return {
		dir: flagValue(flags, "--dir"),
		since: flagValue(flags, "--since"),
		until: flagValue(flags, "--until"),
		daily: flags["--daily"] === true,
	};
}

/** @param {number|null} rate */
function pct(rate) {
	return rate === null ? "n/a" : `${(rate * 100).toFixed(1)}%`;
}

/**
 * The corpus listing. A seat this machine does not run is absent, not
 * refused: counting it as refused would print on every run of a machine with
 * fewer seats. A `--dir` that does not exist is a typo, so it is refused.
 *
 * @param {string[]} dirs
 * @param {boolean} explicit whether `--dir` named the one directory
 * @returns {{ found: string[], refused: string[], absent: number }}
 */
function listCorpus(dirs, explicit) {
	const { found, absent, unreadable: refused } = listTranscripts(dirs);
	if (!explicit) return { found, refused, absent: absent.length };
	const missing = absent.map((d) => `${d} (ENOENT)`);
	return { found, refused: [...refused, ...missing], absent: 0 };
}

/**
 * The window as the report names it.
 * @param {{since: string|undefined, until: string|undefined}} opts
 */
function windowLabel(opts) {
	const win = [
		opts.since ? `since ${opts.since}` : null,
		opts.until ? `until ${opts.until}` : null,
	]
		.filter(Boolean)
		.join(", ");
	return win || "all time";
}

/**
 * The mantahostels#766 verdict line.
 * @param {{hold: boolean|null}} v
 */
function buildVerdictLine(v) {
	if (v.hold === null) return "No dispatches in this window — no verdict.";
	return v.hold
		? `>= ${HOLD_THRESHOLD * 100}% — mantahostels#766: the rule holds unenforced. Record the figure and close.`
		: `< ${HOLD_THRESHOLD * 100}% — mantahostels#766: reopen enforcement as mantahostels#689's option (C).`;
}

/**
 * `--daily`: the window broken down by UTC day.
 * @param {{timestamp: string, prompt: string}[]} dispatches
 * @param {{since: string|undefined, until: string|undefined}} opts
 */
function printDaily(dispatches, opts) {
	console.log("\nBy day (UTC):");
	for (const d of groupByDay(dispatches, {
		since: opts.since,
		until: opts.until,
	})) {
		console.log(
			`  ${d.day}  ${pct(d.rate).padStart(6)}  (${d.compliant}/${d.total})`,
		);
	}
}

function main() {
	const opts = parseArgs(process.argv.slice(2));

	const dirs = opts.dir ? [opts.dir] : projectDirs();
	const { found, refused, absent } = listCorpus(dirs, Boolean(opts.dir));
	if (refused.length + absent === dirs.length) {
		writeFd(
			2,
			`Cannot read any corpus directory: ${refused.join("; ") || `${absent} absent`}\n` +
				"This is a broken read, NOT a low compliance rate.\n",
		);
		process.exit(2);
	}
	const files = oneCopyEach(found);

	/* One file's contents in memory at a time: the corpus is ~2 GB across ~1,950
	 * transcripts against a 4 GB heap cap, and grows daily. */
	const stats = { unreadable: 0 };
	/** @param {string} file */
	const readFile = (file) => fs.readFileSync(file, "utf8");
	const dispatches = extractDispatches(readCorpusLines(files, readFile, stats));
	const unreadable = stats.unreadable;
	const s = summarise(dispatches, { since: opts.since, until: opts.until });
	const v = verdict(s.rate);

	console.log(`Corpus: ${files.length} transcripts in ${dirs.join(", ")}`);
	if (refused.length > 0) console.log(`  (not read: ${refused.join("; ")})`);
	if (unreadable) console.log(`  (${unreadable} unreadable, excluded)`);
	console.log(
		`Dispatches found (all time, deduplicated): ${dispatches.length}`,
	);
	console.log(`Window: ${windowLabel(opts)}`);
	console.log("");
	console.log(`Compliance: ${pct(s.rate)} (${s.compliant}/${s.total})`);
	console.log(buildVerdictLine(v));

	console.log("\nReference points:");
	for (const [label, figure] of REFERENCES)
		console.log(`  ${label}: ${figure}`);

	if (opts.daily) printDaily(dispatches, opts);
}

main();
