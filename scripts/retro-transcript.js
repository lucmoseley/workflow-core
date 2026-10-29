#!/usr/bin/env node
/*
 * retro-transcript.js — one session's JSONL log reduced to a line-numbered
 * text transcript a retro subagent can read (#962, spec #948 §Log reducer).
 *
 *   node scripts/retro-transcript.js <session.jsonl> [--out <path>]
 *
 * KEPT, one output line per item, each opening `L<n>` — the line of the log it
 * came from: founder messages; the refill loop's resume prompts, as LOOP;
 * assistant text; each tool call's name and a short input; each tool result's
 * error flag and its first 300 characters; hook feedback; compaction
 * boundaries; API errors. Everything else — thinking, the compaction summary,
 * task notifications, peer and plugin messages, and every bookkeeping record —
 * is dropped.
 *
 * SUBAGENT LOGS ARE FOLDED IN directly under the tool call that dispatched
 * them, matched on the `toolUseId` their `.meta.json` records and labelled by
 * its `description`, at the same reduction and one indent deeper. Their lines
 * carry their own file's numbers, prefixed with the agent id. A subagent whose
 * dispatching call is in no log read here is appended at the end, saying so.
 *
 * STREAMED, NEVER LOADED WHOLE: the log is read in fixed chunks and the output
 * written as each line is reduced. One log line is still held whole while it
 * is parsed.
 *
 * WRITES UNDER `.claude/tmp/` ONLY, by default to
 * `.claude/tmp/retro-transcripts/<log name>.txt` in the host repo. Any other
 * path, or a tracked one, is refused before the log is opened.
 *
 * A line that will not parse is skipped and counted, never thrown on: a live
 * log's last line can be half-written (lib/transcript.js, mantahostels#3311).
 * NOT lib/transcript.js's `mainChainRecords`, which takes the whole text: its
 * parse, skip count and sidechain rule are restated in `parseLine` and
 * `records` over streamed lines.
 *
 * TOKEN-SHAPED SUBSTRINGS ARE MASKED (#1031) to `[REDACTED:<rule>]` in every
 * line written, by `lib/token-shapes.js`: a token pasted into a session would
 * otherwise reach every retro that reads it, and the issues they file. Masked
 * before the per-item cut, so a token straddling it leaves no fragment.
 *
 * IN NO SCRIPT FAMILY (docs/code-standards-base.md §N3): a scratch writer. Exit 0
 * written, printing the output path, line count and any masked count; 1 the log unreadable; 2 bad
 * usage or a refused output path.
 */

const fs = require("node:fs");
const { writeFd } = require("./lib/write-fd.js");
const path = require("node:path");
const { StringDecoder } = require("node:string_decoder");
const { flagValue, parseOrExit } = require("./lib/cli-args");
const { hostRoot } = require("./lib/host-root");
const { requiredGroup } = require("./lib/regex-group");
const { isLoopPrompt } = require("./lib/loop-prompts");
const { maskTokens } = require("./lib/token-shapes");
const {
	STOP_FEEDBACK,
	parseContentText,
	subagentDirOf,
} = require("./lib/transcript");
const { caught } = require("./lib/caught.js");
const { execGit } = require("./lib/git.js");

const USAGE = `Usage: node scripts/retro-transcript.js <session.jsonl> [--out <path>]

Reduces one session log, its subagent logs folded in, to a line-numbered
transcript under .claude/tmp/. Default output:
.claude/tmp/retro-transcripts/<log name>.txt`;

const SCRATCH = path.join(".claude", "tmp");
/* Bytes per read: a guess, unmeasured. Any size streams; this sets only how
 * many reads a log takes. */
const CHUNK = 1 << 20;

/**
 * @typedef {Record<string, any>} LogRecord  one parsed log line. `any`: the log
 *   is Claude Code's format, which this repo does not define, so a narrower
 *   type would assert a shape nothing guarantees.
 * @typedef {Record<string, any>} ContentBlock  one block of a message's
 *   `content` array — text, tool_use or tool_result. `any` for LogRecord's
 *   reason: the block is that same undefined format, one level down.
 * @typedef {{ file: string, agent: string, description: string }} Subagent
 */

/* Characters kept per item. RESULT is the spec's ~300; the rest follow the
 * #883 trial's filter.py. */
const LIMIT = {
	founder: 1500,
	assistant: 1200,
	toolInput: 200,
	result: 300,
	hook: 300,
	apiError: 300,
};

/* Substrings masked so far, reported in the stdout summary. */
let masked = 0;

