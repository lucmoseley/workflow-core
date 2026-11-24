const fs = require("node:fs");
const path = require("node:path");
const { mainChainRecords, isSubagentTranscript } = require("./transcript");
const { readText } = require("./file-read.js");
const { corpusDirs } = require("./project-dirs.js");
const { coreRoot } = require("./script-path.js");
const { readRunningHooks } = require("./core-hooks.js");

const SHIM = "scripts/run-pinned-guards.js";

const HOOK_ATTACHMENTS = new Set([
	"hook_success",
	"hook_additional_context",
	"hook_system_message",
	"hook_blocking_error",
	"hook_non_blocking_error",
	"hook_cancelled",
]);

/**
 * @typedef {{route: "hook" | "deny" | "cli", text: string, command?: string,
 *   toolUseID?: string}} Span
 * @typedef {{id: string, kind?: "block" | "deny" | "inject" | "notice" | "warn",
 *   routes?: string[], core?: string,
 *   text: string|string[], unless?: string[]}} Needle
 * @typedef {{id: string, routes?: string[], needles: Needle[]}} Subject
 * @typedef {{subject: string, needle: string, route: string,
 *   at: string|null, key: string}} Fire
 * @typedef {{file: string, tier: "main" | "subagent"}} TranscriptFile
 * @typedef {import("./transcript.js").TranscriptRecord} TranscriptRecord
 */

/**
 * @param {unknown} args
 * @returns {string[]}
 */
function argWords(args) {
	if (typeof args === "string") return args ? [args] : [];
	return Array.isArray(args) ? args.map(String) : [];
}

/**
 * @param {string} command
 * @param {string[] | string} [args]
 * @returns {string}
 */
