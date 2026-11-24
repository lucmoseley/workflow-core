#!/usr/bin/env node
const fs = require("node:fs");
const { scriptPath } = require("./lib/script-path.js");
const { writeFd } = require("./lib/write-fd.js");
const path = require("node:path");
const { StringDecoder } = require("node:string_decoder");
const { flagValue, parseOrExit } = require("./lib/cli-args");
const { worktreeRoot } = require("./lib/host-root");
const { requiredGroup } = require("./lib/regex-group");
const { isLoopPrompt, isScriptPrompt } = require("./lib/loop-prompts");
const { buildMasker } = require("./lib/token-shapes");
const { writeStreamAtomic } = require("./lib/atomic-write.js");
const { readStoredSecrets, secretsFile } = require("./lib/env-file.js");
const {
	STOP_FEEDBACK,
	parseContentText,
	subagentDirOf,
} = require("./lib/transcript");
const { caught, orFallback } = require("./lib/caught.js");
const { parseJsonlRow } = require("./lib/jsonl.js");
const { execGit } = require("./lib/git.js");
const { relativeUnder } = require("./lib/is-under.js");

const USAGE = `Usage: node ${scriptPath("retro-transcript.js")} <session.jsonl> [--out <path>]

Reduces one session log, its subagent logs folded in, to a line-numbered
transcript under .claude/tmp/. Default output:
.claude/tmp/retro-transcripts/<log name>.txt`;

const SCRATCH = path.join(".claude", "tmp");
// workflow-core#962 guess
const CHUNK = 1 << 20;

/**
 * @typedef {import("./lib/transcript.js").TranscriptRecord} TranscriptRecord
 * @typedef {import("./lib/transcript.js").TranscriptBlock} TranscriptBlock
 * @typedef {{ file: string, agent: string, description: string }} Subagent
 */

// workflow-core#948 workflow-core#883: RESULT is the spec's ~300, the rest the trial's filter.py, a guess
const LIMIT = {
	founder: 1500,
	assistant: 1200,
	toolInput: 200,
	result: 300,
	hook: 300,
	apiError: 300,
};

let masked = 0;

/** @type {((text: string) => { text: string, count: number }) | undefined} */
let masker;

/**
 * @param {string} text
 */
function mask(text) {
	if (!masker) throw new Error("mask ran before main built the masker");
	const result = masker(text);
	masked += result.count;
	return result.text;
}

/**
 * @param {unknown} value
 * @param {number} limit
 */
