/*
 * fault-signature.js — the fault signature a ticket claiming to stop a fault
 * declares at filing (#4796, #4640): its shape, the case it must match, how it
 * is counted in a transcript, and the log line file-issue.js appends.
 *
 * A signature file is JSON:
 *
 *   {"signature": {"kind": "needle", "key": "<guard key>", "needle": "<id>"?}
 *                | {"kind": "regex", "pattern": "<re>", "flags": "i"?,
 *                   "scope": "main" | "subagent" | "both"},
 *    "prediction": "<plain words>",
 *    "case": {"session": "<session id>", "line": <1-based>, "agent": "<id>"?}}
 *
 * or `{"signature": null, "why": "<why no trace counts it>"}`. A needle's key
 * is a `guards` key of the guard-fire registry, the core's
 * scripts/guard-fire-needles.json with the host's own folded in
 * (lib/guard-fires.js `mergeNeedles`), and carries needles. The case names the
 * transcript record that triggered the ticket: `agent` names a subagent's own
 * log under that session. It is read across every seat, one copy each
 * (lib/project-dirs.js), and a signature that does not match it is refused, so
 * a filer learns at filing that it would count nothing (#4635).
 *
 * A needle counts as lib/guard-fires.js counts a guard's fires, on both tiers;
 * a regex through its regex route, on the tiers its scope names.
 */

const fs = require("node:fs");
const path = require("node:path");
const {
	mergeNeedles,
	recordFires,
	recordMatches,
	transcriptFires,
	transcriptMatches,
} = require("./guard-fires.js");
const { readSeatTranscripts } = require("./project-dirs.js");
const { configDirs } = require("./arbiter-store");
const { caught } = require("./caught.js");
const { parseJsonlRow, readJsonl } = require("./jsonl.js");

/** The append-only log, at a repo's root; `merge=union` in .gitattributes. */
const SIGNATURE_LOG = "docs/data/outcome-signatures.jsonl";

const SCOPES = ["main", "subagent", "both"];
const REGEX_FLAGS = /^[imsu]*$/;

/**
 * @typedef {{kind: "needle", key: string, needle?: string}
 *   | {kind: "regex", pattern: string, flags?: string,
 *      scope: "main" | "subagent" | "both"}} Signature
 * @typedef {{session: string, line: number, agent?: string}} Case
 * @typedef {{signature: Signature, prediction: string, case: Case}
 *   | {signature: null, why: string}} Declared
 * @typedef {Record<string, any>} Registry the merged guard-fire needles
 */

/**
 * The core registry with the host's `guards` folded in.
 * @param {string} hostRoot
 * @returns {Registry}
 */
function readRegistry(hostRoot) {
	const core = JSON.parse(
		fs.readFileSync(
			path.join(__dirname, "..", "guard-fire-needles.json"),
			"utf8",
		),
	);
	let host = null;
	try {
		host = JSON.parse(
			fs.readFileSync(
				path.join(hostRoot, ".claude", "guard-fire-needles.json"),
				"utf8",
			),
		);
	} catch (e) {
		if (caught(e).code !== "ENOENT") throw e;
	}
	return mergeNeedles(core, host).needles;
}

/** @param {unknown} v */
const isText = (v) => typeof v === "string" && v.trim() !== "";

/**
 * A declared signature checked for shape, or why it is refused.
 * @param {unknown} raw  the parsed file
 * @param {Registry} registry
 * @returns {{declared: Declared} | {error: string}}
 */
function checkDeclared(raw, registry) {
	if (!raw || typeof raw !== "object" || Array.isArray(raw))
		return { error: "the signature file is not a JSON object." };
	const d = /** @type {Record<string, any>} */ (raw);
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
	const s = /** @type {Record<string, any>} */ (raw ?? {});
	if (s.kind === "needle") return checkNeedle(s, registry);
	if (s.kind === "regex") return checkRegex(s);
	return {
		error: `signature kind ${JSON.stringify(s.kind)} is neither "needle" nor "regex".`,
	};
}

/**
 * @param {Record<string, any>} s
 * @param {Registry} registry
 * @returns {{signature: Signature} | {error: string}}
 */
function checkNeedle(s, registry) {
	const entry = registry.guards?.[s.key];
	const ids = (entry?.needles ?? []).map(
		(/** @type {{id: string}} */ n) => n.id,
	);
	if (!isText(s.key) || ids.length === 0)
		return {
			error: `needle key ${JSON.stringify(s.key)} is not a guard with needles in the guard-fire registry (scripts/guard-fire-needles.json).`,
		};
	if (s.needle === undefined)
		return { signature: { kind: "needle", key: s.key } };
	if (!ids.includes(s.needle))
		return {
			error: `${s.key} has no needle ${JSON.stringify(s.needle)}; it has ${ids.join(", ")}.`,
		};
	return { signature: { kind: "needle", key: s.key, needle: s.needle } };
}

/**
 * @param {string} pattern
 * @param {string} flags
 * @returns {RegExp | string} the compiled pattern, or why it does not compile
 */
function tryCompile(pattern, flags) {
	try {
		return new RegExp(pattern, flags);
	} catch (e) {
		return caught(e).message;
	}
}

/**
 * @param {Record<string, any>} s
 * @returns {{signature: Signature} | {error: string}}
 */
