#!/usr/bin/env node
/*
 * register-doc.js — writes one docs/doc-map-classes.json key, the sidecar §A
 * renders a row from (mantahostels#1848).
 *
 * Usage:
 *   node scripts/register-doc.js <path> --class <token> --section <name>
 *     [--reader <token>] [--qualifier <text>] [--consumes <json>] [--role <text>]
 *     [--route <text>] [--new-section]
 *     [--claim-cmd <cmd>] [--no-claim] [--release-cmd <cmd>]
 *     [--data-file <docs/doc-map-classes.json>]
 *   node scripts/register-doc.js <path> --role <text>
 *   node scripts/register-doc.js <path> --route <text>
 *
 * --role       the §A Role cell, in place of renderRole's title-cased filename.
 *              Given alongside --class it writes at registration; given ALONE
 *              it sets the role of a key already registered, and touches no
 *              other field (mantahostels#3376). Refused over the 300-word cap
 *              check-doc-map.js enforces, and on a line break, which would
 *              split the rendered table row.
 *
 * --route      the §A Update route cell, in place of the class default
 *              (`CLASS_ROUTE[entry.class] || "Direct"`). Given alongside
 *              --class it writes at registration; given ALONE it sets the
 *              route of a key already registered, and touches no other field.
 *              Refused on a line break, which would split the rendered table
 *              row; no word cap.
 *
 * --reader     who reads the document: agent, human or both (mantahostels#3412). Required
 *              on a `.md` or `.html` path and refused on any other, the rule
 *              check-doc-map.js assertion 31 gates.
 *
 * --consumes   a JSON array of typed references (mantahostels#2419), e.g.
 *              '[{"kind":"path","ref":"scripts/x.js","gloss":"why"}]'.
 *              Shape only — an unknown key or kind, a malformed `issue` or
 *              `glob` ref, or an empty array, is refused rather than silently
 *              dropped. What a reference POINTS AT is not resolved here: a
 *              dead `path`, a `glob` matching nothing and a dead `figure`
 *              are check-doc-map.js's job at commit time. Omitted, it writes
 *              `null`.
 *
 * --new-section
 *              accept a --section spelling no existing key uses; without it an
 *              unknown spelling is refused. A spelling that IS new also
 *              prompts for whether the heading is obligation-bearing (mantahostels#3198).
 * --no-claim   skip the claim below; for tests, which run against a
 *              throwaway data file outside the tree the claim store governs.
 * --data-file  override the sidecar path read and written; defaults to the
 *              repo's own docs/doc-map-classes.json. The claim subject
 *              always names the real sidecar, whatever this points at, since
 *              a test pointed elsewhere has nothing for the store to lock.
 *
 * `--class` is required and refuses rather than defaulting on anything but
 * one of the five documented tokens (mantahostels#1848 AC4). `--section`
 * names the §A subsection the row renders under; it is a judgement too.
 *
 * `role`, `route` and `consumes` are null unless `--role`, `--route` or
 * `--consumes` states them (mantahostels#3376, mantahostels#2535, mantahostels#3411).
 *
 * WRITE FORM (mantahostels#3353): this is the sidecar's one writer, and its canonical
 * bytes are top-level keys sorted `.sort()`, `JSON.stringify(sorted, null,
 * "\t")`, one trailing newline, non-ASCII left UNESCAPED. Any other route
 * onto disk — a differently-indented stringify, a hand edit, `json.dump`
 * under Python's `ensure_ascii=True` default — reformats every entry the
 * escaping or ordering touches; check-doc-map.js's SIDECAR-NOT-CANONICAL
 * assertion gates a commit that drifts from this form.
 *
 * Claims `docs/doc-map-classes.json#A:<path>` BEFORE reading the sidecar, and
 * re-reads it fresh once the claim is held — never writes from a read taken
 * before the claim. A live neighbour holding the SAME key is warned of, as a
 * write is (#4249), and the arbiter's warning passed on: each session writes
 * its own worktree's sidecar, so the clash is at the merge.
 *
 * NAMED RESIDUAL (mantahostels#1848): the claim is per-key but the write rewrites the
 * whole file, so two sessions registering two DIFFERENT keys can still each
 * read-modify-write concurrently and one's write can drop the other's
 * just-added key. Claiming before the read narrows the
 * window to the read-mutate-write span alone; it does not close it. Closing
 * it needs a whole-file lock around the write, which would trade away the
 * "two sessions registering different documents never contend" property
 * this ticket built the per-key claim for — left to mantahostels#1849 or a later ticket
 * if two sessions racing this command in practice ever surfaces it.
 */

