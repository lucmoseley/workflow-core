#!/usr/bin/env node
/*
 * measure-secret-ask.js — how often the guard's secret-ask cue, read over a
 * whole ending message rather than a round option alone, fires on the
 * session logs on disk (#1817).
 *
 * WHAT IS COUNTED. Every ending message of every main-session transcript under
 * `projects/` of `~/.claude`, `~/.claude2` and `~/.claude3` (or each `--dir`):
 * the assistant text after the last user record of any kind, taken where the
 * next record is a founder's prompt or the file ends — what a Stop hook reads.
 * Subagent transcripts are skipped, no Stop guard reading them. A message
 * replayed by a resumed or forked transcript counts once. `--until` drops a
 * message whose last text is stamped after that day (UTC), so a recorded rate
 * re-runs to the same count while its logs stay on disk.
 *
 * Each message is read by `lib/secret-ask.js`'s `proseAsk`, the guard's own
 * call. Every flag is printed with its file and line, for judging by hand: the
 * script counts firings, never false positives.
 *
 * IN NO §N3 FAMILY. It gates nothing and writes no file; it exits 1 only when
 * no transcript directory is readable, which must not read as a zero count,
 * or on an unhandled throw.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");
const { parseOrExit, flagValue } = require("./lib/cli-args");
const { planDirs } = require("./lib/plan-dirs");
const { caught } = require("./lib/caught");
const { writeFd } = require("./lib/write-fd");
const { proseAsk } = require("./lib/secret-ask");

const CLI = {
	usage:
		"usage: node scripts/measure-secret-ask.js [--dir <projects dir>]… [--until <YYYY-MM-DD>] [--json]",
	flags: {
		"--dir": /** @type {const} */ ("list"),
		"--until": /** @type {const} */ ("value"),
		"--json": /** @type {const} */ ("boolean"),
	},
};

/**
 * Every main-session transcript one directory deep under `dir`.
 * @param {string} dir
 * @returns {string[]}
 */
function transcripts(dir) {
	return fs
		.readdirSync(dir, { withFileTypes: true })
		.filter((d) => d.isDirectory())
		.flatMap((d) =>
			fs
				.readdirSync(path.join(dir, d.name))
				.filter((f) => f.endsWith(".jsonl"))
				.map((f) => path.join(dir, d.name, f)),
		);
}

/**
 * What one transcript line does to the message being gathered: nothing, clear
 * it (a tool result), end it (a founder's prompt), or add text to it.
 * @param {string} raw
 * @returns {{ kind: "skip" | "reset" | "prompt" } | { kind: "text", texts: string[], at: string }}
 */
function classifyRecord(raw) {
	const user = raw.includes('"type":"user"');
	/* An assistant record without a text part adds nothing and ends nothing. */
	if (!user && !raw.includes('"type":"text"')) return { kind: "skip" };
	if (user && raw.includes('"tool_result"')) return { kind: "reset" };
	let rec;
	try {
		rec = JSON.parse(raw);
	} catch {
		return { kind: "skip" };
	}
	if (rec.isSidechain) return { kind: "skip" };
	if (rec.type === "user") return { kind: "prompt" };
	const content = rec.type === "assistant" ? rec.message?.content : null;
	if (!Array.isArray(content)) return { kind: "skip" };
	const texts = content
		.filter((p) => p?.type === "text" && p.text)
		.map((p) => p.text);
	return texts.length > 0
		? { kind: "text", texts, at: String(rec.timestamp ?? "") }
		: { kind: "skip" };
}

/**
 * Each ending message in one transcript, with the line and timestamp of its
 * last text.
 * @param {string} file
 * @returns {AsyncGenerator<{ text: string, line: number, at: string }>}
 */
async function* endingMessages(file) {
	/** @type {string[]} */
	let parts = [];
	let last = { line: 0, at: "" };
	let n = 0;
	const lines = readline.createInterface({
		input: fs.createReadStream(file),
		crlfDelay: Number.POSITIVE_INFINITY,
	});
	for await (const raw of lines) {
		n++;
		const record = classifyRecord(raw);
		if (record.kind === "text") {
			parts.push(...record.texts);
			last = { line: n, at: record.at };
			continue;
		}
		if (record.kind === "prompt" && parts.length > 0)
			yield { text: parts.join("\n"), ...last };
		if (record.kind !== "skip") parts = [];
	}
	if (parts.length > 0) yield { text: parts.join("\n"), ...last };
}

/**
 * The flag for one message, or undefined where the cue is silent.
 * @param {string} text
 * @param {string} file
 * @param {number} line
 */
function flagOf(text, file, line) {
	const phrase = proseAsk(text);
	if (!phrase) return;
	const at = text.indexOf(phrase);
	const context = (
		at >= 0 ? text.slice(Math.max(0, at - 120), at + 160) : phrase
	).replace(/\s+/g, " ");
	return { file, line, phrase, context };
}

/**
 * @param {string[]} dirs
 * @param {string | undefined} until the last day counted, `YYYY-MM-DD`
 * @returns {Promise<{ messages: number, flags: NonNullable<ReturnType<typeof flagOf>>[] }>}
 */
async function scan(dirs, until) {
	const seen = new Set();
	let messages = 0;
	/** @type {NonNullable<ReturnType<typeof flagOf>>[]} */
	const flags = [];
	for (const file of dirs.flatMap(transcripts))
		for await (const { text, line, at } of endingMessages(file)) {
			if (until && at.slice(0, 10) > until) continue;
			if (seen.has(text)) continue;
			seen.add(text);
			messages++;
			const flag = flagOf(text, file, line);
			if (flag) flags.push(flag);
		}
	return { messages, flags };
}

async function main() {
	const { flags: given, lists } = parseOrExit(process.argv.slice(2), CLI);
	const dirs =
		lists["--dir"] ??
		planDirs(os.homedir()).map((d) => path.join(d, "projects"));
	const until = flagValue(given, "--until");
	const readable = dirs.filter((d) => fs.existsSync(d));
	if (readable.length === 0) {
		writeFd(
			2,
			`no transcript directory readable: ${dirs.join(", ")}\n` +
				"Pass --dir <projects dir>, a config dir's projects/ folder.\n",
		);
		process.exit(1);
	}
	const { messages, flags } = await scan(readable, until);
	if (given["--json"]) {
		writeFd(1, `${JSON.stringify({ messages, flags }, null, 2)}\n`);
		return;
	}
	for (const f of flags)
		writeFd(1, `${f.file}:${f.line}\n  “${f.phrase}”\n  …${f.context}…\n\n`);
	writeFd(
		1,
		`${messages} ending messages in ${readable.join(", ")}` +
			`${until ? ` through ${until}` : ""}; ${flags.length} flagged.\n`,
	);
}

if (require.main === module)
	main().catch((e) => {
		const { message } = caught(e);
		writeFd(2, `${e instanceof Error && e.stack ? e.stack : message}\n`);
		process.exit(1);
	});

module.exports = { main };
