#!/usr/bin/env node
const crypto = require("node:crypto");
const { writeFd } = require("./lib/write-fd.js");
const fs = require("node:fs");
const path = require("node:path");
const { runCheck, errMessage, baselineOf } = require("./lib/check");
const { readText: readFile } = require("./lib/file-read.js");
const { escapeRe, requiredGroup } = require("./lib/regex-group");
const { JS_COMMENT, LINE_START, headerOf } = require("./lib/script-header.js");
const { isTestKind } = require("./lib/test-kind");
const { pythonRouteDrift } = require("./lib/python-routes.js");
const { CONFIG_PATH, readConfig } = require("./lib/workflow-core-config.js");
const { parseNewSide } = require("./lib/hunk-header.js");
const {
	BASE_LINE_PIN_REMEDY,
	LINE_PIN_RE,
	baseLinePinFault,
	parseLinePins,
} = require("./lib/standards-pins");
const { execGit } = require("./lib/git.js");
const { scriptPath } = require("./lib/script-path.js");
const {
	MANIFEST_REL,
	manifestAt,
	readDispatchedCores,
} = require("./lib/guard-cores.js");
/** @typedef {import("./lib/standards-pins").LinePin} LinePin */

// #5172
const root = () => process.cwd();
const DOC = "docs/code-standards.md";
const ANCHORS = "scripts/code-standards-anchors.json";
const BASE_DOC = "docs/code-standards-base.md";
const BASE_ANCHORS = "scripts/code-standards-base-anchors.json";
/** @param {string} doc */
const anchorsOf = (doc) => (doc === BASE_DOC ? BASE_ANCHORS : ANCHORS);
/**
 * @param {string} doc
 * @param {string} [key]
 */
const reviewCommand = (doc, key) =>
	[
		`node ${scriptPath("check-code-standards.js")} --review`,
		doc === DOC ? "" : doc,
		key,
	]
		.filter(Boolean)
		.join(" ");

