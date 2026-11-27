const fs = require("node:fs");
const path = require("node:path");
const {
	readNeedles,
	recordFires,
	READ_KINDS,
	recordMatches,
	transcriptFires,
	transcriptMatches,
} = require("./guard-fires.js");
const { readSeatTranscripts } = require("./project-dirs.js");
const { subagentDirOf } = require("./transcript.js");
const { configDirs } = require("./arbiter-store");
const { caught } = require("./caught.js");
const { readText } = require("./file-read.js");
const { parseJsonlRow } = require("./jsonl.js");
const { escapeRe } = require("./regex-group.js");

const SIGNATURE_LOG = "docs/data/outcome-signatures.jsonl";

const SECTION_HEADING = "## Fault signature";

const SCOPES = /** @type {const} */ (["main", "subagent", "both"]);
const REGEX_FLAGS = /^[imsu]*$/;

/**
 * @typedef {{kind: "needle", key: string, needle?: string}
 *   | {kind: "regex", pattern: string, flags?: string,
 *      scope: "main" | "subagent" | "both", reads?: "call", tool?: string}} Signature
 * @typedef {{session: string, line: number, agent?: string}} Case
 * @typedef {{signature: Signature, prediction: string, case: Case}
 *   | {signature: null, why: string}} Declared
 * @typedef {Record<string, unknown>} Row
 * @typedef {ReturnType<typeof readNeedles>["needles"]} Registry
 */

/** @param {unknown} v @returns {v is string} */
const isText = (v) => typeof v === "string" && v.trim() !== "";

/**
 * @param {unknown} raw
 * @param {Registry} registry
 * @returns {{declared: Declared} | {error: string}}
 */
function checkDeclared(raw, registry) {
	if (!raw || typeof raw !== "object" || Array.isArray(raw))
		return { error: "the signature file is not a JSON object." };
	const d = /** @type {Row} */ (raw);
	if (!("signature" in d))
		return {
			error:
				'it has no "signature" key — a needle, a regex, or null with a "why".',
		};
	if (d.signature === null)
		return isText(d.why)
			? { declared: { signature: null, why: d.why.trim() } }
			: {
					error:
						'"signature": null needs a "why": what leaves the fault no countable trace.',
				};
	const sig = checkSignature(d.signature, registry);
	if ("error" in sig) return sig;
	if (!isText(d.prediction))
		return {
			error:
				'it has no "prediction": what the fix should do to the count, in plain words.',
		};
	const c = checkCase(d.case);
	if ("error" in c) return c;
	return {
		declared: {
			signature: sig.signature,
			prediction: d.prediction.trim(),
			case: c.case,
		},
	};
}

/**
 * @param {unknown} raw
 * @param {Registry} registry
 * @returns {{signature: Signature} | {error: string}}
 */
function checkSignature(raw, registry) {
	const s = /** @type {Row} */ (raw ?? {});
	if (s.kind === "needle") return checkNeedle(s, registry);
	if (s.kind === "regex") return checkRegex(s);
	return {
		error: `signature kind ${JSON.stringify(s.kind)} is neither "needle" nor "regex".`,
	};
}

/**
 * @param {Row} s
 * @param {Registry} registry
 * @returns {{signature: Signature} | {error: string}}
 */
function checkNeedle(s, registry) {
	const { key, needle } = s;
	/** @type {string[]} */
	const ids = isText(key)
		? (registry.guards?.[key]?.needles ?? []).map(
				(/** @type {{id: string}} */ n) => n.id,
			)
		: [];
	if (!isText(key) || ids.length === 0)
		return {
			error: `needle key ${JSON.stringify(key)} is not a guard with needles in the guard-fire registry (scripts/guard-fire-needles.json).`,
		};
	if (needle === undefined) return { signature: { kind: "needle", key } };
	if (typeof needle !== "string" || !ids.includes(needle))
		return {
			error: `${key} has no needle ${JSON.stringify(needle)}; it has ${ids.join(", ")}.`,
		};
	return { signature: { kind: "needle", key, needle } };
}

/**
 * @param {string} pattern
 * @param {string} flags
 * @returns {RegExp | string}
 */
function tryCompile(pattern, flags) {
	try {
		return new RegExp(pattern, flags);
	} catch (e) {
		return caught(e).message;
	}
}

/**
 * @param {Row} s
 * @returns {{signature: Signature} | {error: string}}
 */
