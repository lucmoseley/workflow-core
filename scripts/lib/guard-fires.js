/*
 * guard-fires.js — did a hook actually FIRE, read off a session transcript.
 *
 * Built at mantahostels#1246, the retrieval half of `docs/doc-map.md` §Capture and placement
 * route (e): a prose span may leave the always-loaded pool where a guard
 * reprints that text verbatim when it fires.
 *
 * THE WHOLE PROBLEM IS TELLING A FIRE FROM A MENTION. A guard's filename, and
 * its deny prose too, land in transcripts overwhelmingly as neither: a `cat` of
 * the guard, a diff of it, a vitest verdict quoting its expected string, a
 * CLAUDE.md line about it (mantahostels#1159 measured the ratio). So a hit counts only where
 * it sits in a location the harness itself writes when a hook speaks:
 *
 *   ROUTE `hook` — a `hook_*` ATTACHMENT record. Claude Code writes one per hook
 *     that produced output, carrying `stdout` (hook_success), `content`
 *     (hook_additional_context / hook_system_message) or `blockingError`
 *     (a Stop block). hook_success also carries the `command` from
 *     settings.json; the other three types carry no command at all, which is
 *     why a needle attributes here too.
 *
 *   ROUTE `deny` — a `tool_result` flagged `is_error`. A PreToolUse DENY writes
 *     NO attachment record (mantahostels#1246): the reason reaches the session
 *     only as the denied call's own error result.
 *
 *   ROUTE `cli` — a Bash result's `stdout`. MENTION-CONTAMINATED, and reported
 *     only as an upper bound: `cat scripts/session-arbiter.js` lands the source
 *     text in exactly this field. Claude Code merges stderr into stdout for
 *     Bash, so a diagnostic cannot be separated from a file dump by stream. It
 *     exists for the shed candidates resting on text a SCRIPT prints from a
 *     prompt rather than on anything a hook prints.
 *
 * A NEEDLE IS THE GUARD'S OWN WORDS, never its filename. An array of strings is
 * an AND: every one must appear, used where a single clause is shared (the claim
 * guard's deny and session-arbiter's CLI refusal both say "is held by session").
 *
 * SUBAGENT TRANSCRIPTS ARE RETAINED ON THIS MACHINE FROM 31 JULY 2026 ON, so
 * an earlier window holds none (mantahostels#1725, mantahostels#1779). A
 * subagent's own file lives under its parent session's `subagents/` directory
 * (`transcriptFiles`, below, walks both tiers), and every record in it carries
 * `isSidechain: true` relative to the parent — `lib/transcript.js`'s
 * `mainChainRecords` needs to be told which tier a file is so it does not read
 * that as "empty".
 */

const fs = require("node:fs");
const path = require("node:path");
const { mainChainRecords, isSubagentTranscript } = require("./transcript");
/* Not re-exported: `project-slug.js` owns the rule (mantahostels#2009). */
const { projectSlug } = require("./project-slug.js");
const { configDir } = require("./config-dir.js");
const { coreRoot } = require("./script-path.js");
const { runningHooks } = require("./core-hooks.js");

/** Attachment types the harness writes when a hook produces output. */
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
 *   routes?: string[],
 *   text: string|string[], unless?: string[]}} Needle One entry of
 *   guard-fire-needles.json; a shed candidate's carries no `kind`.
 * @typedef {{id: string, routes?: string[], needles: Needle[]}} Subject
 * @typedef {{subject: string, needle: string, route: string,
 *   at: string|null, key: string}} Fire
 * @typedef {{file: string, tier: "main" | "subagent"}} TranscriptFile
 * @typedef {Record<string, any>} LogRecord One parsed transcript line. `any`
 *   because JSON.parse types nothing and each field is guarded where it is read.
 */

/**
 * An entry's `args` as key/path tokens.
 *
 * A SCALAR IS NOT DROPPED. `"args": "stop"` is malformed against the vendor
 * schema, but reading it as nothing reproduces the exact fault mantahostels#2106 fixed —
 * an argument that distinguishes two registrations, silently unseen.
 *
 * @param {unknown} args
 * @returns {string[]}
 */