/**
 * @param {string} text
 */
function mask(text) {
	const result = maskTokens(text);
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

/**
 * Every line of a file, with its 1-based number, read CHUNK bytes at a time.
 * @param {string} file
 * @returns {Generator<{ n: number, line: string }>}
 */
function* readLines(file) {
	const fd = fs.openSync(file, "r");
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

/**
 * Whether a message's origin is the founder's: `human`, or none at all, which
 * is how older logs and the founder's `!` commands record him.
 * @param {string | undefined} kind
 */
const isFounder = (kind) => kind === undefined || kind === "human";

/**
 * A tool call's input, shortened to what identifies it.
 * @param {string} name
 * @param {LogRecord} input
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
 * The reduced items of one parsed record: `[label, text]` pairs, plus the id of
 * each tool call it makes so a subagent can be folded under it.
 *
 * @param {LogRecord} record
 * @param {"main" | "subagent"} tier
 * @returns {Reduced}
 */
function reduce(record, tier) {
	const reducer = REDUCERS.get(record.type);
	return reducer ? reducer(record, tier) : { items: [], toolIds: [] };
}

/**
 * Tool results, Stop hook feedback and the founder's prompt.
 * @param {LogRecord} record
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
	if (items.length > 0 || !text || record.isCompactSummary) return reduced;
	if (record.isMeta) {
		if (STOP_FEEDBACK.test(text))
			items.push(["HOOK Stop", short(text, LIMIT.hook)]);
	} else if (isLoopPrompt(text))
		/* Origin `human` too, but the loop typed it (#3381). */
		items.push(["LOOP", short(text, LIMIT.founder)]);
	else if (isFounder(kind))
		/* A subagent's opening message is its dispatch prompt, not the founder. */
		items.push([
			tier === "main" ? "FOUNDER" : "PROMPT",
			short(text, LIMIT.founder),
		]);
	return reduced;
}

/**
 * @param {ContentBlock[]} content
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
 * @param {LogRecord} record
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
 * @param {LogRecord} record
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
 * @param {LogRecord} record
 */
const stopSummaryCounts = (record) =>
	record.preventedContinuation || (record.hookErrors?.length ?? 0) > 0;

/**
 * @param {LogRecord} record
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
	else if (isLoopQueued(a))
		items.push([
			"LOOP queued",
			short(parseContentText(a.prompt), LIMIT.founder),
		]);
	else if (isFounderQueued(a))
		/* Typed while the session was busy, so logged only here, never as a
		 * user record. A peer's queued message fails `isFounder`. */
		items.push([
			"FOUNDER queued",
			short(parseContentText(a.prompt), LIMIT.founder),
		]);
	return { items, toolIds: [] };
}

/** @param {LogRecord} a  an attachment */
const isPromptQueued = (a) =>
	a.type === "queued_command" && a.commandMode === "prompt";

/** @param {LogRecord} a  an attachment */
const isLoopQueued = (a) =>
	isPromptQueued(a) && isLoopPrompt(parseContentText(a.prompt));

/** @param {LogRecord} a  an attachment */
const isFounderQueued = (a) =>
	isPromptQueued(a) && !isLoopQueued(a) && isFounder(a.origin?.kind);

/** @type {Map<unknown, (record: LogRecord, tier: "main" | "subagent") => Reduced>} */
const REDUCERS = new Map([
	["user", reduceUser],
	["assistant", reduceAssistant],
	["system", reduceSystem],
	["attachment", reduceAttachment],
]);

/** A subagent log's file name; the group is its stem, `agent-<id>`. */
const AGENT_LOG = /^(agent-.+)\.jsonl$/;

/**
 * The subagent logs beside `log`, keyed on the tool call that dispatched each.
 * A log with no readable `.meta.json`, or none naming a call, keys on its own
 * path so it is still reported.
 *
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
		/* No subagents directory is the usual case. An unreadable one reads the
		 * same, the transcript then simply carrying no folds. */
		return found;
	}
	for (const name of names) {
		const m = AGENT_LOG.exec(name);
		if (!m) continue;
		const stem = requiredGroup(m, 1, AGENT_LOG);
		const file = path.join(dir, name);
		/** @type {LogRecord} */
		let meta = {};
		try {
			meta = JSON.parse(
				fs.readFileSync(path.join(dir, `${stem}.meta.json`), "utf8"),
			);
		} catch {
			/* Keyed on its own path below, so the log is still reported. */
		}
		found.set(meta.toolUseId || file, {
			file,
			agent: stem.slice("agent-".length),
			description: meta.description || "(no .meta.json description)",
		});
	}
	return found;
}