function checkRegex(s) {
	const { pattern } = s;
	if (!isText(pattern))
		return { error: 'a regex signature needs a non-empty "pattern".' };
	const flags = s.flags ?? "";
	if (typeof flags !== "string" || !REGEX_FLAGS.test(flags))
		return {
			error: `regex flags ${JSON.stringify(s.flags)} are not among i, m, s, u.`,
		};
	const compiled = tryCompile(pattern, flags);
	if (typeof compiled === "string")
		return { error: `the pattern does not compile: ${compiled}` };
	const scope = SCOPES.find((x) => x === s.scope);
	if (!scope)
		return {
			error: `a regex signature's "scope" is one of ${SCOPES.join(", ")}: the transcript tier it reads.`,
		};
	const reads = READ_KINDS.find((x) => x === (s.reads ?? "output"));
	if (!reads)
		return {
			error: `a regex signature's "reads" is "output" (left out: where the fault surfaces — a tool result, a hook's output, Stop hook feedback) or "call" (the tool calls a session made).`,
		};
	const { tool } = s;
	if (tool !== undefined && (reads !== "call" || !isText(tool)))
		return {
			error: `a regex signature's "tool" names the one tool whose calls a "reads": "call" regex reads, such as "Bash"; it takes no other form.`,
		};
	return {
		signature: {
			kind: "regex",
			pattern,
			...(flags ? { flags } : {}),
			scope,
			...(reads === "call" ? { reads } : {}),
			...(tool === undefined ? {} : { tool }),
		},
	};
}

/**
 * @param {unknown} raw
 * @returns {{case: Case} | {error: string}}
 */
function checkCase(raw) {
	const { session, line, agent } = /** @type {Row} */ (raw ?? {});
	if (
		!isText(session) ||
		typeof line !== "number" ||
		!Number.isInteger(line) ||
		line < 1
	)
		return {
			error:
				'it has no usable "case": {"session": "<session id>", "line": <1-based line>} naming the transcript record that triggered the ticket.',
		};
	if (agent !== undefined && !isText(agent))
		return { error: '"case.agent" names a subagent id, or is left out.' };
	return {
		case: {
			session,
			line,
			...(agent ? { agent } : {}),
		},
	};
}

/**
 * @param {{key: string, needle?: string}} sig
 * @param {Registry} registry
 */
function needleSubject(sig, registry) {
	const needles = registry.guards?.[sig.key]?.needles ?? [];
	return {
		id: `guard:${sig.key}`,
		routes: ["hook", "deny"],
		needles: sig.needle
			? needles.filter((/** @type {{id: string}} */ n) => n.id === sig.needle)
			: needles,
	};
}

/**
 * @param {Signature} sig
 * @param {"main" | "subagent"} tier
 */
function readsTier(sig, tier) {
	return sig.kind === "needle" || sig.scope === "both" || sig.scope === tier;
}

/** @param {Extract<Signature, {kind: "regex"}>} sig */
const compile = (sig) => new RegExp(sig.pattern, sig.flags ?? "");

/**
 * @param {string} text
 * @param {Signature} sig
 * @param {"main" | "subagent"} tier
 * @param {{registry: Registry, skip?: RegExp}} read
 * @returns {Array<{at: string|null}>}
 */
function signatureHits(text, sig, tier, { registry, skip }) {
	if (!readsTier(sig, tier)) return [];
	if (sig.kind === "needle")
		return transcriptFires(text, [needleSubject(sig, registry)], tier).map(
			(f) => ({ at: f.at }),
		);
	return transcriptMatches(text, compile(sig), tier, { ...sig, skip });
}

/**
 * @param {Case} c
 * @param {string[]} seats
 * @returns {{record: Row, tier: "main" | "subagent", file: string} | {error: string}}
 */
function readCaseRecord(c, seats) {
	const main = readSeatTranscripts(seats).files.find(
		(f) => path.basename(f) === `${c.session}.jsonl`,
	);
	if (!main)
		return {
			error: `no seat keeps a transcript for session ${c.session}.`,
		};
	const file = c.agent
		? path.join(subagentDirOf(main), `agent-${c.agent}.jsonl`)
		: main;
	const read = readText(file);
	if (read.state !== "read")
		return {
			error: `could not read ${file} (${read.state === "absent" ? "absent" : read.message}).`,
		};
	const line = read.data.split("\n")[c.line - 1];
	if (line === undefined || !line.trim())
		return { error: `${file} has no line ${c.line}.` };
	const record = parseJsonlRow(line);
	if (!record) return { error: `${file} line ${c.line} is not a JSON record.` };
	return { record, tier: c.agent ? "subagent" : "main", file };
}