function guardKey(command, args) {
	const words = [...String(command || "").split(/\s+/), ...argWords(args)];
	const at = words.findIndex(
		(w) => /scripts\/[\w.-]+$/.test(w.replace(/"/g, "")) && !w.endsWith(SHIM),
	);
	const word = words[at];
	if (word === undefined) return "";
	const name = word.replace(/"/g, "").split("/").pop();
	const rest = words
		.slice(at + 1)
		.filter((w) => w && !["||", "&&", "true", ";", "2>/dev/null"].includes(w));
	return [name, ...rest].join(" ");
}

/**
 * @param {Record<string, any>} settings
 * @returns {Array<{key: string, event: string, matcher?: string, if?: string, command: string}>}
 */
function registeredGuards(settings) {
	const out = [];
	for (const [event, entries] of Object.entries(settings?.hooks ?? {})) {
		for (const entry of /** @type {any[]} */ (entries) ?? []) {
			for (const h of entry?.hooks ?? []) {
				const key = guardKey(h?.command ?? "", h?.args);
				if (!key) continue;
				out.push({
					key,
					event,
					matcher: entry?.matcher,
					if: h?.if,
					command: h.command,
				});
			}
		}
	}
	return out;
}

/**
 * @param {Array<{file: string, settings: Record<string, any> | null}>} sources
 * @returns {Map<string, string[]>}
 */
function keyOrigins(sources) {
	/** @type {Map<string, string[]>} */
	const out = new Map();
	for (const { file, settings } of sources)
		for (const key of guardKeys(settings ?? {}))
			out.set(key, [...(out.get(key) ?? []), file]);
	return out;
}

/**
 * @param {Record<string, any>} settings
 * @returns {string[]}
 */
function guardKeys(settings) {
	return [...new Set(registeredGuards(settings).map((r) => r.key))];
}

/**
 * @param {string} text
 * @param {string | string[]} needle
 * @returns {boolean}
 */
function hasNeedle(text, needle) {
	const parts = Array.isArray(needle) ? needle : [needle];
	return parts.every((p) => text.includes(p));
}

/**
 * @param {string} text
 * @param {Pick<Needle, "text" | "unless">} needle
 * @returns {boolean}
 */
function needleIn(text, needle) {
	if (!hasNeedle(text, needle.text)) return false;
	return !(needle.unless ?? []).some((u) => text.includes(u));
}

/**
 * @param {unknown} v
 * @returns {string[]}
 */
function stringsIn(v) {
	if (typeof v === "string") return v ? [v] : [];
	if (Array.isArray(v)) return v.filter((x) => typeof x === "string" && x);
	if (v && typeof v === "object")
		return Object.values(v).filter((x) => typeof x === "string" && x);
	return [];
}

/**
 * @param {TranscriptRecord} record
 * @returns {Span[]}
 */
function hookSpans(record) {
	const a = record?.attachment;
	if (!a || !HOOK_ATTACHMENTS.has(a.type)) return [];
	/** @type {Span[]} */
	const spans = [];
	for (const field of ["stdout", "content", "blockingError"]) {
		for (const text of stringsIn(a[field]))
			spans.push({
				route: "hook",
				text,
				command: a.command,
				...(typeof a.toolUseID === "string" && a.toolUseID
					? { toolUseID: a.toolUseID }
					: {}),
			});
	}
	return spans;
}

/**
 * @param {TranscriptRecord} record
 * @returns {Span[]}
 */
function denySpans(record) {
	const content = record?.message?.content;
	if (!Array.isArray(content)) return [];
	/** @type {Span[]} */
	const spans = [];
	for (const part of content) {
		if (part?.type !== "tool_result" || !part.is_error) continue;
		const id =
			typeof part.tool_use_id === "string" && part.tool_use_id
				? { toolUseID: part.tool_use_id }
				: {};
		for (const text of resultTexts(part.content))
			spans.push({ route: "deny", text, ...id });
	}
	return spans;
}

/**
 * @param {unknown} c
 * @returns {string[]}
 */
function resultTexts(c) {
	if (typeof c === "string") return [c];
	if (!Array.isArray(c)) return [];
	/** @type {string[]} */
	const texts = [];
	for (const q of c) if (q && typeof q.text === "string") texts.push(q.text);
	return texts;
}

/**
 * @param {TranscriptRecord} record
 * @returns {Span[]}
 */
function fireSpans(record) {
	const spans = [...hookSpans(record), ...denySpans(record)];
	const result = record?.toolUseResult;
	if (result && typeof result === "object" && typeof result.stdout === "string")
		spans.push({ route: "cli", text: result.stdout });
	return spans;
}

/**
 * @param {Span} span
 * @param {Subject} subject
 * @param {{at: string|null, tid: string}} stamp
 * @returns {Fire[]}
 */
function spanFires(span, subject, stamp) {
	if (subject.routes && !subject.routes.includes(span.route)) return [];
	/** @type {Fire[]} */
	const out = [];
	for (const needle of subject.needles) {
		if (needle.routes && !needle.routes.includes(span.route)) continue;
		if (!needleIn(span.text, needle)) continue;
		out.push({
			subject: subject.id,
			needle: needle.id,
			route: span.route,
			at: stamp.at,
			key: `${subject.id} ${needle.id} ${span.route} ${stamp.tid}`,
		});
	}
	return out;
}

/**
 * @param {TranscriptRecord} record
 * @param {Subject[]} subjects
 * @returns {Fire[]}
 */
function recordFires(record, subjects) {
	const spans = fireSpans(record);
	if (spans.length === 0) return [];
	const at = typeof record.timestamp === "string" ? record.timestamp : null;
	const tid = record?.attachment?.toolUseID || record.uuid || "";
	const out = [];
	for (const span of spans)
		for (const subject of subjects)
			out.push(...spanFires(span, subject, { at, tid }));
	return out;
}

/**
 * @param {string} text
 * @param {Subject[]} subjects
 * @param {"main" | "subagent"} tier
 * @returns {Fire[]}
 */
function transcriptFires(text, subjects, tier) {
	const seen = new Set();
	const out = [];
	for (const record of mainChainRecords(text, tier)) {
		for (const fire of recordFires(record, subjects)) {
			if (seen.has(fire.key)) continue;
			seen.add(fire.key);
			out.push(fire);
		}
	}
	return out;
}

/**
 * @param {TranscriptRecord} record
 * @param {Subject[]} subjects
 * @returns {Array<{subject: string, needle: string, at: string|null}>}
 */
function recordMentions(record, subjects) {
	const blob = JSON.stringify(record);
	const fired = new Set(
		recordFires(record, subjects).map((f) => `${f.subject} ${f.needle}`),
	);
	const at = typeof record.timestamp === "string" ? record.timestamp : null;
	const out = [];
	for (const subject of subjects)
		for (const needle of subject.needles) {
			if (!needleIn(blob, needle)) continue;
			if (fired.has(`${subject.id} ${needle.id}`)) continue;
			out.push({ subject: subject.id, needle: needle.id, at });
		}
	return out;
}

/**
 * @param {string} text
 * @param {Subject[]} subjects
 * @param {"main" | "subagent"} tier
 * @returns {Array<{subject: string, needle: string, at: string|null}>}
 */
function transcriptMentions(text, subjects, tier) {
	const out = [];
	for (const record of mainChainRecords(text, tier))
		for (const m of recordMentions(record, subjects)) out.push(m);
	return out;
}

/**
 * @param {TranscriptRecord} record
 * @returns {Generator<string>}
 */
function* outputStrings(record) {
	for (const span of hookSpans(record)) yield span.text;
	const content = record?.message?.content;
	if (Array.isArray(content))
		for (const part of content)
			if (part?.type === "tool_result") yield* resultTexts(part.content);
	if (typeof content === "string" && isHarnessText(record, content))
		yield content;
	if (record?.type === "system") yield* stringsIn(record.content);
}

const PRINTED_OUTPUT = /^<(?:bash-stdout|local-command-stdout)>/;

/**
 * @param {TranscriptRecord} record
 * @param {string} content
 */
function isHarnessText(record, content) {
	if (record?.type !== "user" || record.origin?.kind === "peer") return false;
	return record.isMeta === true || PRINTED_OUTPUT.test(content);
}

/**
 * @param {TranscriptRecord} record
 * @param {string} [tool]
 * @returns {Generator<string>}
 */
function* callStrings(record, tool) {
	const content = record?.message?.content;
	if (record?.type !== "assistant" || !Array.isArray(content)) return;
	for (const part of content)
		if (part?.type === "tool_use" && (tool === undefined || part.name === tool))
			yield* stringsIn(part.input);
}

/**
 * @type {Record<"output" | "call", (record: TranscriptRecord, tool?: string) => Iterable<string>>}
 */
const READERS = {
	output: (record) => outputStrings(record),
	call: callStrings,
};

const READ_KINDS = /** @type {Reads[]} */ (Object.keys(READERS));

/**
 * @typedef {keyof typeof READERS} Reads
 * @typedef {{reads?: Reads, tool?: string}} ReadSpec
 */

/**
 * @param {RegExp} pattern
 */
const stateless = (pattern) =>
	new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, ""));

/**
 * @param {TranscriptRecord} record
 * @param {RegExp} re
 * @param {ReadSpec} spec
 */
function stringsMatch(record, re, { reads = "output", tool } = {}) {
	for (const s of READERS[reads](record, tool)) if (re.test(s)) return true;
	return false;
}

/**
 * @param {TranscriptRecord} record
 * @param {RegExp} pattern
 * @param {ReadSpec} [spec]
 * @returns {boolean}
 */
function recordMatches(record, pattern, spec = {}) {
	return stringsMatch(record, stateless(pattern), spec);
}

/**
 * @param {string} text
 * @param {RegExp} pattern
 * @param {"main" | "subagent"} tier
 * @param {ReadSpec} [spec]
 * @returns {Array<{at: string|null}>}
 */
function transcriptMatches(text, pattern, tier, spec = {}) {
	const re = stateless(pattern);
	const out = [];
	let feedbackHit = false;
	for (const record of mainChainRecords(text, tier)) {
		const hit = stringsMatch(record, re, spec);
		const echo =
			feedbackHit && record?.attachment?.type === "hook_blocking_error";
		feedbackHit = hit && record?.type === "user" && record.isMeta === true;
		if (hit && !echo)
			out.push({
				at: typeof record.timestamp === "string" ? record.timestamp : null,
			});
	}
	return out;
}

/**
 * @param {Array<{subject: string, needle: string, route: string, at: string|null}>} fires
 * @returns {Map<string, {total: number, byRoute: Record<string, number>, byNeedle: Record<string, number>, lastByNeedle: Record<string, string>, last: string|null}>}
 */
function tally(fires) {
	const map = new Map();
	for (const f of fires) {
		let row = map.get(f.subject);
		if (!row) {
			row = {
				total: 0,
				byRoute: {},
				byNeedle: {},
				lastByNeedle: {},
				last: null,
			};
			map.set(f.subject, row);
		}
		row.total += 1;
		row.byRoute[f.route] = (row.byRoute[f.route] || 0) + 1;
		row.byNeedle[f.needle] = (row.byNeedle[f.needle] || 0) + 1;
		if (f.at && (!row.last || f.at > row.last)) row.last = f.at;
		if (
			f.at &&
			(!row.lastByNeedle[f.needle] || f.at > row.lastByNeedle[f.needle])
		)
			row.lastByNeedle[f.needle] = f.at;
	}
	return map;
}

/**
 * @param {Record<string, any>} needles
 * @param {Record<string, any>} settings
 * @returns {{unkeyed: string[], stale: string[]}}
 */
function registryDrift(needles, settings) {
	const keys = guardKeys(settings);
	return {
		unkeyed: keys.filter((k) => !needles.guards?.[k]),
		stale: Object.keys(needles.guards ?? {}).filter((k) => !keys.includes(k)),
	};
}

/**
 * @param {Record<string, any>} core
 * @param {Record<string, any> | null} host
 * @returns {{needles: Record<string, any>, hostKeys: string[], clashes: string[], extra: string[]}}
 */
function mergeNeedles(core, host) {
	const raw = host?.guards ?? {};
	const isObject = typeof raw === "object" && !Array.isArray(raw);
	const hostGuards = isObject ? raw : {};
	const hostKeys = Object.keys(hostGuards);
	return {
		needles: { ...core, guards: { ...core.guards, ...hostGuards } },
		hostKeys,
		clashes: hostKeys.filter((k) => Object.hasOwn(core.guards ?? {}, k)),
		extra: [
			...Object.keys(host ?? {}).filter(
				(k) => k !== "guards" && k !== "_comment",
			),
			...(isObject ? [] : ["a `guards` that is not an object"]),
		],
	};
}

const CORE_NEEDLES = path.join(__dirname, "..", "guard-fire-needles.json");

/**
 * @param {string} root
 */
const hostNeedlesFile = (root) =>
	path.join(root, ".claude", "guard-fire-needles.json");

/**
 * @param {string} root
 * @returns {ReturnType<typeof mergeNeedles>}
 */
function readNeedles(root) {
	const host = readText(hostNeedlesFile(root));
	if (host.state === "unreadable") throw host.error;
	return mergeNeedles(
		JSON.parse(fs.readFileSync(CORE_NEEDLES, "utf8")),
		host.state === "read" ? JSON.parse(host.data) : null,
	);
}

/**
 * @param {Record<string, any>} needles
 * @param {Record<string, any>} settings
 * @returns {Subject[]}
 */
function subjectsFor(needles, settings) {
	const subjects = [];
	for (const key of guardKeys(settings)) {
		const entry = needles.guards?.[key];
		if ((entry?.needles?.length ?? 0) > 0)
			subjects.push({
				id: `guard:${key}`,
				routes: ["hook", "deny"],
				needles: entry.needles,
			});
	}
	for (const [id, cand] of Object.entries(needles.candidates ?? {}))
		if ((cand?.needles?.length ?? 0) > 0)
			subjects.push({ id: `cand:${id}`, needles: cand.needles });
	return subjects;
}

/**
 * @param {string} root
 * @returns {Subject[]}
 */
function readRegisteredGuardSubjects(root) {
	const settings = { hooks: readRunningHooks(root) };
	const needles = JSON.parse(
		fs.readFileSync(
			path.join(coreRoot(), "scripts", "guard-fire-needles.json"),
			"utf8",
		),
	);
	return subjectsFor(needles, settings).filter((s) =>
		s.id.startsWith("guard:"),
	);
}

/**
 * @returns {string[]}
 */
function transcriptDirs() {
	return corpusDirs();
}

/**
 * @param {unknown} e
 * @returns {boolean}
 */
function isMissingDir(e) {
	return (
		!!e &&
		typeof e === "object" &&
		"code" in e &&
		(e.code === "ENOENT" || e.code === "ENOTDIR")
	);
}

/**
 * @param {string} subDir
 * @returns {TranscriptFile[]}
 */
function readSubagentFiles(subDir) {
	let subFiles;
	try {
		subFiles = fs.readdirSync(subDir);
	} catch (e) {
		if (isMissingDir(e)) return [];
		return [{ file: subDir, tier: "subagent" }];
	}
	/** @type {TranscriptFile[]} */
	const out = [];
	for (const f of subFiles)
		if (f.endsWith(".jsonl"))
			out.push({ file: path.join(subDir, f), tier: "subagent" });
	return out;
}

/**
 * @param {string} dir
 * @returns {TranscriptFile[] | null}
 */
function readTranscriptFiles(dir) {
	let entries;
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return null;
	}
	/** @type {TranscriptFile[]} */
	const out = [];
	for (const entry of entries) {
		if (entry.isFile() && entry.name.endsWith(".jsonl")) {
			const file = path.join(dir, entry.name);
			out.push({
				file,
				tier: isSubagentTranscript(file) ? "subagent" : "main",
			});
		}
		if (entry.isDirectory())
			out.push(...readSubagentFiles(path.join(dir, entry.name, "subagents")));
	}
	return out;
}

