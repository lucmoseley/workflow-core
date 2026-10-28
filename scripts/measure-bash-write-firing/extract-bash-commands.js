#!/usr/bin/env node
/*
 * measure-bash-write-firing/extract-bash-commands.js — every Bash
 * `tool_input.command` in this machine's transcript corpus, one JSON record per
 * line, with the session id that issued it (mantahostels#2854's method, landed at mantahostels#2865).
 *
 *   node <this file> <out.jsonl>
 *
 * The corpus directory defaults to the HOST repo's own project transcripts —
 * `configDir()/projects/<the host root's slug>`, both through their seams (#1),
 * never `$HOME` and a literal path — and is overridable with
 * WFC_TRANSCRIPT_DIR, a path rather than a project name.
 *
 * STREAMS LINE BY LINE: the corpus is ~6 GB and will not fit in the heap cap
 * `~/.bashrc` sets.
 *
 * WHAT IT DOES NOT SEPARATE: a subagent's commands from its parent session's.
 * Both carry the parent's `sessionId`, so a per-session figure derived from
 * this file counts a dispatch's work against the session that dispatched it —
 * the trap the session-boundary measurement records at mantahostels#2561. Every mantahostels#2854
 * figure is a rate over commands, which that does not disturb.
 */
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");

const { slugForRepo } = require("../lib/project-slug");
const { configDir } = require("../lib/config-dir.js");
const { parseJsonlRow } = require("../lib/jsonl.js");

const dir =
	process.env.WFC_TRANSCRIPT_DIR ||
	path.join(configDir(), "projects", slugForRepo());

const outPath = process.argv[2];
if (!outPath) {
	console.error("usage: extract-bash-commands.js <out.jsonl>");
	process.exit(2);
}
const out = fs.createWriteStream(outPath);

/** The string Bash commands one transcript record's message carries, in order.
 * `any`: an unvalidated transcript line, read only through optional chains. */
function bashCommands(/** @type {any} */ rec) {
	const content = rec?.message?.content;
	if (!Array.isArray(content)) return [];
	const cmds = [];
	for (const c of content) {
		if (c?.type !== "tool_use" || c?.name !== "Bash") continue;
		const cmd = c?.input?.command;
		if (typeof cmd === "string") cmds.push(cmd);
	}
	return cmds;
}

/**
 * Writes one transcript's Bash commands to `out`, adding to `tally`'s
 * `commands` and `unparsed` counts.
 * @param {string} f
 * @param {{ commands: number; unparsed: number }} tally accumulator: counts commands and unparsed lines
 */
async function extractTranscript(f, tally) {
	const rl = readline.createInterface({
		input: fs.createReadStream(path.join(dir, f)),
		crlfDelay: Number.POSITIVE_INFINITY,
	});
	for await (const line of rl) {
		if (!line.includes('"Bash"')) continue;
		const rec = /** @type {Record<string, any> | null | undefined} */ (
			parseJsonlRow(line)
		);
		if (!rec) {
			if (rec === undefined) tally.unparsed++;
			continue;
		}
		for (const cmd of bashCommands(rec)) {
			tally.commands++;
			out.write(`${JSON.stringify({ s: rec.sessionId ?? f, c: cmd })}\n`);
		}
	}
}

async function main() {
	const files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
	// Counted and printed rather than dropped: a truncated transcript is common
	// and a silent skip turns every downstream rate into one over an unknown
	// denominator (mantahostels#2865 review).
	const tally = { commands: 0, unparsed: 0 };
	for (const f of files) await extractTranscript(f, tally);
	out.end(() =>
		console.error(
			`transcripts=${files.length} commands=${tally.commands} unparsedLines=${tally.unparsed}`,
		),
	);
}

main().catch((e) => {
	console.error(e);
	process.exitCode = 1;
});
