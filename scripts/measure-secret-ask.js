#!/usr/bin/env node

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");
const { parseJsonlRow } = require("./lib/jsonl.js");
const { parseOrExit, flagValue } = require("./lib/cli-args");
const { readPlanDirs } = require("./lib/plan-dirs");
const { caught } = require("./lib/caught");
const { writeFd } = require("./lib/write-fd");
const { proseAsk } = require("./lib/secret-ask");

/** @typedef {import("./lib/transcript.js").TranscriptRecord} TranscriptRecord */

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
 * @param {string} dir
 * @returns {string[]}
 */
function readTranscripts(dir) {
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
 * @param {string} raw
 * @returns {{ kind: "skip" | "reset" | "prompt" } | { kind: "text", texts: string[], at: string }}
 */
function classifyRecord(raw) {
	const user = raw.includes('"type":"user"');
	if (!user && !raw.includes('"type":"text"')) return { kind: "skip" };
	if (user && raw.includes('"tool_result"')) return { kind: "reset" };
	const rec = /** @type {TranscriptRecord | null | undefined} */ (
		parseJsonlRow(raw)
	);
	if (!rec || rec.isSidechain) return { kind: "skip" };
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
 * @param {string} file
 * @returns {AsyncGenerator<{ text: string, line: number, at: string }>}
 */
async function* readEndingMessages(file) {
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
 * @param {string | undefined} until
 * @returns {Promise<{ messages: number, flags: NonNullable<ReturnType<typeof flagOf>>[] }>}
 */
async function scan(dirs, until) {
	const seen = new Set();
	let messages = 0;
	/** @type {NonNullable<ReturnType<typeof flagOf>>[]} */
	const flags = [];
	for (const file of dirs.flatMap(readTranscripts))
		for await (const { text, line, at } of readEndingMessages(file)) {
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
		readPlanDirs(os.homedir()).map((d) => path.join(d, "projects"));
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
