#!/usr/bin/env node

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

const REFERENCES = [
	["strictly before 19 Aug 2026 (true pre-rule baseline)", "0.9% (13/1,436)"],
	["19 Aug 2026, before the rule landed", "15% (18/121)"],
	["19 Aug 2026, after the rule landed", "95% (114/120)"],
	[
		"all time through 19 Aug 2026 (mantahostels#689's mislabelled 8.6%)",
		"8.6% (145/1,677)",
	],
];

const HELP_TEXT = `measure-dispatch-compliance.js — the share of subagent dispatch prompts that
instruct the agent to write its artefact incrementally (lucmoseley/mantahostels#766).

  node scripts/measure-dispatch-compliance.js --since 2026-08-20 --daily

Windows are half-open, [since, until), compared in UTC. The corpus is every
seat's projects directory; \`--dir\` reads one instead.

Reports only. Exit 0 on a reading; exit 2 only where no corpus directory can
be read at all.`;

/**
 * @param {string[]} argv
 * @returns {{dir: string|undefined, since: string|undefined, until: string|undefined,
 *   daily: boolean}}
 */
function parseArgs(argv) {
	const { flags } = parseOrExit(argv, {
		usage: HELP_TEXT,
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
 * @param {string[]} dirs
 * @param {boolean} explicit
 * @returns {{ found: string[], refused: string[], absent: number }}
 */
function listCorpus(dirs, explicit) {
	const { found, absent, unreadable: refused } = listTranscripts(dirs);
	if (!explicit) return { found, refused, absent: absent.length };
	const missing = absent.map((d) => `${d} (ENOENT)`);
	return { found, refused: [...refused, ...missing], absent: 0 };
}

/** @param {{since: string|undefined, until: string|undefined}} opts */
function windowLabel(opts) {
	const win = [
		opts.since ? `since ${opts.since}` : null,
		opts.until ? `until ${opts.until}` : null,
	]
		.filter(Boolean)
		.join(", ");
	return win || "all time";
}

/** @param {{hold: boolean|null}} v */
function buildVerdictLine(v) {
	if (v.hold === null) return "No dispatches in this window — no verdict.";
	return v.hold
		? `>= ${HOLD_THRESHOLD * 100}% — mantahostels#766: the rule holds unenforced. Record the figure and close.`
		: `< ${HOLD_THRESHOLD * 100}% — mantahostels#766: reopen enforcement as mantahostels#689's option (C).`;
}

/**
 * @param {{timestamp: string, prompt: string}[]} dispatches
 * @param {{since: string|undefined, until: string|undefined}} opts
 */
function printDaily(dispatches, opts) {
	writeFd(1, "\nBy day (UTC):\n");
	for (const d of groupByDay(dispatches, {
		since: opts.since,
		until: opts.until,
	})) {
		writeFd(
			1,
			`  ${d.day}  ${pct(d.rate).padStart(6)}  (${d.compliant}/${d.total})\n`,
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

	const stats = { unreadable: 0 };
	/** @param {string} file */
	const readFile = (file) => fs.readFileSync(file, "utf8");
	const dispatches = extractDispatches(readCorpusLines(files, readFile, stats));
	const unreadable = stats.unreadable;
	const s = summarise(dispatches, { since: opts.since, until: opts.until });
	const v = verdict(s.rate);

	writeFd(1, `Corpus: ${files.length} transcripts in ${dirs.join(", ")}\n`);
	if (refused.length > 0) writeFd(1, `  (not read: ${refused.join("; ")})\n`);
	if (unreadable) writeFd(1, `  (${unreadable} unreadable, excluded)\n`);
	writeFd(
		1,
		`Dispatches found (all time, deduplicated): ${dispatches.length}\n`,
	);
	writeFd(1, `Window: ${windowLabel(opts)}\n`);
	writeFd(1, "\n");
	writeFd(1, `Compliance: ${pct(s.rate)} (${s.compliant}/${s.total})\n`);
	writeFd(1, `${buildVerdictLine(v)}\n`);

	writeFd(1, "\nReference points:\n");
	for (const [label, figure] of REFERENCES)
		writeFd(1, `  ${label}: ${figure}\n`);

	if (opts.daily) printDaily(dispatches, opts);
}

main();