function short(value, limit) {
	const text = mask(
		typeof value === "string" ? value : JSON.stringify(value) || "",
	).replace(/\n/g, " | ");
	return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

class UnreadableLog extends Error {}

/**
 * @param {string} file
 * @returns {Generator<{ n: number, line: string }>}
 */
function* readLines(file) {
	let fd;
	try {
		fd = fs.openSync(file, "r");
	} catch (e) {
		const { code, message } = caught(e);
		throw new UnreadableLog(`cannot read ${file} (${code ?? message})`, {
			cause: e,
		});
	}
	const buf = Buffer.alloc(CHUNK);
	const decoder = new StringDecoder("utf8");
	let carry = "";
	let n = 0;
	try {
		for (;;) {
			const got = fs.readSync(fd, buf, 0, CHUNK, null);
			if (got === 0) break;
			const parts = (carry + decoder.write(buf.subarray(0, got))).split("\n");
			carry = parts.pop() ?? "";
			for (const line of parts) yield { n: ++n, line };
		}
		carry += decoder.end();
		if (carry) yield { n: ++n, line: carry };
	} finally {
		fs.closeSync(fd);
	}
}

/** @param {string | undefined} kind */
const isFounder = (kind) => kind === undefined || kind === "human";

/**
 * @param {string} name
 * @param {TranscriptBlock["input"]} input
 */
function toolInput(name, input) {
	if (name === "Bash") return input.command ?? "";
	if (input.file_path) return input.file_path;
	if (name === "Agent" || name === "Task")
		return [input.description, input.subagent_type, input.prompt]
			.filter(Boolean)
			.join(" / ");
	return input;
}

/**
 * @typedef {{ items: [string, string][], toolIds: string[] }} Reduced
 */

/**
 * @param {TranscriptRecord} record
 * @param {"main" | "subagent"} tier
 * @returns {Reduced}
 */
function reduce(record, tier) {
	const reducer = REDUCERS.get(record.type);
	return reducer ? reducer(record, tier) : { items: [], toolIds: [] };
}

/**
 * @param {TranscriptRecord} record
 * @param {"main" | "subagent"} tier
 * @returns {Reduced}
 */
function reduceUser(record, tier) {
	const content = record.message?.content;
	const items = Array.isArray(content) ? resultItems(content) : [];
	/** @type {Reduced} */
	const reduced = { items, toolIds: [] };
	const text = parseContentText(content);
	const kind = record.origin?.kind;
	const typist = typistLabelOf(text);
	if (items.length > 0 || !text || record.isCompactSummary) return reduced;
	if (record.isMeta) {
		if (STOP_FEEDBACK.test(text))
			items.push(["HOOK Stop", short(text, LIMIT.hook)]);
	} else if (typist) items.push([typist, short(text, LIMIT.founder)]);
	else if (isFounder(kind))
		items.push([
			tier === "main" ? "FOUNDER" : "PROMPT",
			short(text, LIMIT.founder),
		]);
	return reduced;
}

/**
 * @param {TranscriptBlock[]} content
 * @returns {[string, string][]}
 */
function resultItems(content) {
	/** @type {[string, string][]} */
	const items = [];
	for (const b of content) {
		if (b?.type !== "tool_result") continue;
		const label = b.is_error ? "RESULT ERROR" : "RESULT";
		items.push([label, short(parseContentText(b.content), LIMIT.result)]);
	}
	return items;
}

/**
 * @param {TranscriptRecord} record
 * @returns {Reduced}
 */
function reduceAssistant(record) {
	/** @type {Reduced} */
	const reduced = { items: [], toolIds: [] };
	const { items, toolIds } = reduced;
	const content = record.message?.content ?? [];
	if (record.isApiErrorMessage) {
		items.push([
			`API-ERROR${record.error ? ` ${record.error}` : ""}`,
			short(parseContentText(content), LIMIT.apiError),
		]);
		return reduced;
	}
	for (const b of content) {
		if (b?.type === "text" && b.text)
			items.push(["ASSISTANT", short(b.text, LIMIT.assistant)]);
		else if (b?.type === "tool_use") {
			items.push([
				`TOOL ${b.name}`,
				short(toolInput(b.name, b.input ?? {}), LIMIT.toolInput),
			]);
			if (b.id) toolIds.push(b.id);
		}
	}
	return reduced;
}

/**
 * @param {TranscriptRecord} record
 * @returns {Reduced}
 */
function reduceSystem(record) {
	/** @type {[string, string][]} */
	const items = [];
	const { subtype } = record;
	if (subtype === "compact_boundary")
		items.push([
			"===== COMPACTION",
			short(record.compactMetadata ?? "", LIMIT.hook),
		]);
	else if (subtype === "api_error")
		items.push([
			"API-ERROR",
			short(
				record.error?.formatted ?? record.error?.message ?? record.error,
				LIMIT.apiError,
			),
		]);
	else if (subtype === "stop_hook_summary" && stopSummaryCounts(record))
		items.push([
			"HOOK Stop summary",
			short(
				(record.hookErrors ?? []).join(" ‖ ") ||
					record.stopReason ||
					"prevented continuation",
				LIMIT.hook,
			),
		]);
	return { items, toolIds: [] };
}

/**
 * @param {TranscriptRecord} record
 */
const stopSummaryCounts = (record) =>
	record.preventedContinuation || (record.hookErrors?.length ?? 0) > 0;

/**
 * @param {TranscriptRecord} record
 * @returns {Reduced}
 */
function reduceAttachment(record) {
	/** @type {[string, string][]} */
	const items = [];
	const a = record.attachment ?? {};
	const hook = a.hookName ? ` ${a.hookName}` : "";
	if (a.type === "hook_blocking_error")
		items.push([
			`HOOK BLOCK${hook}`,
			short(a.blockingError?.blockingError ?? a.blockingError, LIMIT.hook),
		]);
	else if (
		a.type === "hook_system_message" ||
		a.type === "hook_additional_context"
	)
		items.push([
			`HOOK${hook}`,
			short(
				Array.isArray(a.content) ? a.content.join(" ") : a.content,
				LIMIT.hook,
			),
		]);
	else if (a.type === "hook_cancelled")
		items.push([`HOOK CANCELLED${hook}`, ""]);
	else if (queuedTypistOf(a))
		items.push([
			`${queuedTypistOf(a)} queued`,
			short(parseContentText(a.prompt), LIMIT.founder),
		]);
	else if (isFounderQueued(a))
		items.push([
			"FOUNDER queued",
			short(parseContentText(a.prompt), LIMIT.founder),
		]);
	return { items, toolIds: [] };
}

/** @param {TranscriptRecord["attachment"]} a */
const isPromptQueued = (a) =>
	a.type === "queued_command" && a.commandMode === "prompt";

/** @param {string} text */
function typistLabelOf(text) {
	if (isLoopPrompt(text)) return "LOOP";
	return isScriptPrompt(text) ? "SCRIPT" : null;
}

/** @param {TranscriptRecord["attachment"]} a */
const queuedTypistOf = (a) =>
	isPromptQueued(a) ? typistLabelOf(parseContentText(a.prompt)) : null;

/** @param {TranscriptRecord["attachment"]} a */
const isFounderQueued = (a) =>
	isPromptQueued(a) && !queuedTypistOf(a) && isFounder(a.origin?.kind);

/** @type {Map<unknown, (record: TranscriptRecord, tier: "main" | "subagent") => Reduced>} */
const REDUCERS = new Map([
	["user", reduceUser],
	["assistant", reduceAssistant],
	["system", reduceSystem],
	["attachment", reduceAttachment],
]);

const AGENT_LOG = /^(agent-.+)\.jsonl$/;

/**
 * @param {string} log
 * @returns {Map<string, Subagent>}
 */
function readSubagentsOf(log) {
	const dir = subagentDirOf(log);
	/** @type {Map<string, Subagent>} */
	const found = new Map();
	let names;
	try {
		names = fs.readdirSync(dir).sort();
	} catch {
		return found;
	}
	for (const name of names) {
		const m = AGENT_LOG.exec(name);
		if (!m) continue;
		const stem = requiredGroup(m, 1, AGENT_LOG);
		const file = path.join(dir, name);
		/** @type {{ toolUseId?: string, description?: string }} */
		const meta = orFallback(
			() =>
				JSON.parse(
					fs.readFileSync(path.join(dir, `${stem}.meta.json`), "utf8"),
				),
			{},
		);
		found.set(meta.toolUseId || file, {
			file,
			agent: stem.slice("agent-".length),
			description: meta.description || "(no .meta.json description)",
		});
	}
	return found;
}

// Linux follows at most 40 links resolving one path: https://man7.org/linux/man-pages/man7/path_resolution.7.html
const MAX_LINKS = 40;

/**
 * @param {string} file
 * @param {number} [links]
 * @returns {string}
 */
function readRealPath(file, links = 0) {
	/** @type {string[]} */
	const rest = [];
	let at = file;
	while (!fs.existsSync(at) && path.dirname(at) !== at) {
		if (isLink(at)) {
			if (links >= MAX_LINKS) throw new Error(`${file} is a symlink loop`);
			const target = path.resolve(
				fs.realpathSync(path.dirname(at)),
				fs.readlinkSync(at),
			);
			return path.join(readRealPath(target, links + 1), ...rest);
		}
		rest.unshift(path.basename(at));
		at = path.dirname(at);
	}
	return path.join(fs.realpathSync(at), ...rest);
}

/** @param {string} at */
function isLink(at) {
	try {
		return fs.lstatSync(at).isSymbolicLink();
	} catch {
		return false;
	}
}

/**
 * @param {string} root
 * @param {string} log
 * @param {string | undefined} requested
 * @returns {{ out: string } | { refused: string }}
 */
function outputPath(root, log, requested) {
	const scratch = path.join(root, SCRATCH);
	const out = requested
		? path.resolve(requested)
		: path.join(
				scratch,
				"retro-transcripts",
				`${path.basename(log, ".jsonl")}.txt`,
			);
	fs.mkdirSync(scratch, { recursive: true });
	let real;
	try {
		real = readRealPath(out);
	} catch (e) {
		return { refused: caught(e).message };
	}
	if (!relativeUnder(fs.realpathSync(scratch), real))
		return { refused: `${out} is outside ${scratch}${path.sep}` };
	try {
		execGit(["ls-files", "--error-unmatch", "--", real], {
			cwd: root,
			stdio: "ignore",
		});
		return { refused: `${out} is a tracked file` };
	} catch (e) {
		if (caught(e).status !== 1)
			return { refused: `git cannot say whether ${out} is tracked` };
	}
	fs.mkdirSync(path.dirname(real), { recursive: true });
	return { out: real };
}

/**
 * @param {string} file
 * @param {"main" | "subagent"} tier
 * @param {() => void} onUnparseable
 * @returns {Generator<{ n: number, record: TranscriptRecord | null }>}
 */
function* records(file, tier, onUnparseable) {
	for (const { n, line } of readLines(file))
		yield { n, record: parseLine(line, tier, onUnparseable) };
}

/**
 * @param {string} line
 * @param {"main" | "subagent"} tier
 * @param {() => void} onUnparseable
 * @returns {TranscriptRecord | null}
 */
function parseLine(line, tier, onUnparseable) {
	const record = /** @type {TranscriptRecord | null | undefined} */ (
		parseJsonlRow(line)
	);
	if (record === null) return null;
	if (record === undefined) {
		onUnparseable();
		return null;
	}
	if (tier === "main" && record.isSidechain) return null;
	return record;
}

/**
 * @param {string} prefix
 * @param {number} n
 * @param {string} time
 * @param {[string, string]} item
 */
function buildItemLine(prefix, n, time, [label, text]) {
	return `${prefix}L${n}${time ? ` ${time}` : ""} ${label}${text ? `: ${text}` : ""}`;
}

function main() {
	const { flags, positionals } = parseOrExit(process.argv.slice(2), {
		usage: USAGE,
		flags: { "--out": "value" },
		min: 1,
	});
	const [logArg] = positionals;
	if (logArg === undefined)
		throw new Error("parseOrExit passed no log path despite min: 1");
	const log = path.resolve(logArg);
	const requested = flagValue(flags, "--out");
	const root = worktreeRoot();

	const target = outputPath(root, log, requested);
	if ("refused" in target) {
		writeFd(
			2,
			`retro-transcript: refused: ${target.refused}. Write under ${path.join(root, SCRATCH)}${path.sep}, or omit --out.\n`,
		);
		process.exit(2);
	}
	const readable = orFallback(() => {
		fs.accessSync(log, fs.constants.R_OK);
		return fs.statSync(log).isFile();
	}, false);
	if (!readable) {
		writeFd(
			2,
			`retro-transcript: cannot read ${log} as a log file. Pass a session's <id>.jsonl, as listed under <config dir>/projects/<project>/.\n`,
		);
		process.exit(1);
	}

	try {
		const { names, values } = readStoredSecrets();
		masker = buildMasker(
			names,
			values.flatMap((v) => [v, JSON.stringify(v).slice(1, -1)]),
		);
	} catch (e) {
		writeFd(
			2,
			`retro-transcript: refused: ${caught(e).message}. Fix or trim ${secretsFile()}, then rerun.\n`,
		);
		process.exit(1);
	}

	const subagents = readSubagentsOf(log);
	let fd = -1;
	let written = 0;
	let skipped = 0;
	/** @param {string} text */
	const emit = (text) => {
		fs.writeSync(fd, `${mask(text)}\n`);
		written++;
	};

	const unparseable = () => {
		skipped++;
	};

	/**
	 * @param {string} file
	 * @param {"main" | "subagent"} tier
	 * @param {number} depth
	 * @param {string} tag
	 * @returns {number}
	 */
	const walk = (file, tier, depth, tag) => {
		const indent = "  ".repeat(depth);
		const where = tag ? `[${tag}] ` : "";
		let last = 0;
		for (const { n, record } of records(file, tier, unparseable)) {
			last = n;
			if (!record) continue;
			const { items, toolIds } = reduce(record, tier);
			const time = (record.timestamp ?? "").slice(11, 19);
			for (const item of items)
				emit(buildItemLine(`${indent}${where}`, n, time, item));
			foldDispatched(toolIds, depth + 1, `${where}L${n}`);
		}
		return last;
	};

	/**
	 * @param {string[]} toolIds
	 * @param {number} depth
	 * @param {string} at
	 */
	const foldDispatched = (toolIds, depth, at) => {
		for (const id of toolIds) {
			const sub = subagents.get(id);
			if (!sub) continue;
			subagents.delete(id);
			fold(sub, depth, at);
		}
	};

	/**
	 * @param {Subagent} sub
	 * @param {number} depth
	 * @param {string} at
	 * @param {string} [note]
	 */
	const fold = (sub, depth, at, note = "") => {
		const indent = "  ".repeat(depth);
		const name = path.basename(sub.file);
		emit(
			`${indent}${at} ┌ subagent ${sub.agent} "${sub.description}" (${name})${note}`,
		);
		walk(sub.file, "subagent", depth, sub.agent);
		emit(`${indent}${at} └ end subagent ${sub.agent}`);
	};

	try {
		writeStreamAtomic(target.out, (opened) => {
			fd = opened;
			const last = walk(log, "main", 0, "");
			for (const sub of [...subagents.values()])
				fold(
					sub,
					0,
					`L${last}`,
					" — its dispatching call is in no log read here",
				);
		});
	} catch (e) {
		if (!(e instanceof UnreadableLog)) throw e;
		writeFd(
			2,
			`retro-transcript: ${e.message}. ${target.out} is as it was. Repair or remove that log, then rerun.\n`,
		);
		process.exit(1);
	}
	writeFd(
		1,
		`${target.out}\n${written} lines${skipped ? `, ${skipped} unparseable log lines skipped` : ""}${masked ? `, ${masked} token-shaped substrings masked` : ""}\n`,
	);
}

main();