const fs = require("node:fs");
const { scriptPath } = require("./lib/script-path.js");
const path = require("node:path");
const { worktreeRoot } = require("./lib/host-root.js");
const { flagValue, parseOrCode } = require("./lib/cli-args");
const { claimDataFile, releaseClaim } = require("./lib/doc-map-generator");
const { ROW_PREFIX, SIDECAR_PATH } = require("./lib/doc-map-regions");
const {
	DOC_CLASSES,
	DOC_READERS,
	isProseKey,
	CONSUMES_KINDS,
	ROLE_CAP_WORDS,
	roleWordCount,
} = require("./lib/doc-map");
const { caught } = require("./lib/caught.js");

// lucmoseley/mantahostels#1863
const VALID_CLASSES = DOC_CLASSES;
const VALID_READERS = DOC_READERS;

// lucmoseley/mantahostels#3198
const ORPHAN_CHECK_EXEMPT = new Set([
	"Skills & settings",
	"Agent-skill configuration",
	"Non-prose",
	"Copy artefacts",
	"Sync artefacts",
]);

/**
 * @param {unknown} consumes
 * @returns {string | null}
 */
function consumesShapeError(consumes) {
	if (!Array.isArray(consumes) || consumes.length === 0)
		return "--consumes does not hold a non-empty array";
	for (let i = 0; i < consumes.length; i++) {
		const error = consumesElementError(consumes[i], `--consumes[${i}]`);
		if (error) return error;
	}
	return null;
}

/**
 * @param {unknown} el
 * @param {string} where
 * @returns {string | null}
 */
function consumesElementError(el, where) {
	if (typeof el !== "object" || el === null || Array.isArray(el))
		return `${where} is not a { kind, ref, gloss? } object`;
	const extra = Object.keys(el).filter(
		(k) => !["kind", "ref", "gloss"].includes(k),
	);
	if (extra.length > 0)
		return `${where} carries unknown field(s) ${extra.join(", ")}`;
	const e = /** @type {{ kind?: unknown, ref?: unknown, gloss?: unknown }} */ (
		el
	);
	if (typeof e.kind !== "string" || !CONSUMES_KINDS.includes(e.kind))
		return `${where}.kind is ${JSON.stringify(e.kind)} — not one of ${CONSUMES_KINDS.join(", ")}`;
	if (typeof e.ref !== "string" || !e.ref.trim())
		return `${where}.ref is not a non-empty string`;
	if (
		"gloss" in e &&
		e.gloss !== null &&
		e.gloss !== undefined &&
		(typeof e.gloss !== "string" || !e.gloss.trim())
	)
		return `${where}.gloss is not a non-empty string`;
	return refSpellingError(e.kind, e.ref, where);
}

// lucmoseley/mantahostels#2535
/**
 * @param {string} kind
 * @param {string} ref
 * @param {string} where
 * @returns {string | null}
 */
function refSpellingError(kind, ref, where) {
	if (kind === "issue" && !/^\d+$/.test(ref))
		return `${where}.ref is ${JSON.stringify(ref)} — an issue reference is a bare number, no "#"`;
	if (kind === "glob" && !/[*/]$/.test(ref))
		return `${where}.ref is ${JSON.stringify(ref)} — a glob ends in "*" or "/"; a mid-string "*" matches nothing`;
	return null;
}

/**
 * @param {string} role
 * @returns {string | null}
 */
function roleError(role) {
	if (!role) return "--role is empty";
	if (/[\r\n]/.test(role))
		return "--role carries a line break, which splits its §A table row";
	const words = roleWordCount(role);
	if (words > ROLE_CAP_WORDS)
		return `--role is ${words} words, over the ${ROLE_CAP_WORDS}-word cap check-doc-map.js enforces`;
	return null;
}

/**
 * @param {string} route
 * @returns {string | null}
 */
function routeError(route) {
	if (!route) return "--route is empty";
	if (/[\r\n]/.test(route))
		return "--route carries a line break, which splits its §A table row";
	return null;
}