function argWords(args) {
	if (typeof args === "string") return args ? [args] : [];
	return Array.isArray(args) ? args.map(String) : [];
}

/**
 * A settings.json hook entry reduced to a stable key: the script's basename
 * plus whatever arguments distinguish one registration from another, read out
 * of `command` and `args` alike.
 *
 * `concision-backstop.sh` is registered twice, on Stop and on SessionStart, and
 * the two print different things — so the argument is part of the key. The
 * wrappers settings.json puts around a node hook (`command -v node ... &&`,
 * `cd "$CLAUDE_PROJECT_DIR" &&`, `|| true`) carry no such information and are
 * dropped.
 *
 * THE ARGUMENT MAY LIVE IN `args` RATHER THAN IN `command`. The exec form
 * (mantahostels#2059) moves it there, so a key read off `command` alone collapses two
 * registrations of one script onto one and merges their tallies (mantahostels#2106).
 *
 * @param {string} command
 * @param {string[] | string} [args] the entry's `args`, where it is in exec form
 * @returns {string} the key, or "" where no script path can be found
 */
function guardKey(command, args) {
	const words = [...String(command || "").split(/\s+/), ...argWords(args)];
	const at = words.findIndex((w) =>
		/scripts\/[\w.-]+$/.test(w.replace(/"/g, "")),
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
 * Every hook registration in a parsed settings object, keyed by `guardKey`.
 *
 * The event key is read from the file rather than from a closed list, matching
 * `lib/hook-wiring.ts` `allRegistrations`.
 *
 * `if` is carried because it holds exactly one permission rule, so a guard
 * narrowed to several is registered several times over and the event alone
 * cannot tell those registrations apart (mantahostels#2825).
 *
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
 * Which of the sources registers each key, so a warning about a key can name
 * the file to fix.
 *
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
 * Every distinct `guardKey` a settings-shaped object registers, in file order.
 * @param {Record<string, any>} settings
 * @returns {string[]}
 */
function guardKeys(settings) {
	return [...new Set(registeredGuards(settings).map((r) => r.key))];
}

/**
 * Does `text` carry this needle? A string is a substring test; an array is an
 * AND across all of its members.
 * @param {string} text
 * @param {string | string[]} needle
 * @returns {boolean}
 */
function hasNeedle(text, needle) {
	const parts = Array.isArray(needle) ? needle : [needle];
	return parts.every((p) => text.includes(p));
}

/**
 * Does `text` carry this needle's `text` and none of its `unless` literals?
 * An `unless` literal is one only ANOTHER guard prints beside the same words,
 * as guard-branch-publish.sh's force-push deny reprints guard-pull-form.sh's
 * rewind fragment: without it one deny counts under both guards.
 * Residual: a span carrying an `unless` literal for any other reason — a
 * compound command both guards deny, or the command echoed back — loses a
 * real fire, and nothing reports it.
 * @param {string} text
 * @param {Pick<Needle, "text" | "unless">} needle
 * @returns {boolean}
 */
function needleIn(text, needle) {
	if (!hasNeedle(text, needle.text)) return false;
	return !(needle.unless ?? []).some((u) => text.includes(u));
}

/**
 * Every non-empty string in a value one level deep — the value itself, an
 * array's members, or an object's own values.
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
 * The `hook` route: each string a hook attachment record carries.
 * @param {LogRecord} record
 * @returns {Span[]}
 */
function hookSpans(record) {
	const a = record?.attachment;
	if (!a || !HOOK_ATTACHMENTS.has(a.type)) return [];
	/** @type {Span[]} */
	const spans = [];
	for (const field of ["stdout", "content", "blockingError"]) {
		// `content` is a string on hook_system_message and an ARRAY on
		// hook_additional_context; `blockingError` is an OBJECT wrapping its own
		// `blockingError` string plus the command that emitted it.
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
 * The `deny` route: the text of each `tool_result` flagged `is_error`.
 * @param {LogRecord} record
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
 * @param {unknown} c  a `tool_result` block's `content`
 * @returns {string[]}  the string itself, or each text part's text
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
 * The spans of one transcript record that a hook's own words can legitimately
 * occupy, each tagged with its route.
 *
 * Anything else in the record — assistant prose, a Read result, a file the
 * session wrote — is a mention and is not returned at all.
 *
 * `toolUseID`, where a span carries one, is the harness's own id for the call
 * the span is about — the attachment's `toolUseID` on a hook span, the
 * `tool_result` block's own `tool_use_id` on a deny one. It is set only where
 * the record actually names it, so a caller must fall back rather than assume
 * every span has one; the `cli` route never does. It exists so a record
 * carrying several parallel `tool_result` blocks can attribute each matched
 * span to the ONE call it came from instead of to all of them (mantahostels#3311, tightening
 * `lost-deny-rates.js` `callIds`'s bounded over-count).
 *
 * @param {LogRecord} record
 * @returns {Span[]}
 */
function fireSpans(record) {
	const spans = [...hookSpans(record), ...denySpans(record)];

	// Bash stdout, the mention-contaminated route.
	const result = record?.toolUseResult;
	if (result && typeof result === "object" && typeof result.stdout === "string")
		spans.push({ route: "cli", text: result.stdout });

	return spans;
}

/**
 * @param {Span} span
 * @param {Subject} subject
 * @param {{at: string|null, tid: string}} stamp  the record's time, and the
 *   id its fires dedupe on
 * @returns {Fire[]}
 */
function spanFires(span, subject, stamp) {
	// A subject may refuse a route; every guard refuses `cli`.
	if (subject.routes && !subject.routes.includes(span.route)) return [];
	/** @type {Fire[]} */
	const out = [];
	for (const needle of subject.needles) {
		// A needle may narrow the subject's routes further (mantahostels#2118).
		// guard-branch.sh and guard-pull-form.sh each reprint their whole
		// rule fragment INSIDE the deny as well as injecting it
		// pre-emptively, so a needle on the fragment's own words matches
		// both limbs: without this the deny counts twice, once as itself
		// and once as an injection that never happened. It separates them
		// only while a deny writes no attachment record (this file's head).
		if (needle.routes && !needle.routes.includes(span.route)) continue;
		if (!needleIn(span.text, needle)) continue;
		out.push({
			subject: subject.id,
			needle: needle.id,
			route: span.route,
			at: stamp.at,
			// One hook call, however many records it wrote.
			key: `${subject.id} ${needle.id} ${span.route} ${stamp.tid}`,
		});
	}
	return out;
}

/**
 * One record's fires, against a list of subjects.
 *
 * A subject is a guard or a shed candidate, shaped as `Subject`. Each fire
 * carries a dedupe key, because one warn writes BOTH a `hook_success` (the raw
 * stdout) and a `hook_additional_context` (the message the model sees),
 * sharing a `toolUseID`.
 *
 * @param {LogRecord} record
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
 * Every fire in one transcript's text, deduped.
 *
 * The parsing is `lib/transcript.js` `mainChainRecords`, which already skips a
 * half-written final line, and — on a `"main"` tier — drops a subagent's turn
 * embedded inline. `tier` is the file's own tier, as `transcriptFiles` tags
 * it: a subagent's own file passes `"subagent"` so its records are read
 * rather than filtered away as if they were somebody else's sidechain.
 *
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
 * The needle hits in one record that are NOT fires — a `cat` of the guard, a
 * diff, a vitest verdict, a CLAUDE.md line quoting it.
 *
 * The whole record is searched, serialised — deliberately the widest possible
 * reading of "the text is present". A needle's own `routes` is ignored here, and
 * the subject's too: a mention has no route by construction.
 *
 * @param {Record<string, any>} record
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
 * Every mention in one transcript's text, one per record. Same parsing as
 * `transcriptFires`, and deliberately NOT deduped by tool call: a mention has
 * no hook call to dedupe against.
 *
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
 * Roll fires up per subject: how many, by which route and needle, and when last.
 *
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
		// Per NEEDLE as well as per subject: one guard prints several rules, and
		// doc-map.md §Capture and placement §5's ripeness test asks when a RULE
		// last fired, which a subject-wide `last` cannot answer (mantahostels#2118).
		if (
			f.at &&
			(!row.lastByNeedle[f.needle] || f.at > row.lastByNeedle[f.needle])
		)
			row.lastByNeedle[f.needle] = f.at;
	}
	return map;
}

/**
 * The needle registry's drift against the registered hooks, both ways.
 *
 * `unkeyed` is the one that matters: a hook wired without an entry is scanned
 * for nothing, comes back zero, and under route (e) a zero is the licence to
 * shed its prose. `stale` is an entry for a hook nothing runs.
 *
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
 * The core's needles with a host's own `guards` folded in, so an adopter can
 * key a guard it registers in its own settings (workflow-core#1267). Two things come back
 * for the caller to refuse rather than resolve: a key in both files (the core
 * owns its own guards' words) and anything in the host file but a `guards`
 * object, which this merge would otherwise drop unread — a host has no shed
 * candidates of its own.
 *
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

/**
 * The subjects to scan for: every registration the registry gives words to,
 * plus every shed candidate that has any.
 *
 * @param {Record<string, any>} needles
 * @param {Record<string, any>} settings
 * @returns {Subject[]}
 */
function subjectsFor(needles, settings) {
	const subjects = [];
	for (const key of guardKeys(settings)) {
		const entry = needles.guards?.[key];
		// A key with no entry is registryDrift's to report.
		if ((entry?.needles?.length ?? 0) > 0)
			subjects.push({
				id: `guard:${key}`,
				// Never `cli`: a hook speaks through the harness's own records, so a
				// `cli` hit on a guard needle is a `cat` of the guard.
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
 * The guards `root` registers (lib/core-hooks.js's `runningHooks`), each with
 * its needles; no shed candidate.
 * @param {string} root
 * @returns {Subject[]}
 */
function registeredGuardSubjects(root) {
	const settings = { hooks: runningHooks(root) };
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
 * Where this project's retained transcripts live.
 *
 * The root is lib/config-dir.js's `configDir()`; the project directory is
 * `projectSlug`, whose own module owns the spelling.
 *
 * `transcript.js` `findTranscript` refuses to reproduce the slugging and
 * looks a session up by id instead; there is no session id here, the subject
 * being a whole corpus. The escape is `--dir`, and a wrong directory reports as
 * unreadable, never as an empty corpus.
 *
 * @param {string} [cwd]
 * @returns {string}
 */
function transcriptDir(cwd = process.cwd()) {
	return path.join(configDir(), "projects", projectSlug(cwd));
}

/**
 * @param {unknown} e  what a directory read threw
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
 * The subagent transcripts under one session's directory, or that
 * `subagents/` directory itself where it will not read (`transcriptFiles`
 * says why).
 * @param {string} sessionDir
 * @returns {TranscriptFile[]}
 */
function subagentFiles(sessionDir) {
	const subDir = path.join(sessionDir, "subagents");
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
 * Every `.jsonl` under `dir`, both tiers: a main session's own top-level file,
 * plus every subagent it dispatched, one file per agent under
 * `<sessionId>/subagents/`. `null` where `dir` itself cannot be read — which a
 * caller must say out loud rather than render as zero fires everywhere.
 *
 * A session with no `subagents/` directory is the ordinary case (ENOENT/
 * ENOTDIR) and is skipped silently. Any OTHER failure reading one — a
 * permissions error, most likely — pushes the directory itself into `out` as
 * if it were a file: every caller here already reads each entry with
 * `fs.readFileSync` and reports what throws as unreadable, so this reuses that
 * path rather than adding a second one only some callers would check.
 *
 * @param {string} dir
 * @returns {TranscriptFile[] | null}
 */
function transcriptFiles(dir) {
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
			out.push(...subagentFiles(path.join(dir, entry.name)));
	}
	return out;
}

/**
 * The unit a "sessions" count should dedupe on: one main session's own file
 * is already unique per session, but a subagent's file is one of possibly
 * several dispatched by the SAME session, sharing that session's `sessionId`
 * in every record — so counting subagent files as sessions inflates a bar
 * calibrated on independent sessions (mantahostels#1779). This groups every subagent file
 * under its parent session's directory instead.
 *
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
	mergeNeedles,
	registeredGuards,
	registryDrift,
	subjectsFor,
	registeredGuardSubjects,
	needleIn,
	fireSpans,
	transcriptFires,
	transcriptMentions,
	tally,
	transcriptDir,
	transcriptFiles,
	sessionKeyFor,
};
