#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");

const { corpusDirs, listTranscripts } = require("../lib/project-dirs.js");
const { parseJsonlRow } = require("../lib/jsonl.js");

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
 * @param {string} f
 * @param {{ commands: number; unparsed: number }} tally
 * @param {fs.WriteStream} out
 */
async function extractTranscript(f, tally, out) {
	const rl = readline.createInterface({
		input: fs.createReadStream(f),
		crlfDelay: Number.POSITIVE_INFINITY,
	});
	for await (const line of rl) {
		if (!line.includes('"Bash"')) continue;
		const rec = parseJsonlRow(line);
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