/**
 * `file` with symlinks dereferenced as far as it exists: a path not yet made is
 * resolved through its nearest existing ancestor, so a refused one is never
 * created.
 * @param {string} file
 */
function readRealPath(file) {
	/** @type {string[]} */
	const rest = [];
	let at = file;
	while (!fs.existsSync(at) && path.dirname(at) !== at) {
		rest.unshift(path.basename(at));
		at = path.dirname(at);
	}
	return path.join(fs.realpathSync(at), ...rest);
}

/**
 * Where the transcript goes, or the reason it may not go there.
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
	/* Real paths on both sides, so a symlink out of .claude/tmp/ is no way out. */
	const real = readRealPath(out);
	if (!real.startsWith(fs.realpathSync(scratch) + path.sep))
		return { refused: `${out} is outside ${scratch}${path.sep}` };
	try {
		execGit(["ls-files", "--error-unmatch", "--", real], {
			cwd: root,
			stdio: "ignore",
		});
		return { refused: `${out} is a tracked file` };
	} catch (e) {
		/* Exit 1 is git's "not tracked". Anything else — no git, no repository —
		 * leaves the question open, and an open question refuses. */
		if (caught(e).status !== 1)
			return { refused: `git cannot say whether ${out} is tracked` };
	}
	fs.mkdirSync(path.dirname(real), { recursive: true });
	return { out: real };
}

/**
 * Every line of a log with its parsed record, or null for one walk skips: a
 * blank line, one that will not parse (reported to `onUnparseable`), and in the
 * main log a sidechain record.
 * @param {string} file
 * @param {"main" | "subagent"} tier
 * @param {() => void} onUnparseable
 * @returns {Generator<{ n: number, record: LogRecord | null }>}
 */
function* records(file, tier, onUnparseable) {
	for (const { n, line } of readLines(file))
		yield { n, record: parseLine(line, tier, onUnparseable) };
}

/**
 * @param {string} line
 * @param {"main" | "subagent"} tier
 * @param {() => void} onUnparseable
 * @returns {LogRecord | null}
 */
function parseLine(line, tier, onUnparseable) {
	if (!line) return null;
	/** @type {LogRecord} */
	let record;
	try {
		record = JSON.parse(line);
	} catch {
		onUnparseable();
		return null;
	}
	if (tier === "main" && record.isSidechain) return null;
	return record;
}

/**
 * @param {string} prefix  indent and agent tag
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
	const root = hostRoot();

	const target = outputPath(root, log, requested);
	if ("refused" in target) {
		writeFd(
			2,
			`retro-transcript: refused: ${target.refused}. Write under ${path.join(root, SCRATCH)}${path.sep}, or omit --out.\n`,
		);
		process.exit(2);
	}
	let readable = false;
	try {
		fs.accessSync(log, fs.constants.R_OK);
		readable = fs.statSync(log).isFile();
	} catch {
		/* Missing and unreadable answer alike: `readable` stays false. */
	}
	if (!readable) {
		writeFd(
			2,
			`retro-transcript: cannot read ${log} as a log file. Pass a session's <id>.jsonl, as listed under <config dir>/projects/<project>/.\n`,
		);
		process.exit(1);
	}

	const subagents = readSubagentsOf(log);
	const fd = fs.openSync(target.out, "w");
	let written = 0;
	let skipped = 0;
	/** @param {string} text */
	const emit = (text) => {
		/* The few texts no `short` call cut — a subagent's description. */
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
	 * @param {string} tag  the agent id a subagent's line numbers belong to
	 * @returns {number}  the file's last line number
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
	 * Folds in, once each, the subagents the given tool calls dispatched.
	 * @param {string[]} toolIds
	 * @param {number} depth  the subagents' own indent level
	 * @param {string} at  the dispatching line's reference
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
	 * @param {number} depth  the subagent's own indent level
	 * @param {string} at  the dispatching line's reference
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
		const last = walk(log, "main", 0, "");
		for (const sub of [...subagents.values()])
			fold(
				sub,
				0,
				`L${last}`,
				" — its dispatching call is in no log read here",
			);
	} finally {
		fs.closeSync(fd);
	}
	writeFd(
		1,
		`${target.out}\n${written} lines${skipped ? `, ${skipped} unparseable log lines skipped` : ""}${masked ? `, ${masked} token-shaped substrings masked` : ""}\n`,
	);
}

main();
