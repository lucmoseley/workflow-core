#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { heresySpec } = require("./lib/heresy-scan.js");
const { runCheck } = require("./lib/check");
const { ISSUE_REF } = require("./lib/exempt-markers.js");
const { blankInert } = require("./lib/strip-comments.js");

const REGISTRATIONS = ["hooks/hooks.json", ".claude/settings.json"];
const TOP_LEVEL = /^scripts\/[^/]+$/;
const FAMILY = /^scripts\/(?:check|guard|generate|report)-/;
const OPENING_POINTER = new RegExp(String.raw`^//\s*${ISSUE_REF}\s*$`);
const RUN_CHECK = /\brunCheck\s*\(/;
const FILER = /\b(?:createIssue|fileOrRefresh|buildScriptFilerArgv)\s*\(/;
const ISSUE_CREATE = /(["'`])issue\1\s*,\s*(["'`])create\2/;
const ROOTED_PATH = /^(?:\$\{?\w+\}?\/|\.\/)?(scripts\/[^/]+)$/;

/** @type {Map<string, Set<string>>} */
const hookPrograms = new Map();

/**
 * @param {unknown} registration
 * @returns {string[]}
 */
function parseHookCommands(registration) {
	if (typeof registration !== "object" || registration === null) return [];
	const events = /** @type {{ hooks?: unknown }} */ (registration).hooks;
	if (typeof events !== "object" || events === null) return [];
	return Object.values(events).flatMap((groups) =>
		(Array.isArray(groups) ? groups : []).flatMap(
			(/** @type {{ hooks?: unknown }} */ group) =>
				(Array.isArray(group?.hooks) ? group.hooks : []).flatMap(
					(/** @type {{ command?: unknown }} */ hook) =>
						typeof hook?.command === "string" ? [hook.command] : [],
				),
		),
	);
}

/** @param {string} root */
function readHookPrograms(root) {
	const cached = hookPrograms.get(root);
	if (cached) return cached;
	const found = new Set(
		REGISTRATIONS.flatMap((rel) => {
			const at = path.join(root, rel);
			if (!fs.existsSync(at)) return [];
			return parseHookCommands(JSON.parse(fs.readFileSync(at, "utf8")));
		}).flatMap((command) =>
			command.split(/\s+/).flatMap((token) => {
				const m = token.replace(/["']/g, "").match(ROOTED_PATH);
				return m?.[1] ? [m[1]] : [];
			}),
		),
	);
	hookPrograms.set(root, found);
	return found;
}

/** @param {string} source */
const opensOnPointer = (source) =>
	OPENING_POINTER.test(
		source
			.split("\n")
			.find(
				(line, i) => line.trim() !== "" && !(i === 0 && line.startsWith("#!")),
			)
			?.trim() ?? "",
	);

/**
 * @param {string} code
 * @param {RegExp} re
 * @returns {import("./lib/heresy-scan.js").Site[]}
 */
function parseFirstSite(code, re) {
	const m = re.exec(code);
	if (!m) return [];
	return [
		{
			line: code.slice(0, m.index).split("\n").length,
			text: m[0].replace(/\s+/g, " "),
		},
	];
}

/**
 * @param {string} prefix
 * @param {(program: import("./lib/heresy-scan.js").Program, rel: string, root: string) => import("./lib/heresy-scan.js").Site[]} keeps
 * @returns {(program: import("./lib/heresy-scan.js").Program, rel: string, root: string) => import("./lib/heresy-scan.js").Site[]}
 */
const outsidePrefix = (prefix, keeps) => (program, rel, root) =>
	path.basename(rel).startsWith(prefix) || opensOnPointer(program.source)
		? []
		: keeps(program, rel, root);

/**
 * @param {string} contract
 * @param {string} prefix
 */
const message =
	(contract, prefix) =>
	(
		/** @type {string} */ rel,
		/** @type {import("./lib/heresy-scan.js").Site} */ site,
	) =>
		`${rel}:${site.line} ${contract} with no \`${prefix}\` prefix and no opening bare #N. Fix: take the \`${prefix}\` prefix and that family's contract whole, or open the file with the bare #N of the issue ruling its departure (§N3, §G4).`;

/** @type {import("./lib/check").CheckSpec} */
const SPEC = heresySpec({
	name: "family-contracts",
	reads: REGISTRATIONS,
	include: (rel) => TOP_LEVEL.test(rel),
	breaches: [
		{
			tag: "FAMILY-HOOK",
			sites: outsidePrefix("guard-", (_program, rel, root) =>
				!FAMILY.test(rel) && readHookPrograms(root).has(rel)
					? [{ line: 1, text: "hook registration" }]
					: [],
			),
			message: message("runs as a registered hook", "guard-"),
		},
		{
			tag: "FAMILY-CHECK",
			sites: outsidePrefix("check-", ({ source }) =>
				parseFirstSite(blankInert(source), RUN_CHECK),
			),
			message: message("gates through runCheck", "check-"),
		},
		{
			tag: "FAMILY-REPORT",
			sites: outsidePrefix("report-", ({ source, code }) => {
				const filer = parseFirstSite(blankInert(source), FILER);
				return filer.length > 0 ? filer : parseFirstSite(code, ISSUE_CREATE);
			}),
			message: message("files a GitHub issue", "report-"),
		},
	],
	finish(ctx, scanned) {
		for (const f of ctx.findings) ctx.say(`  ${f.message}`);
		return {
			okLine: `${scanned} top-level program(s), each keeping a family's contract under its prefix or its ruling issue.`,
			noun: "family-contract breach(es)",
		};
	},
});

module.exports = { SPEC };
if (require.main === module) runCheck(SPEC);