// lucmoseley/mantahostels#2500
/**
 * @param {string} dataFile
 * @param {Record<string, unknown>} sidecar
 */
function writeSidecar(dataFile, sidecar) {
	/** @type {Record<string, unknown>} */
	const sorted = {};
	for (const key of Object.keys(sidecar).sort()) sorted[key] = sidecar[key];
	fs.writeFileSync(dataFile, `${JSON.stringify(sorted, null, "\t")}\n`);
}

const VALUE_FLAGS = [
	"--class",
	"--section",
	"--qualifier",
	"--consumes",
	"--role",
	"--route",
	"--reader",
	"--data-file",
	"--release-cmd",
];

const USAGE =
	`usage: node ${scriptPath("register-doc.js")} <path> --class <token> --section <name> [--reader <token>] [--qualifier <text>] [--role <text>] [--route <text>]\n` +
	`       node ${scriptPath("register-doc.js")} <path> --role <text>\n` +
	`       node ${scriptPath("register-doc.js")} <path> --route <text>`;

/** @type {import("./lib/cli-args").CliSpec} */
const CLI = {
	usage: USAGE,
	flags: {
		...Object.fromEntries(VALUE_FLAGS.map((f) => [f, "value"])),
		"--claim-cmd": "value",
		"--new-section": "boolean",
		"--no-claim": "boolean",
	},
	max: 1,
};

const REGISTRATION_FLAGS = [
	"--class",
	"--section",
	"--qualifier",
	"--consumes",
	"--reader",
];

// lucmoseley/mantahostels#1848 lucmoseley/mantahostels#3376
/**
 * @param {(name: string) => string | null} value
 * @returns {boolean}
 */
function hasEveryValue(value) {
	for (const name of VALUE_FLAGS) {
		const v = value(name);
		if (v?.startsWith("--")) {
			console.error(
				`register-doc: ${name} was given "${v}", which is a flag, not a value. Its value is missing.`,
			);
			return false;
		}
	}
	return true;
}

/**
 * @param {(name: string) => string | null} value
 * @returns {{ role: string | null, route: string | null } | number}
 */
function readRoleAndRoute(value) {
	const rawRole = value("--role");
	const role = rawRole === null ? null : rawRole.trim();
	const roleFault = role === null ? null : roleError(role);
	if (roleFault) {
		console.error(`register-doc: ${roleFault}.`);
		return 1;
	}
	const rawRoute = value("--route");
	const route = rawRoute === null ? null : rawRoute.trim();
	const routeFault = route === null ? null : routeError(route);
	if (routeFault) {
		console.error(`register-doc: ${routeFault}.`);
		return 1;
	}
	return { role, route };
}

/**
 * @param {{ role: string | null, route: string | null }} fields
 * @param {(name: string) => string | null} value
 * @param {(name: string) => boolean} flag
 * @returns {boolean}
 */
function isFieldOnly({ role, route }, value, flag) {
	return (
		(role !== null || route !== null) &&
		!flag("--new-section") &&
		REGISTRATION_FLAGS.every((name) => value(name) === null)
	);
}

/**
 * @param {string} docPath
 * @param {(name: string) => string | null} value
 * @returns {{ cls: string, section: string } | number}
 */
function classAndSection(docPath, value) {
	const cls = value("--class");
	if (!cls || !VALID_CLASSES.includes(cls)) {
		console.error(
			`register-doc: ${docPath} needs a --class, one of: ${VALID_CLASSES.join(", ")}.` +
				(cls ? ` "${cls}" is not one of them.` : " None was given."),
		);
		return 1;
	}

	const section = value("--section");
	if (!section) {
		console.error(
			`register-doc: ${docPath} needs a --section — which §A subsection it renders under.`,
		);
		return 1;
	}
	return { cls, section };
}

/**
 * @param {string} docPath
 * @param {string | null} reader
 * @returns {boolean}
 */
function isReaderFit(docPath, reader) {
	if (isProseKey(docPath)) {
		if (reader && VALID_READERS.includes(reader)) return true;
		console.error(
			`register-doc: ${docPath} needs a --reader, one of: ${VALID_READERS.join(", ")}.` +
				(reader ? ` "${reader}" is not one of them.` : " None was given."),
		);
		return false;
	}
	if (reader === null) return true;
	console.error(
		`register-doc: ${docPath} is not a .md or .html document, so it takes no --reader.`,
	);
	return false;
}