/** @param {string} s */
const foldQuotes = (s) => s.replace(/[\u2018\u2019\u201c\u201d'"]/g, '"');

/** @param {string} line */
const normalise = (line) =>
	foldQuotes(line)
		.replace(/^\s*(?:\/\*+|\*+\/?|\/\/+|#+)\s?/, "")
		.replace(/\s+/g, " ")
		.trim();

/**
 * @param {string[]} lines
 * @param {number} from
 * @param {number} to
 */
function haystack(lines, from, to) {
	let text = "";
	/** @type {{at: number, line: number}[]} */
	const marks = [];
	const start = Math.max(1, from);
	for (const [k, line] of lines.slice(start - 1, to).entries()) {
		const n = start + k;
		const piece = normalise(line);
		if (!piece) continue;
		if (text) text += " ";
		marks.push({ at: text.length, line: n });
		text += piece;
	}
	return { text, marks };
}

/**
 * @param {{at: number, line: number}[]} marks
 * @param {number} offset
 */
function lineAt(marks, offset) {
	const [first] = marks;
	let line = first === undefined ? 0 : first.line;
	for (const m of marks) if (m.at <= offset) line = m.line;
	return line;
}

/**
 * @param {string} quote
 * @returns {string[]}
 */
function fragmentsOf(quote) {
	const parts = foldQuotes(quote)
		.split(/…|\.\.\./)
		.map((p) => p.replace(/\s+/g, " ").trim())
		.filter(Boolean);
	const last = parts.pop();
	if (last !== undefined) parts.push(last.replace(/\.$/, ""));
	return parts.filter(Boolean);
}

/**
 * @param {string} text
 * @param {string[]} parts
 * @returns {number}
 */
function findFragments(text, parts) {
	const [head, ...rest] = parts;
	if (head === undefined) return -1;
	const first = text.indexOf(head);
	if (first === -1) return -1;
	let at = first + head.length;
	for (const part of rest) {
		const next = text.indexOf(part, at);
		if (next === -1) return -1;
		at = next + part.length;
	}
	return first;
}

/**
 * @param {string} text
 * @param {string[]} parts
 * @returns {{words: number, at: number, prefix: string} | null}
 */
function longestPrefix(text, parts) {
	const first = parts[0];
	if (first === undefined) return null;
	const words = first.split(" ");
	let best = null;
	for (let n = 1; n <= words.length; n++) {
		const probe = words.slice(0, n).join(" ");
		const at = text.indexOf(probe);
		if (at === -1) break;
		best = { words: n, at, prefix: probe };
	}
	return best;
}

/**
 * @param {string[]} lines
 * @param {number} from
 * @param {number} to
 */
function hunkDigest(lines, from, to) {
	const slice = lines.slice(from - 1, to).join("\n");
	return crypto.createHash("sha256").update(slice).digest("hex").slice(0, 16);
}

/**
 * @param {string} rel
 * @param {number} from
 * @param {number} to
 */
const keyOf = (rel, from, to) =>
	from === to ? `${rel}:${from}` : `${rel}:${from}-${to}`;

/**
 * @param {string} file
 * @returns {Record<string, string>}
 */
function loadAnchors(file) {
	try {
		const raw = JSON.parse(fs.readFileSync(path.join(root(), file), "utf8"));
		return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
	} catch {
		return {};
	}
}

/**
 * @param {string} file
 * @param {Record<string, string>} anchors
 */
function saveAnchors(file, anchors) {
	const sorted = Object.fromEntries(
		Object.keys(anchors)
			.sort()
			.map((k) => [k, anchors[k]]),
	);
	fs.mkdirSync(path.dirname(path.join(root(), file)), { recursive: true });
	fs.writeFileSync(
		path.join(root(), file),
		`${JSON.stringify(sorted, null, "\t")}\n`,
	);
}

/**
 * @param {string} rev
 * @param {(m: string) => never} broken
 * @returns {Set<string>}
 */
function readChangedFiles(rev, broken) {
	let out = "";
	try {
		out = execGit(["diff", "--name-only", rev], {
			cwd: root(),
			encoding: "utf8",
		});
	} catch (e) {
		broken(`git diff --name-only ${rev} failed: ${errMessage(e)}`);
	}
	return new Set(out.split("\n").filter(Boolean));
}

/**
 * @param {string} rev
 * @param {string} rel
 * @param {(m: string) => never} broken
 * @returns {Set<number>}
 */
function readChangedLines(rev, rel, broken) {
	let out = "";
	try {
		out = execGit(["diff", "-U0", rev, "--", rel], {
			cwd: root(),
			encoding: "utf8",
		});
	} catch (e) {
		broken(`git diff -U0 ${rev} -- ${rel} failed: ${errMessage(e)}`);
	}
	/** @type {Set<number>} */
	const lines = new Set();
	for (const line of out.split("\n")) {
		const hunk = parseNewSide(line);
		if (hunk === null) continue;
		for (let n = hunk.start; n < hunk.start + hunk.count; n++) lines.add(n);
	}
	return lines;
}

/** @param {(m: string) => never} broken */
function readTrackedFiles(broken) {
	let out = "";
	try {
		out = execGit(["ls-files"], {
			cwd: root(),
			encoding: "utf8",
		});
	} catch (e) {
		broken(
			`git ls-files failed, so the tracked set cannot be read: ${errMessage(e)}`,
		);
	}
	const paths = out.split("\n").filter(Boolean);
	/** @type {Map<string, string[]>} */
	const byBase = new Map();
	for (const p of paths) {
		const base = p.slice(p.lastIndexOf("/") + 1);
		byBase.set(base, [...(byBase.get(base) ?? []), p]);
	}
	return { set: new Set(paths), byBase };
}

/**
 * @param {string} rawPath
 * @param {{set: Set<string>, byBase: Map<string, string[]>}} tracked
 * @returns {{rel: string} | {fault: string, detail: string}}
 */
function resolveCited(rawPath, tracked) {
	if (!rawPath)
		return {
			fault: "UNRESOLVED",
			detail: "a bare pin with no path named earlier on its line",
		};
	if (rawPath.includes("/")) {
		if (tracked.set.has(rawPath)) return { rel: rawPath };
		return {
			fault: "MISSING-PATH",
			detail: `${rawPath} is not a tracked file`,
		};
	}
	const hits = tracked.byBase.get(rawPath) ?? [];
	const [only, ...others] = hits;
	if (only !== undefined && others.length === 0) return { rel: only };
	if (hits.length === 0)
		return {
			fault: "MISSING-PATH",
			detail: `no tracked file is named ${rawPath}`,
		};
	return {
		fault: "AMBIGUOUS-PATH",
		detail: `${hits.length} tracked files are named ${rawPath} (${hits.join(", ")}) — cite the full path`,
	};
}

/** @param {string} rel */
function readLines(rel) {
	try {
		return fs.readFileSync(path.join(root(), rel), "utf8").split("\n");
	} catch {
		return null;
	}
}

/** @param {string} rel */
function readText(rel) {
	try {
		return fs.readFileSync(path.join(root(), rel), "utf8");
	} catch {
		return null;
	}
}

const EXPORT_SCOPE =
	/^(?:scripts\/|\.claude\/skills\/[^/]+\/scripts\/)[\w./-]+\.js$/;
const EXPORT_BLOCK = /\nmodule\.exports = \{([\s\S]*?)\};/g;
const EXPORTS_RUN_MEMBER = /^(?:exports\.|[ \t]*(?:\/\/|\/\*|\*))/;
const EXPORTS_RUN_LINE = /^exports\.([A-Za-z_$][\w$]*) = ([\w$.]+);$/;
const EXPORT_ENTRY = /^\s*([A-Za-z_$][\w$]*)\s*(?::\s*[\w.$]+\s*)?,?$/;
const COMMENT_LINE = /^\s*(?:\/\/|\*|\/\*)/;
const TOKEN_RE = /[A-Za-z_$][\w$]*/g;
const DEFINITION_RE =
	/^(?:const|let|var|function|class|async function)\s+([A-Za-z_$][\w$]*)/gm;
const MEMBER_RE = /\.\s*([A-Za-z_$][\w$]*)/g;
const PATH_TAIL_RE = /(?:([/"'`])|(?<![\w-]))([\w-]+(?:\.[\w-]+)*)(?![\w/-])/g;
const SCRIPT_EXT = /\.[cm]?[jt]sx?$/;
const UNBUILT_CALLER = new RegExp(
	String.raw`${LINE_START}${JS_COMMENT}\s*Unbuilt caller:.*#\d+`,
	"im",
);
const RUN_IN_PROCESS = "scripts/lib/run-in-process.js";
const REQUIRE_MAIN = /\brequire\.main\b/g;
const EXPORT_CALLERS = "docs/export-callers.json";
const GATE_TABLE = "scripts/lib/precommit-gates.js";
const GATE_SCRIPT_RE = /\bscript:\s*"([^"]+)"/g;
const GATE_EXPORTS = new Set(["SPEC", "PROGRAM"]);
const BINARY_EXT =
	/\.(?:png|jpe?g|gif|webp|avif|ico|pdf|woff2?|ttf|zip|gz|xlsx?|docx?|ods)$/i;

/**
 * @typedef {object} ExportBlock
 * @property {string} rel
 * @property {{name: string, exempt: boolean}[]} entries
 * @property {number} unparsed
 */

/** @typedef {{module: string, name: string, caller: string}} CallerRow */

/**
 * @param {{set: Set<string>}} tracked
 * @returns {ExportBlock[]}
 */
function readExportBlocks(tracked) {
	/** @type {ExportBlock[]} */
	const out = [];
	for (const rel of [...tracked.set].sort()) {
		if (!EXPORT_SCOPE.test(rel) || isTestKind(rel)) continue;
		const text = readText(rel);
		if (text === null) continue;
		const block = exportBlockOf(rel, text);
		if (block) out.push(block);
	}
	return out;
}

/**
 * @param {string} rel
 * @param {string} text
 * @returns {ExportBlock | null}
 */
function exportBlockOf(rel, text) {
	const hasUnbuiltCaller = UNBUILT_CALLER.test(headerOf(rel, text));
	const isEntryPoint = text.includes("require.main");
	const block = moduleExportsBlock(text) ?? exportsRun(text);
	if (!block) return null;
	const { named, unparsed } = blockEntries(block.entries, {
		blockExempt: hasUnbuiltCaller,
		isEntryPoint,
	});
	return { rel, entries: named, unparsed };
}

/**
 * @param {string} text
 * @returns {{entries: string[]} | null}
 */
function moduleExportsBlock(text) {
	let block = null;
	const exportBlock = new RegExp(EXPORT_BLOCK);
	for (let m = exportBlock.exec(text); m; m = exportBlock.exec(text)) block = m;
	if (!block) return null;
	const inner = requiredGroup(block, 1, EXPORT_BLOCK);
	const entries = inner.includes("\n")
		? inner.split("\n")
		: inner.split(",").map((s) => s.trim());
	return { entries };
}

/**
 * @param {string} text
 * @returns {{entries: string[]} | null}
 */
function exportsRun(text) {
	const lines = text.split("\n");
	let last = lines.length - 1;
	while (last > 0 && !/\S/.test(lines[last] ?? "")) last--;
	if (last < 1 || !lines[last]?.startsWith("exports.")) return null;
	let first = last;
	while (first > 1 && EXPORTS_RUN_MEMBER.test(lines[first - 1] ?? "")) first--;
	const entries = lines
		.slice(first, last + 1)
		.map((line) =>
			line.replace(EXPORTS_RUN_LINE, (_, name, value) =>
				name === value ? `${name},` : `${name}: ${value},`,
			),
		);
	return { entries };
}

/**
 * @param {string[]} entries
 * @param {{blockExempt: boolean, isEntryPoint: boolean}} block
 */
function blockEntries(entries, { blockExempt, isEntryPoint }) {
	/** @type {{name: string, exempt: boolean}[]} */
	const named = [];
	let unparsed = 0;
	for (const entry of entries) {
		if (!entry.trim()) continue;
		const hit = EXPORT_ENTRY.exec(entry);
		if (!hit) {
			if (!COMMENT_LINE.test(entry)) unparsed += 1;
			continue;
		}
		const name = requiredGroup(hit, 1, EXPORT_ENTRY);
		named.push({
			name,
			exempt: blockExempt || (isEntryPoint && name === "main"),
		});
	}
	return { named, unparsed };
}

/**
 * @param {Set<string>} paths
 * @param {ExportBlock[]} blocks
 * @returns {Map<string, Map<string, Set<string>>>}
 */
function consumersOf(paths, blocks) {
	/** @type {Map<string, Map<string, Set<string>>>} */
	const consumers = new Map();
	const loaded = {
		dispatched: dispatchedModules(),
		gated: readGatedModules(),
	};
	for (const { rel, entries } of blocks)
		for (const { name } of entries) {
			const byExporter = consumers.get(name) ?? new Map();
			byExporter.set(rel, new Set());
			consumers.set(name, byExporter);
		}
	for (const rel of paths) {
		if (BINARY_EXT.test(rel) || rel === EXPORT_CALLERS) continue;
		const text = readText(rel)?.replace(REQUIRE_MAIN, "require");
		if (text === undefined) continue;
		addConsumer(consumers, rel, text, loaded);
	}
	return consumers;
}

/** @typedef {{dispatched: string[], gated: string[]}} Loaded */

/** @returns {string[]} */
function readGatedModules() {
	const table = readText(GATE_TABLE);
	if (table === null) return [];
	return [...firstGroups(GATE_SCRIPT_RE, table)].map((rel) =>
		path.basename(rel).replace(SCRIPT_EXT, ""),
	);
}

/** @returns {string[]} */
function dispatchedModules() {
	const own = path.join(root(), MANIFEST_REL);
	if (manifestAt(root()) !== own) return [];
	return readDispatchedCores(own).map((rel) =>
		path.basename(rel).replace(SCRIPT_EXT, ""),
	);
}

/**
 * @param {Map<string, Map<string, Set<string>>>} consumers
 * @param {string} rel
 * @param {string} text
 * @param {Loaded} loaded
 */
function addConsumer(consumers, rel, text, loaded) {
	const defined = firstGroups(DEFINITION_RE, text);
	const read = firstGroups(MEMBER_RE, text);
	const reachOf = reachFor(text, loaded);
	for (const token of new Set(text.match(TOKEN_RE) ?? [])) {
		if (defined.has(token) && !read.has(token)) continue;
		if (token === "main" && rel === RUN_IN_PROCESS) continue;
		const reach = reachOf(token);
		for (const [exporter, takers] of consumers.get(token) ?? [])
			if (reach.has(path.basename(exporter).replace(SCRIPT_EXT, "")))
				takers.add(rel);
	}
}

/**
 * @param {string} text
 * @param {Loaded} loaded
 * @returns {(token: string) => Set<string>}
 */
function reachFor(text, loaded) {
	const reached = modulesNamed(text);
	withDispatched(reached, text, loaded.dispatched);
	const gateReach = withGates(reached, text, loaded.gated);
	return (token) => (GATE_EXPORTS.has(token) ? gateReach : reached);
}

/**
 * @param {Set<string>} reached
 * @param {string} text
 * @param {string[]} gated
 * @returns {Set<string>}
 */
function withGates(reached, text, gated) {
	if (!reached.has("precommit-gates") || !text.includes("fromCoreRoot("))
		return reached;
	return new Set([...reached, ...gated]);
}

/**
 * @param {Set<string>} reached
 * @param {string} text
 * @param {string[]} dispatched
 */
function withDispatched(reached, text, dispatched) {
	if (reached.has("guard-cores") && text.includes("corePath("))
		for (const m of dispatched) reached.add(m);
}

/**
 * @param {string} text
 * @returns {Set<string>}
 */
function modulesNamed(text) {
	/** @type {Set<string>} */
	const out = new Set();
	const local = new RegExp(PATH_TAIL_RE);
	for (let m = local.exec(text); m; m = local.exec(text)) {
		const tail = requiredGroup(m, 2, PATH_TAIL_RE);
		if (SCRIPT_EXT.test(tail)) out.add(tail.replace(SCRIPT_EXT, ""));
		else if (m[1]) out.add(tail);
	}
	return out;
}

/**
 * @param {RegExp} re
 * @param {string} text
 * @returns {Set<string>}
 */
function firstGroups(re, text) {
	/** @type {Set<string>} */
	const out = new Set();
	const local = new RegExp(re);
	for (let m = local.exec(text); m; m = local.exec(text))
		out.add(requiredGroup(m, 1, re));
	return out;
}

/**
 * @param {Map<string, Map<string, Set<string>>>} consumers
 * @param {string} name
 * @param {string} rel
 */
const takersOf = (consumers, name, rel) =>
	[...(consumers.get(name)?.get(rel) ?? [])].filter((f) => f !== rel);

/**
 * @param {ExportBlock[]} blocks
 * @param {Map<string, Map<string, Set<string>>>} consumers
 * @param {CallerRow[]} rows
 */
function deadExports(blocks, consumers, rows) {
	const kept = new Set(rows.map((r) => `${r.module}\t${r.name}`));
	/** @type {Finding[]} */
	const findings = [];
	let names = 0;
	let unparsed = 0;
	let testOnly = 0;
	for (const { rel, entries, unparsed: skipped } of blocks) {
		unparsed += skipped;
		for (const { name, exempt } of entries) {
			names += 1;
			if (exempt || kept.has(`${rel}\t${name}`)) continue;
			const takers = takersOf(consumers, name, rel);
			const tests = takers.filter((f) => isTestKind(f));
			if (tests.length < takers.length) continue;
			if (tests.length > 0) testOnly += 1;
			findings.push({
				kind: "DEAD-EXPORT",
				docLine: 0,
				where: rel,
				rel,
				pin: name,
				detail: deadDetail(name, rel, tests),
			});
		}
	}
	return { findings, blocks: blocks.length, names, unparsed, testOnly };
}

/**
 * @param {string} name
 * @param {string} rel
 * @param {string[]} tests
 */
function deadDetail(name, rel, tests) {
	return tests.length > 0
		? `only tests consume ${name} — ${tests.join(", ")}. ` +
				"Test through the program or the exports its real callers use and drop the export (§G6); " +
				"a comment is no fix. A module built ahead of its caller names it on an `Unbuilt caller: <caller> (#N)` header line"
		: `no tracked file consumes ${name} — every file spelling it defines one of its own or never reaches ${rel}. ` +
				`Make it file-local (§N7), or, where a real caller reaches it in a form the scan cannot see, keep it with a {module, name, caller} row in ${EXPORT_CALLERS}`;
}

/**
 * @param {(message: string) => never} broken
 * @returns {CallerRow[]}
 */
function readCallerRows(broken) {
	const read = readFile(path.join(root(), EXPORT_CALLERS));
	if (read.state === "absent") return [];
	if (read.state === "unreadable")
		broken(`${EXPORT_CALLERS} will not read: ${read.message}`);
	/** @type {unknown} */
	let rows;
	try {
		rows = JSON.parse(read.data);
	} catch (e) {
		broken(`${EXPORT_CALLERS} is not JSON: ${errMessage(e)}`);
	}
	if (!Array.isArray(rows) || !rows.every(isCallerRow))
		broken(
			`${EXPORT_CALLERS} must be an array of {module, name, caller} rows, each a string`,
		);
	return rows;
}

/**
 * @param {unknown} row
 * @returns {row is CallerRow}
 */
const isCallerRow = (row) =>
	typeof row === "object" &&
	row !== null &&
	["module", "name", "caller"].every(
		(k) =>
			typeof (/** @type {Record<string, unknown>} */ (row)[k]) === "string",
	);

/**
 * @param {CallerRow[]} rows
 * @param {ExportBlock[]} blocks
 * @param {Map<string, Map<string, Set<string>>>} consumers
 * @param {{set: Set<string>}} tracked
 * @returns {Finding[]}
 */
function staleCallerRows(rows, blocks, consumers, tracked) {
	const exported = new Map(
		blocks.map((b) => [b.rel, new Set(b.entries.map((e) => e.name))]),
	);
	/** @type {Finding[]} */
	const findings = [];
	for (const row of rows) {
		const detail = callerRowFault(row, exported, consumers, tracked);
		if (detail)
			findings.push({
				kind: "STALE-CALLER",
				docLine: 0,
				where: EXPORT_CALLERS,
				rel: row.module,
				scopedBy: [row.caller, EXPORT_CALLERS],
				pin: `${row.module} ${row.name} <- ${row.caller}`,
				detail,
			});
	}
	return findings;
}

/**
 * @param {CallerRow} row
 * @param {Map<string, Set<string>>} exported
 * @param {Map<string, Map<string, Set<string>>>} consumers
 * @param {{set: Set<string>}} tracked
 */
function callerRowFault(row, exported, consumers, tracked) {
	const { module, name, caller } = row;
	if (!exported.get(module)?.has(name))
		return `${module} exports no ${name}; drop the row`;
	if (takersOf(consumers, name, module).some((f) => !isTestKind(f)))
		return `the scan finds a consumer of ${name} itself; drop the row`;
	const text =
		tracked.set.has(caller) && !isTestKind(caller) ? readText(caller) : null;
	const stem = path.basename(module).replace(SCRIPT_EXT, "");
	if (
		text === null ||
		!hasWord(text, stem) ||
		!hasToken(text, name) ||
		isOwnDefinition(text, name)
	)
		return `${caller} no longer reads ${name} off ${module} — make the name file-local, or name the caller that does`;
	return null;
}

/**
 * @param {string} text
 * @param {string} token
 */
const hasToken = (text, token) =>
	new Set(text.match(TOKEN_RE) ?? []).has(token);

/**
 * @param {string} text
 * @param {string} word
 */
const hasWord = (text, word) =>
	new RegExp(`(?<![\\w-])${escapeRe(word)}(?![\\w-])`).test(text);

/**
 * @param {string} text
 * @param {string} name
 */
const isOwnDefinition = (text, name) =>
	firstGroups(DEFINITION_RE, text).has(name) &&
	!firstGroups(MEMBER_RE, text).has(name);

/**
 * @typedef {object} Finding
 * @property {string} kind
 * @property {string} [doc]
 * @property {number} docLine
 * @property {string} pin
 * @property {string} detail
 * @property {string} [where]
 * @property {string} [rel]
 * @property {string[]} [scopedBy]
 */

/**
 * @param {string} doc
 * @param {LinePin[]} pins
 * @param {{set: Set<string>, byBase: Map<string, string[]>}} tracked
 * @param {((rel: string) => boolean) | null} shipped
 */
function judge(doc, pins, tracked, shipped) {
	const anchorsFile = anchorsOf(doc);
	const anchors = loadAnchors(anchorsFile);
	/** @type {Judging} */
	const j = {
		doc,
		tracked,
		shipped,
		anchorsFile,
		anchors,
		findings: [],
		filesCited: new Set(),
		liveKeys: new Set(),
		quoted: 0,
		bare: 0,
	};
	for (const pin of pins) judgePin(j, pin);
	const { findings, filesCited, liveKeys } = j;

	for (const key of Object.keys(anchors).sort())
		if (!liveKeys.has(key))
			findings.push({
				kind: "ORPHAN-ANCHOR",
				doc,
				docLine: 0,
				pin: key,
				detail: `anchored in ${anchorsFile} but no bare pin in ${doc} cites it — drop it with: ${reviewCommand(doc)}`,
				rel: LINE_PIN_RE.exec(key)?.[1],
			});

	return { findings, filesCited, quoted: j.quoted, bare: j.bare, liveKeys };
}

/**
 * @typedef {object} Judging
 * @property {string} doc
 * @property {{set: Set<string>, byBase: Map<string, string[]>}} tracked
 * @property {((rel: string) => boolean) | null} shipped
 * @property {string} anchorsFile
 * @property {Record<string, string>} anchors
 * @property {Finding[]} findings
 * @property {Set<string>} filesCited
 * @property {Set<string>} liveKeys
 * @property {number} quoted
 * @property {number} bare
 */

/** @typedef {(kind: string, detail: string) => number} Push */

/**
 * @param {Judging} j
 * @param {LinePin} pin
 */
function judgePin(j, pin) {
	const at = `${j.doc}:${pin.line}`;
	const resolved = resolveCited(pin.rawPath, j.tracked);
	/** @type {string | undefined} */
	const citedRel = "rel" in resolved ? resolved.rel : undefined;
	/** @type {Push} */
	const push = (kind, detail) =>
		j.findings.push({
			kind,
			doc: j.doc,
			docLine: pin.line,
			pin: pin.raw,
			detail,
			rel: citedRel,
		});

	const unshipped = j.shipped && baseLinePinFault(root(), pin, j.shipped);
	if (unshipped)
		push(
			"UNSHIPPED",
			citedRel && citedRel !== pin.rawPath
				? `a base line pin is read at the plugin root, where the bare name ${pin.rawPath} opens nothing — cite ${citedRel} in full; the release refuses it as it stands (#961)`
				: `${unshipped}, so an adopter reading the base finds no evidence — ${BASE_LINE_PIN_REMEDY}; the release refuses it as it stands (#961)`,
		);

	if ("fault" in resolved) {
		push(resolved.fault, resolved.detail);
		return;
	}
	const rel = resolved.rel;
	j.filesCited.add(rel);

	const lines = readLines(rel);
	if (lines === null) {
		push("MISSING-PATH", `${rel} is tracked but cannot be read`);
		return;
	}
	if (pin.from > lines.length || pin.to > lines.length) {
		push(
			"OUT-OF-RANGE",
			`${rel} has ${lines.length} lines, so ${pin.raw} points past its end`,
		);
		return;
	}

	if (pin.quotes.length > 0) {
		j.quoted += pin.quotes.length;
		for (const quote of pin.quotes)
			judgeQuote(j.tracked, { pin, quote, rel, lines, at }, push);
		return;
	}

	j.bare += 1;
	const key = keyOf(rel, pin.from, pin.to);
	j.liveKeys.add(key);
	const now = hunkDigest(lines, pin.from, pin.to);
	const was = j.anchors[key];
	const { doc, anchorsFile } = j;
	if (!was)
		push(
			"UNANCHORED",
			`${key} has no entry in ${anchorsFile}, so nothing records that these lines were ever read against the rule — clear with: ${reviewCommand(doc, key)}`,
		);
	else if (was !== now)
		push(
			"MOVED",
			`the lines ${key} cites have changed since they were last read (anchored ${was}, now ${now}) — re-read them against the rule at ${at}, then: ${reviewCommand(doc, key)}`,
		);
}

/**
 * @param {{set: Set<string>, byBase: Map<string, string[]>}} tracked
 * @param {{pin: LinePin, quote: string, rel: string, lines: string[], at: string}} q
 * @param {Push} push
 */
function judgeQuote(tracked, { pin, quote, rel, lines, at }, push) {
	const parts = fragmentsOf(quote);
	const gist = quote.length > 60 ? `${quote.slice(0, 60)}…` : quote;

	if (isQuotedAtPin(pin, { rel, lines, parts, tracked })) return;

	const whole = haystack(lines, 1, lines.length);
	const elsewhere = findFragments(whole.text, parts);
	if (elsewhere !== -1) {
		push(
			"DRIFTED",
			`the quotation "${gist}" has moved to ${rel}:${lineAt(whole.marks, elsewhere)} — repin ${at}`,
		);
		return;
	}

	const prefix = longestPrefix(whole.text, parts);
	if (prefix && prefix.words >= 5) {
		const after = whole.text.slice(
			prefix.at + prefix.prefix.length,
			prefix.at + prefix.prefix.length + 70,
		);
		push(
			"MISQUOTED",
			`the quotation "${gist}" matches ${rel}:${lineAt(whole.marks, prefix.at)} for ${prefix.words} word(s) and then diverges — the source reads "…${prefix.prefix.slice(-30)}${after}"`,
		);
		return;
	}
	push(
		"ABSENT",
		`the quotation "${gist}" appears nowhere in ${rel} — fabricated, or the line it quoted is gone`,
	);
}

/**
 * @param {LinePin} pin
 * @param {{rel: string, lines: string[], parts: ReturnType<typeof fragmentsOf>, tracked: {set: Set<string>, byBase: Map<string, string[]>}}} q
 * @returns {boolean}
 */
function isQuotedAtPin(pin, { rel, lines, parts, tracked }) {
	for (const sib of pin.siblings) {
		const target = sib === pin ? { rel } : resolveCited(sib.rawPath, tracked);
		if ("fault" in target) continue;
		const sibLines = sib === pin ? lines : readLines(target.rel);
		if (sibLines === null) continue;
		const tail = haystack(sibLines, sib.from, sibLines.length);
		const at = findFragments(tail.text, parts);
		if (at !== -1 && lineAt(tail.marks, at) <= sib.to) return true;
	}
	return false;
}

/**
 * @param {LinePin[]} pins
 * @param {{set: Set<string>, byBase: Map<string, string[]>}} tracked
 */
function liveBarePins(pins, tracked) {
	/** @type {Map<string, {rel: string, from: number, to: number, docLine: number}>} */
	const live = new Map();
	for (const pin of pins) {
		if (pin.quotes.length > 0) continue;
		const resolved = resolveCited(pin.rawPath, tracked);
		if ("fault" in resolved) continue;
		live.set(keyOf(resolved.rel, pin.from, pin.to), {
			rel: resolved.rel,
			from: pin.from,
			to: pin.to,
			docLine: pin.line,
		});
	}
	return live;
}

/**
 * @param {string} target
 * @param {string} key
 * @returns {boolean}
 */
function isTargetOf(target, key) {
	return key === target || key.startsWith(`${target}:`);
}

/**
 * @param {string} doc
 * @param {string[]} targets
 * @param {LinePin[]} pins
 * @param {{set: Set<string>, byBase: Map<string, string[]>}} tracked
 * @returns {never}
 */
function reanchor(doc, targets, pins, tracked) {
	const anchorsFile = anchorsOf(doc);
	const anchors = loadAnchors(anchorsFile);
	const live = liveBarePins(pins, tracked);

	const wanted =
		targets.length > 0
			? [...live.keys()].filter((k) => targets.some((t) => isTargetOf(t, k)))
			: [...live.keys()];

	const unmatched = targets.filter(
		(t) => !wanted.some((k) => isTargetOf(t, k)),
	);

	const next = targets.length > 0 ? { ...anchors } : {};
	for (const key of wanted.sort()) {
		const spot = live.get(key);
		if (!spot) continue;
		const lines = readLines(spot.rel);
		if (lines === null) {
			writeFd(1, `skipped ${key} — cannot read ${spot.rel}\n`);
			continue;
		}
		next[key] = hunkDigest(lines, spot.from, spot.to);
		writeFd(
			1,
			`anchored ${key} @ ${next[key]}  (cited at ${doc}:${spot.docLine})\n`,
		);
	}

	if (targets.length === 0)
		for (const key of Object.keys(anchors).sort())
			if (!(key in next)) writeFd(1, `dropped ${key} — no bare pin cites it\n`);

	saveAnchors(anchorsFile, next);
	for (const t of unmatched)
		writeFd(1, `skipped ${t} — no bare pin matches it\n`);
	writeFd(
		1,
		`\n${Object.keys(next).length} bare pin(s) anchored in ${anchorsFile}. ` +
			"Re-anchoring asserts the cited lines were re-read against the rule citing them.\n",
	);
	process.exit(0);
}

/**
 * @param {string | undefined} arg
 * @returns {boolean}
 */
function isDocumentArg(arg) {
	return arg !== undefined && [DOC, BASE_DOC].includes(arg);
}

/**
 * @param {import("./lib/check").Ctx} ctx
 * @param {boolean} reviewing
 * @param {string | undefined} reviewDoc
 * @returns {string[]}
 */
function docsFor(ctx, reviewing, reviewDoc) {
	const named = reviewing ? (reviewDoc ?? DOC) : ctx.args[0];
	if (named) return [named];
	if (fs.existsSync(path.join(root(), BASE_DOC))) return [DOC, BASE_DOC];
	return [DOC];
}

/** @param {string[]} docs */
function readDocs(docs) {
	/** @type {{doc: string, text: string, pins: LinePin[]}[]} */
	const read = [];
	/** @type {string[]} */
	const unread = [];
	for (const doc of docs) {
		try {
			const text = fs.readFileSync(path.join(root(), doc), "utf8");
			read.push({ doc, text, pins: parseLinePins(text) });
		} catch (e) {
			unread.push(`${doc} could not be read: ${errMessage(e)}`);
		}
	}
	return { read, unread };
}

/**
 * @param {import("./lib/check").Ctx} ctx
 * @returns {((rel: string) => boolean) | null}
 */
function loadShipped(ctx) {
	try {
		// #963
		const { isShipped } = require("./lib/plugin-tree");
		return (/** @type {string} */ rel) => isShipped(root(), rel);
	} catch (e) {
		ctx.say(
			`  the release's shipped-path seam could not be loaded, so no base line pin was judged UNSHIPPED: ${errMessage(e)}\n`,
		);
		return null;
	}
}

/**
 * @param {import("./lib/check").Ctx} ctx
 * @param {string[]} docs
 * @param {{doc: string, text: string}[]} read
 * @returns {{rows: number, findings: Finding[]}}
 */
function routeDrift(ctx, docs, read) {
	if (!docs.includes(DOC)) return { rows: 0, findings: [] };
	let declared;
	try {
		declared = readConfig({ root: root(), quiet: true }).pythonRoutes;
	} catch (e) {
		ctx.say(
			`  ${CONFIG_PATH} could not be read, so pythonRoutes went unchecked against the route table: ${errMessage(e)}\n`,
		);
		return { rows: 0, findings: [] };
	}
	const text = read.find((r) => r.doc === DOC)?.text ?? "";
	const { rows, drift } = pythonRouteDrift(text, declared);
	return {
		rows,
		findings: drift.map(({ line, glob, detail }) => ({
			kind: "ROUTE-DRIFT",
			doc: DOC,
			docLine: line,
			pin: glob,
			detail,
			where: line === 0 ? CONFIG_PATH : undefined,
			scopedBy: [DOC, CONFIG_PATH],
		})),
	};
}

/**
 * @param {import("./lib/check").Ctx} ctx
 * @param {{doc: string, pins: LinePin[]}[]} read
 * @param {{set: Set<string>, byBase: Map<string, string[]>}} tracked
 */
function judgeDocs(ctx, read, tracked) {
	/** @type {Finding[]} */
	const stale = [];
	/** @type {Set<string>} */
	const filesCited = new Set();
	let citations = 0;
	let quoted = 0;
	let bare = 0;
	for (const { doc, pins } of read) {
		const judged = judge(
			doc,
			pins,
			tracked,
			doc === BASE_DOC ? loadShipped(ctx) : null,
		);
		stale.push(...judged.findings);
		for (const rel of judged.filesCited) filesCited.add(rel);
		citations += pins.length;
		quoted += judged.quoted;
		bare += judged.bare;
	}
	return { stale, filesCited, citations, quoted, bare };
}

/**
 * @param {import("./lib/check").Ctx} ctx
 * @param {{touching: string, findings: Finding[], read: {doc: string}[]}} scope
 */
function scopeToTouching(ctx, { touching, findings, read }) {
	const rev = baselineOf(touching);
	const touchedFiles = readChangedFiles(rev, (m) => ctx.broken(m));
	const touchedDocLines = new Map(
		read.map(({ doc }) => [
			doc,
			readChangedLines(rev, doc, (m) => ctx.broken(m)),
		]),
	);
	const inScope = (/** @type {Finding} */ f) =>
		(f.rel !== undefined && touchedFiles.has(f.rel)) ||
		(f.scopedBy?.some((rel) => touchedFiles.has(rel)) ?? false) ||
		(f.doc !== undefined &&
			f.docLine !== 0 &&
			(touchedDocLines.get(f.doc)?.has(f.docLine) ?? false));
	const before = findings.length;
	const scoped = findings.filter(inScope);
	const scopeNote =
		`  --touching ${touching} scoped ${before} finding(s) across the whole\n` +
		`  document down to ${scoped.length}: only a citation whose cited file\n` +
		"  this diff touched, or one sitting on a document line the diff changed.\n";
	return { findings: scoped, scopeNote };
}

const NOT_CITATIONS = ["DEAD-EXPORT", "STALE-CALLER", "ROUTE-DRIFT"];

/**
 * @param {import("./lib/check").Ctx} ctx
 * @param {Finding[]} findings
 */
function reportFindings(ctx, findings) {
	for (const f of findings) {
		const where =
			f.where ??
			(f.docLine ? `${f.doc}:${f.docLine}` : anchorsOf(f.doc ?? DOC));
		// lucmoseley/mantahostels#2490
		ctx.warn(
			f.kind,
			`${f.kind}  ${where}  ${f.pin} — ${f.detail}`,
			{},
			`${f.kind}\t${f.pin}`,
		);
		ctx.say(`${f.kind}  ${where}  ${f.pin}`);
		ctx.say(`  ${f.detail}\n`);
	}

	if (
		findings.some(
			(f) => !NOT_CITATIONS.includes(f.kind) && f.kind !== "UNSHIPPED",
		)
	)
		ctx.say(
			"  Every citation finding is a pin that no longer resolves. Fix the\n" +
				"  DOCUMENT, never the cited file. Report-only — this never fails a\n" +
				"  build (mantahostels#1091).\n",
		);
	if (findings.some((f) => f.kind === "DEAD-EXPORT"))
		ctx.say(
			"  Every DEAD-EXPORT is a breach in the CODE, not in the document: §G6\n" +
				"  where only tests consume the name, §N7 where nothing does.\n" +
				"  The scan is textual, so verify the name is unreachable by string too\n" +
				"  before deleting it (mantahostels#1799).\n",
		);
	if (findings.some((f) => f.kind === "STALE-CALLER"))
		ctx.say(
			`  Every STALE-CALLER is a row in ${EXPORT_CALLERS} that keeps nothing:\n` +
				"  fix or drop the row, and make the export file-local where no\n" +
				"  caller wants it (§N7, #5486).\n",
		);
	if (findings.some((f) => f.kind === "ROUTE-DRIFT"))
		ctx.say(
			`  Every ROUTE-DRIFT is ${CONFIG_PATH}'s pythonRoutes, which the\n` +
				`  swallowed-error gate routes Python by, out of step with ${DOC}'s\n` +
				"  route table. The table wins: fix pythonRoutes, unless the table\n" +
				"  is what is wrong (#1863).\n",
		);
}

/**
 * @param {{citations: number, filesCited: Set<string>, read: {doc: string}[], quoted: number, bare: number, dead: {names: number, blocks: number, unparsed: number}, pythonRows: number, routeDrifts: number, touching: string | null, findings: Finding[]}} r
 */
function okLineOf({
	citations,
	filesCited,
	read,
	quoted,
	bare,
	dead,
	pythonRows,
	routeDrifts,
	touching,
	findings,
}) {
	return (
		`${citations} citation(s) across ${filesCited.size} file(s)` +
		(read.length > 1 ? ` in ${read.map((r) => r.doc).join(" and ")}` : "") +
		" resolve — " +
		`${quoted} quotation(s) found verbatim inside their cited range, ` +
		`${bare} bare pin(s) unchanged since they were last read; ` +
		`every one of ${dead.names} name(s) across ${dead.blocks} §N7 export block(s) is spelled by a non-test file that does not define it` +
		(dead.unparsed
			? `, and ${dead.unparsed} entr(ies) were of no shape §N7 describes and went unread.`
			: ".") +
		(routeDrifts === 0
			? ` pythonRoutes agrees with the ${pythonRows} route row(s) reaching Python.`
			: "") +
		(touching ? ` (--touching ${touching}: ${findings.length} in scope)` : "")
	);
}

/** @type {import("./lib/check.js").CheckSpec} */
const SPEC = {
	name: "code-standards",
	usage:
		"node check-code-standards.js [--warn] [--json] [--touching <rev>] [<doc>] | --review [<doc>] [<pin>…]",
	valueFlags: ["--touching"],
	flags: ["--review"],
	run(/** @type {import("./lib/check").Ctx} */ ctx) {
		const reviewAt = ctx.argv.indexOf("--review");
		const reviewing = reviewAt !== -1;
		const touching = ctx.value("--touching");
		if (reviewing && ctx.asJson)
			ctx.usageError(
				"--review writes anchors and reports no findings, so it has no --json form.",
			);
		if (reviewing && touching)
			ctx.usageError(
				"--review re-anchors after a read; --touching scopes a report. Not both at once.",
			);

		const targets = ctx.argv
			.slice(reviewAt + 1)
			.filter((a) => !a.startsWith("--"));
		const reviewDoc =
			reviewing && isDocumentArg(targets[0]) ? targets.shift() : undefined;
		const docs = docsFor(ctx, reviewing, reviewDoc);

		const { read, unread } = readDocs(docs);
		const [primary] = read;
		if (reviewing && primary === undefined)
			ctx.skip(`${unread[0]} — so there are no citations to check`);
		for (const why of unread)
			ctx.say(`  ${why} — its citations go unchecked.\n`);

		const tracked = readTrackedFiles((m) => ctx.broken(m));

		if (reviewing && primary)
			reanchor(primary.doc, targets, primary.pins, tracked);

		const { stale, filesCited, citations, quoted, bare } = judgeDocs(
			ctx,
			read,
			tracked,
		);

		const blocks = readExportBlocks(tracked);
		const consumers = consumersOf(tracked.set, blocks);
		const rows = readCallerRows((m) => ctx.broken(m));
		const dead = deadExports(blocks, consumers, rows);
		const staleRows = staleCallerRows(rows, blocks, consumers, tracked);
		const routes = routeDrift(ctx, docs, read);

		let findings = [
			...stale,
			...dead.findings,
			...staleRows,
			...routes.findings,
		];
		let scopeNote = "";
		if (touching)
			({ findings, scopeNote } = scopeToTouching(ctx, {
				touching,
				findings,
				read,
			}));
		reportFindings(ctx, findings);
		if (scopeNote) ctx.say(scopeNote);

		return {
			okLine: okLineOf({
				citations,
				filesCited,
				read,
				quoted,
				bare,
				dead,
				pythonRows: routes.rows,
				routeDrifts: routes.findings.length,
				touching,
				findings,
			}),
			noun: "stale citation(s), export(s) nothing consumes, stale export-caller row(s) and Python route row(s) out of step",
			data: {
				citations,
				documents: read.map((r) => r.doc),
				files: filesCited.size,
				quotations: quoted,
				barePins: bare,
				exportBlocks: dead.blocks,
				exportedNames: dead.names,
				exportEntriesUnread: dead.unparsed,
				exportsTestOnly: dead.testOnly,
				citations_stale: findings.filter(
					(f) => !NOT_CITATIONS.includes(f.kind),
				),
				exports_dead: findings.filter((f) => f.kind === "DEAD-EXPORT"),
				callers_stale: findings.filter((f) => f.kind === "STALE-CALLER"),
				routes_drift: findings.filter((f) => f.kind === "ROUTE-DRIFT"),
			},
		};
	},
};

module.exports = { SPEC };
if (require.main === module) runCheck(SPEC);