function checkRegex(s) {
	if (!isText(s.pattern))
		return { error: 'a regex signature needs a non-empty "pattern".' };
	const flags = s.flags ?? "";
	if (typeof flags !== "string" || !REGEX_FLAGS.test(flags))
		return {
			error: `regex flags ${JSON.stringify(s.flags)} are not among i, m, s, u.`,
		};
	const compiled = tryCompile(s.pattern, flags);
	if (typeof compiled === "string")
		return { error: `the pattern does not compile: ${compiled}` };
	if (!SCOPES.includes(s.scope))
		return {
			error: `a regex signature's "scope" is one of ${SCOPES.join(", ")}: the transcript tier it reads.`,
		};
	return {
		signature: {
			kind: "regex",
			pattern: s.pattern,
			...(flags ? { flags } : {}),
			scope: s.scope,
		},
	};
}

/**
 * @param {unknown} raw
 * @returns {{case: Case} | {error: string}}
 */
function checkCase(raw) {
	const c = /** @type {Record<string, any>} */ (raw ?? {});
	if (!isText(c.session) || !Number.isInteger(c.line) || c.line < 1)
		return {
			error:
				'it has no usable "case": {"session": "<session id>", "line": <1-based line>} naming the transcript record that triggered the ticket.',
		};
	if (c.agent !== undefined && !isText(c.agent))
		return { error: '"case.agent" names a subagent id, or is left out.' };
	return {
		case: {
			session: c.session,
			line: c.line,
			...(c.agent ? { agent: c.agent } : {}),
		},
	};
}

/**
 * The guard-fires subject a needle signature counts.
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
 * Whether a signature reads a file of this tier: a needle reads both, a regex
 * those its scope names.
 * @param {Signature} sig
 * @param {"main" | "subagent"} tier
 */
function readsTier(sig, tier) {
	return sig.kind === "needle" || sig.scope === "both" || sig.scope === tier;
}

/** @param {Extract<Signature, {kind: "regex"}>} sig */
const compile = (sig) => new RegExp(sig.pattern, sig.flags ?? "");

/**
 * How many times a signature occurs in one transcript's text: a needle's
 * deduped fires, a regex's matching records. Zero on a tier it does not read.
 * @param {string} text
 * @param {Signature} sig
 * @param {"main" | "subagent"} tier
 * @param {Registry} registry
 * @returns {Array<{at: string|null}>}
 */
function signatureHits(text, sig, tier, registry) {
	if (!readsTier(sig, tier)) return [];
	if (sig.kind === "needle")
		return transcriptFires(text, [needleSubject(sig, registry)], tier).map(
			(f) => ({ at: f.at }),
		);
	return transcriptMatches(text, compile(sig), tier);
}

/**
 * The case's record, read across every seat, or why it cannot be.
 * @param {Case} c
 * @param {string[]} [seats]
 * @returns {{record: Record<string, any>, tier: "main" | "subagent", file: string} | {error: string}}
 */
function readCaseRecord(c, seats = configDirs()) {
	const main = readSeatTranscripts(seats).files.find(
		(f) => path.basename(f) === `${c.session}.jsonl`,
	);
	if (!main)
		return {
			error: `no seat keeps a transcript for session ${c.session}.`,
		};
	const file = c.agent
		? path.join(
				path.dirname(main),
				c.session,
				"subagents",
				`agent-${c.agent}.jsonl`,
			)
		: main;
	let text;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch (e) {
		return { error: `could not read ${file} (${caught(e).code ?? "error"}).` };
	}
	const line = text.split("\n")[c.line - 1];
	if (line === undefined || !line.trim())
		return { error: `${file} has no line ${c.line}.` };
	const record = parseJsonlRow(line);
	if (!record) return { error: `${file} line ${c.line} is not a JSON record.` };
	return { record, tier: c.agent ? "subagent" : "main", file };
}

/**
 * Whether a signature matches the record that triggered the ticket.
 * @param {Signature} sig
 * @param {{record: Record<string, any>, tier: "main" | "subagent"}} at
 * @param {Registry} registry
 */
function matchesCase(sig, { record, tier }, registry) {
	if (!readsTier(sig, tier)) return false;
	if (sig.kind === "needle")
		return recordFires(record, [needleSubject(sig, registry)]).length > 0;
	return recordMatches(record, compile(sig));
}

/**
 * The line the log keeps for one filing.
 * @param {{issue: string, filedAt: string, declared: Declared, late?: boolean}} at
 */
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
 * Appends one line to the log under `root`.
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
 * Every line of the log under `root`; a line that does not parse is named.
 * @param {string} root
 * @returns {{lines: Array<Record<string, any>>, bad: number[]}}
 */
function readSignatureLog(root) {
	const read = readJsonl(path.join(root, SIGNATURE_LOG));
	return {
		lines: /** @type {Array<Record<string, any>>} */ (read?.rows ?? []),
		bad: read?.bad ?? [],
	};
}

module.exports = {
	SIGNATURE_LOG,
	appendSignatureLine,
	buildSignatureLine,
	checkDeclared,
	matchesCase,
	readCaseRecord,
	readRegistry,
	readSignatureLog,
	readsTier,
	signatureHits,
};