/**
 * @param {string | null} consumesRaw
 * @returns {{ consumes: unknown } | number}
 */
function readConsumes(consumesRaw) {
	if (consumesRaw === null) return { consumes: null };
	let parsed;
	try {
		parsed = JSON.parse(consumesRaw);
	} catch (e) {
		console.error(
			`register-doc: --consumes is not valid JSON (${caught(e).message}).`,
		);
		return 1;
	}
	const shapeError = consumesShapeError(parsed);
	if (shapeError) {
		console.error(`register-doc: ${shapeError}`);
		return 1;
	}
	return { consumes: parsed };
}

/**
 * @param {string} section
 * @param {Set<string>} knownSections
 * @param {boolean} newSection
 * @returns {string | null}
 */
function unknownSectionError(section, knownSections, newSection) {
	if (knownSections.has(section)) return null;
	// lucmoseley/mantahostels#1848
	const fold = (/** @type {string} */ v) =>
		v.trim().toLowerCase().replace(/\s+/g, " ");
	const nearMiss = [...knownSections].find((k) => fold(k) === fold(section));
	if (nearMiss)
		return (
			`register-doc: "${section}" differs from the live subsection "${nearMiss}" only in case or spacing. ` +
			"Use that spelling; --new-section does not mint a second casing of one heading."
		);
	if (knownSections.size > 0 && !newSection)
		return (
			`register-doc: "${section}" is not one of §A's subsections. ` +
			"Pass --new-section to mint it deliberately, or use one of:\n  " +
			[...knownSections].sort().join("\n  ")
		);
	return null;
}

/**
 * @param {string} docPath
 * @param {string} section
 * @param {boolean} isNewSection
 */
function printOrphanPrompts(docPath, section, isNewSection) {
	// lucmoseley/mantahostels#3198
	if (isNewSection) {
		console.log(
			`\n"${section}" is a new §A subsection. Can a file under it carry an ` +
				"obligation — work, a decision or a constraint with a completion " +
				"condition? If it cannot, add it to ORPHAN_CHECK_EXEMPT in this " +
				"script. Until then it takes the orphan check below, which is the " +
				"safe default (mantahostels#3198).",
		);
	}
	if (!ORPHAN_CHECK_EXEMPT.has(section)) {
		console.log(
			`\nOrphan check owed (mantahostels#3198): "${section}" can carry an obligation. ` +
				`Read ${docPath} for a commitment — work, a decision or a constraint ` +
				"carrying a completion condition — that names no card and no issue. " +
				"Dispose of a hit in THIS session, never a queue (mantahostels#2748): a card " +
				"through roadmap-edit, a trigger line on the card that fires it " +
				"(mantahostels#3062), or the document's own gap line gaining its owner. A " +
				"not-carded ruling goes to the founder priced first. " +
				"docs/doc-map.md §A's preamble carries the rule.",
		);
	}
}

/**
 * @param {{ section: string, cls: string, qualifier: string | null, role: string | null, route: string | null, consumes: unknown, reader: string | null }} fields
 * @returns {Record<string, unknown>}
 */
function sidecarEntry({
	section,
	cls,
	qualifier,
	role,
	route,
	consumes,
	reader,
}) {
	return {
		section,
		class: cls,
		classQualifier: qualifier || null,
		role,
		route,
		consumes,
		...(reader === null ? {} : { reader }),
	};
}

/**
 * @param {string[]} argv
 * @returns {number}
 */