/**
 * @param {Signature} sig
 * @param {{record: Row, tier: "main" | "subagent"}} at
 * @param {Registry} registry
 */
function matchesCase(sig, { record, tier }, registry) {
	if (!readsTier(sig, tier)) return false;
	if (sig.kind === "needle")
		return recordFires(record, [needleSubject(sig, registry)]).length > 0;
	return recordMatches(record, compile(sig), sig);
}

/**
 * @param {string} file
 * @param {{root: string, seats?: string[]}} at
 * @returns {{declared: Declared, registry: Registry} | {error: string}}
 */
function readDeclared(file, { root, seats = configDirs() }) {
	const text = readText(file);
	if (text.state !== "read")
		return {
			error: `could not read ${file} (${text.state === "absent" ? "absent" : text.message}).`,
		};
	let raw;
	try {
		raw = JSON.parse(text.data);
	} catch (e) {
		return { error: `${file} is not JSON (${caught(e).message}).` };
	}
	const registry = readNeedles(root).needles;
	const checked = checkDeclared(raw, registry);
	if ("error" in checked)
		return {
			error: `${file}: ${checked.error} The shape: scripts/lib/fault-signature.js.`,
		};
	const { declared } = checked;
	if (declared.signature === null) return { declared, registry };
	const at = readCaseRecord(declared.case, seats);
	if ("error" in at)
		return {
			error: `${file}: its case cannot be read — ${at.error} Name the session and line of the record that triggered the ticket.`,
		};
	if (!matchesCase(declared.signature, at, registry))
		return {
			error: `${file}: the signature does not match its case, ${at.file} line ${declared.case.line}, so it would count nothing (workflow-core#4635). The case is the line where the fault surfaces: the output record (a tool_result, a hook attachment, Stop hook feedback, a system record), or the tool_use record for a "reads": "call" regex — never the session's prose about it. Fix the signature, or move the case to that line.`,
		};
	return { declared, registry };
}

/** @param {{issue: string, filedAt: string, declared: Declared, late?: boolean}} at */
function buildSignatureLine({ issue, filedAt, declared, late }) {
	const base =
		declared.signature === null
			? { issue, filedAt, signature: null, why: declared.why }
			: {
					issue,
					filedAt,
					signature: declared.signature,
					prediction: declared.prediction,
					case: declared.case,
				};
	return late ? { ...base, late: true } : base;
}

/**
 * @param {string} root
 * @param {Record<string, unknown>} line
 */
function appendSignatureLine(root, line) {
	const file = path.join(root, SIGNATURE_LOG);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.appendFileSync(file, `${JSON.stringify(line)}\n`);
	return file;
}

/**
 * @param {Record<string, unknown>} line
 */
function signatureSection(line) {
	const { issue: _, ...rest } = line;
	return `${SECTION_HEADING}\n\n\`\`\`json\n${JSON.stringify(rest)}\n\`\`\`\n`;
}

const SECTION = new RegExp(
	`^${escapeRe(SECTION_HEADING)}\\r?\\n\\r?\\n\`\`\`json\\r?\\n([^\\r\\n]*)\\r?\\n\`\`\`(?:\\r?\\n)?`,
	"m",
);

/**
 * @param {string} body
 * @param {Record<string, unknown>} line
 */
function withSignatureSection(body, line) {
	return SECTION.test(body)
		? body.replace(SECTION, () => signatureSection(line))
		: `${body.trimEnd()}\n\n${signatureSection(line)}`;
}

/**
 * @param {string} issue
 * @param {string} body
 * @returns {Row | null}
 */
function parseSignatureSection(issue, body) {
	const m = body.match(SECTION);
	const row = m?.[1] ? parseJsonlRow(m[1]) : null;
	return row ? { issue, ...row } : null;
}

module.exports = {
	SIGNATURE_LOG,
	appendSignatureLine,
	buildSignatureLine,
	checkSignature,
	readDeclared,
	SECTION_HEADING,
	parseSignatureSection,
	signatureHits,
	withSignatureSection,
};