/**
 * @param {string[]} dirs
 * @returns {{ files: TranscriptFile[], unreadable: string[] }}
 */
function readTranscriptCorpus(dirs) {
	/** @type {TranscriptFile[]} */
	const files = [];
	/** @type {string[]} */
	const unreadable = [];
	for (const dir of dirs) {
		const found = readTranscriptFiles(dir);
		if (found === null) unreadable.push(dir);
		else files.push(...found);
	}
	return { files, unreadable };
}

/**
 * @param {string} file
 * @param {"main" | "subagent"} tier
 * @returns {string}
 */
function sessionKeyFor(file, tier) {
	return tier === "subagent" ? path.dirname(path.dirname(file)) : file;
}

module.exports = {
	guardKey,
	guardKeys,
	keyOrigins,
	CORE_NEEDLES,
	hostNeedlesFile,
	readNeedles,
	registeredGuards,
	registryDrift,
	subjectsFor,
	readRegisteredGuardSubjects,
	needleIn,
	fireSpans,
	transcriptFires,
	transcriptMentions,
	recordFires,
	READ_KINDS,
	recordMatches,
	transcriptMatches,
	tally,
	transcriptDirs,
	readTranscriptCorpus,
	readSubagentFiles,
	readTranscriptFiles,
	sessionKeyFor,
};