function main(argv) {
	const parsed = parseOrCode(argv, CLI);
	if (typeof parsed === "number") return parsed;
	const flag = (/** @type {string} */ name) => parsed.flags[name] === true;
	const value = (/** @type {string} */ name) =>
		flagValue(parsed.flags, name) ?? null;
	const docPath = parsed.positionals[0];
	if (!docPath) {
		console.error(USAGE);
		return 2;
	}

	if (!hasEveryValue(value)) return 2;

	const fields = readRoleAndRoute(value);
	if (typeof fields === "number") return fields;
	const { role, route } = fields;
	if (isFieldOnly({ role, route }, value, flag))
		return setFields(docPath, { role, route }, value, flag);

	const target = classAndSection(docPath, value);
	if (typeof target === "number") return target;
	const { cls, section } = target;

	const reader = value("--reader");
	if (!isReaderFit(docPath, reader)) return 1;

	const consumed = readConsumes(value("--consumes"));
	if (typeof consumed === "number") return consumed;
	const { consumes } = consumed;

	const opened = claimAndRead(docPath, value, flag);
	if (typeof opened === "number") return opened;
	const { dataFile, sidecar, refuse } = opened;

	if (Object.hasOwn(sidecar, docPath)) {
		console.error(
			`register-doc: ${docPath} is already registered. Set its role with ` +
				"`--role <text>` alone, or its route with `--route <text>` alone; " +
				"edit any other field in its sidecar key directly.",
		);
		return refuse(1);
	}

	const knownSections = new Set(
		Object.values(sidecar)
			.map((entry) => /** @type {{ section?: unknown }} */ (entry)?.section)
			.filter((s) => typeof s === "string"),
	);
	const sectionError = unknownSectionError(
		section,
		knownSections,
		flag("--new-section"),
	);
	if (sectionError) {
		console.error(sectionError);
		return refuse(1);
	}

	sidecar[docPath] = sidecarEntry({
		section,
		cls,
		qualifier: value("--qualifier"),
		role,
		route,
		consumes,
		reader,
	});

	writeSidecar(dataFile, sidecar);
	console.log(`registered ${docPath} as ${cls} under "${section}"`);

	printOrphanPrompts(
		docPath,
		section,
		flag("--new-section") && !knownSections.has(section),
	);
	return 0;
}

/**
 * @param {string} docPath
 * @param {(name: string) => string | null} value
 * @param {(name: string) => boolean} flag
 * @returns {number | { dataFile: string, sidecar: Record<string, any>, refuse: (code: number) => number }}
 */
function claimAndRead(docPath, value, flag) {
	/** @type {string | null} */
	let heldSubject = null;
	if (!flag("--no-claim")) {
		const subject = `${SIDECAR_PATH}#${ROW_PREFIX}${docPath}`;
		if (claimDataFile(subject, { claimCmd: value("--claim-cmd") }).claimed)
			heldSubject = subject;
	}

	/** @param {number} code */
	const refuse = (code) => {
		if (heldSubject) releaseClaim(heldSubject, value("--release-cmd"));
		return code;
	};

	// #4438
	const dataFile =
		value("--data-file") || path.join(worktreeRoot(), SIDECAR_PATH);
	try {
		const sidecar = JSON.parse(fs.readFileSync(dataFile, "utf8"));
		return { dataFile, sidecar, refuse };
	} catch (e) {
		console.error(
			`register-doc: could not read ${dataFile} (${caught(e).message})`,
		);
		return refuse(2);
	}
}

/**
 * @param {string} docPath
 * @param {{role: string | null, route: string | null}} fields
 * @param {(name: string) => string | null} value
 * @param {(name: string) => boolean} flag
 * @returns {number}
 */
function setFields(docPath, { role, route }, value, flag) {
	const opened = claimAndRead(docPath, value, flag);
	if (typeof opened === "number") return opened;
	const { dataFile, sidecar, refuse } = opened;

	const flagsGiven = [role !== null && "--role", route !== null && "--route"]
		.filter(Boolean)
		.join(" or ");
	if (!Object.hasOwn(sidecar, docPath)) {
		console.error(
			`register-doc: ${docPath} is not registered, so ${flagsGiven} alone has no key to set. ` +
				`Register it with --class and --section, passing ${flagsGiven} alongside.`,
		);
		return refuse(1);
	}

	if (role !== null) {
		const previous = sidecar[docPath].role;
		sidecar[docPath].role = role;
		console.log(`set the role of ${docPath} (${roleWordCount(role)} words)`);
		if (previous) console.log(`replaced: ${previous}`);
	}
	if (route !== null) {
		const previous = sidecar[docPath].route;
		sidecar[docPath].route = route;
		console.log(`set the route of ${docPath}`);
		if (previous) console.log(`replaced: ${previous}`);
	}
	writeSidecar(dataFile, sidecar);
	return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
