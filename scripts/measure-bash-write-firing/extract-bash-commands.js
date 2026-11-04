#!/usr/bin/env node
/*
 * measure-bash-write-firing/extract-bash-commands.js — every Bash
 * `tool_input.command` in this machine's transcript corpus, one JSON record per
 * line, with the session id that issued it (mantahostels#2854's method, landed at mantahostels#2865).
 *
 *   node <this file> <out.jsonl>
 *
 * The corpus defaults to the HOST repo's own project transcripts on this seat —
 * `project-dirs.js`'s `corpusDirs`, the main checkout's and
 * each worktree's, never `$HOME` and a literal path — and is overridable with
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

const { corpusDirs, listTranscripts } = require("../lib/project-dirs.js");
const { parseJsonlRow } = require("../lib/jsonl.js");

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
 * @param {fs.WriteStream} out
 */
async function extractTranscript(f, tally, out) {
	const rl = readline.createInterface({
		input: fs.createReadStream(f),
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
			out.write(
				`${JSON.stringify({ s: rec.sessionId ?? path.basename(f), c: cmd })}\n`,
			);
		}
	}
}

async function main() {
	const outPath = process.argv[2];
	if (!outPath) {
		console.error("usage: extract-bash-commands.js <out.jsonl>");
		process.exitCode = 2;
		return;
	}
	const {
		found: files,
		absent,
		unreadable,
	} = listTranscripts(corpusDirs(process.env.WFC_TRANSCRIPT_DIR));
	const missed = [...absent, ...unreadable];
	if (missed.length > 0) {
		console.error(`cannot read the transcript corpus at ${missed.join(", ")}`);
		process.exitCode = 1;
		return;
	}
	const out = fs.createWriteStream(outPath);
	// Counted and printed rather than dropped: a truncated transcript is common
	// and a silent skip turns every downstream rate into one over an unknown
	// denominator (mantahostels#2865 review).
	const tally = { commands: 0, unparsed: 0 };
	for (const f of files) await extractTranscript(f, tally, out);
	await new Promise((resolve) => out.end(resolve));
	console.error(
		`transcripts=${files.length} commands=${tally.commands} unparsedLines=${tally.unparsed}`,
	);
}

module.exports = { main };

if (require.main === module)
	main().catch((e) => {
		console.error(e);
		process.exitCode = 1;
	});
