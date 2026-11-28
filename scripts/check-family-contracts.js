#!/usr/bin/env node

const path = require("node:path");
const { heresySpec } = require("./lib/heresy-scan.js");
const { runCheck } = require("./lib/check");
const { ISSUE_REF } = require("./lib/exempt-markers.js");
const { blankInert } = require("./lib/strip-comments.js");

/**
 * @typedef {import("./lib/heresy-scan.js").Program} Program
 * @typedef {import("./lib/heresy-scan.js").Site} Site
 */

const REGISTRATIONS = ["hooks/hooks.json", ".claude/settings.json"];
const TOP_LEVEL = /^scripts\/[^/]+$/;
const FAMILY = /^scripts\/(?:check|guard|generate|report)-/;
const OPENING_POINTER = new RegExp(String.raw`^//\s*${ISSUE_REF}\s*$`);
const RUN_CHECK = /\brunCheck\s*\(/;
const FILER =
	/\b(?:createIssue|fileOrRefresh|buildScriptFilerArgv|fileThrough)\s*\(/;
const FILER_PATH = /(?<!\bscriptPath\()(["'`])file-issue\.js\1/;
const ISSUE_CREATE = /(["'`])issue\1\s*,\s*(["'`])create\2/;
const ROOTED_PATH = /^(?:\$\{?\w+\}?\/|\.\/)?(scripts\/[^/]+)$/;

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

/**
 * @param {ReadonlyMap<string, string>} texts
 * @returns {Set<string>}
 */
const parseHookPrograms = (texts) =>
	new Set(
		[...texts.values()]
			.flatMap((text) => parseHookCommands(JSON.parse(text)))
			.flatMap((command) =>
				command.split(/\s+/).flatMap((token) => {
					const m = token.replace(/["']/g, "").match(ROOTED_PATH);
					return m?.[1] ? [m[1]] : [];
				}),
			),
	);

/** @param {string} source */
const hasOpeningPointer = (source) =>
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
 * @returns {Site[]}
 */
function findFirstSite(code, re) {
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
 * @param {(program: Program, rel: string, hooked: Set<string>) => Site[]} keeps
 * @returns {(program: Program, rel: string, hooked: Set<string> | undefined) => Site[]}
 */
const outsidePrefix = (prefix, keeps) => (program, rel, hooked) =>
	path.basename(rel).startsWith(prefix) || hasOpeningPointer(program.source)
		? []
		: keeps(program, rel, hooked ?? new Set());

/**
 * @param {string} prefix
 * @param {(program: Program, rel: string) => Site[]} breaks
 * @returns {(program: Program, rel: string) => Site[]}
 */
const insidePrefix = (prefix, breaks) => (program, rel) =>
	path.basename(rel).startsWith(prefix) && !hasOpeningPointer(program.source)
		? breaks(program, rel)
		: [];

/**
 * @param {string} contract
 * @param {string} prefix
 */
const buildMessage =
	(contract, prefix) => (/** @type {string} */ rel, /** @type {Site} */ site) =>
		`${rel}:${site.line} ${contract} with no \`${prefix}\` prefix and no opening bare #N. Fix: take the \`${prefix}\` prefix and that family's contract whole, or open the file with the bare #N of the issue ruling its departure (§N3, §G4).`;

/** @type {import("./lib/check").CheckSpec} */
const SPEC = heresySpec({
	name: "family-contracts",
	reads: { paths: REGISTRATIONS, parse: parseHookPrograms },
	include: (rel) => TOP_LEVEL.test(rel),
	breaches: [
		{
			tag: "FAMILY-HOOK",
			sites: outsidePrefix("guard-", (_program, rel, hooked) =>
				!FAMILY.test(rel) && hooked.has(rel)
					? [{ line: 1, text: "hook registration" }]
					: [],
			),
			message: buildMessage("runs as a registered hook", "guard-"),
		},
		{
			tag: "FAMILY-CHECK",
			sites: outsidePrefix("check-", ({ source }) =>
				findFirstSite(blankInert(source), RUN_CHECK),
			),
			message: buildMessage("gates through runCheck", "check-"),
		},
		{
			tag: "FAMILY-CHECK-OFF",
			sites: insidePrefix("check-", ({ source }) =>
				RUN_CHECK.test(blankInert(source))
					? []
					: [{ line: 1, text: "no runCheck" }],
			),
			message: (rel, site) =>
				`${rel}:${site.line} takes the \`check-\` prefix but never gates through runCheck, and opens with no bare #N. Fix: gate through runCheck and its five-outcome alphabet, or open the file with the bare #N of the issue ruling its departure (§N3, §N4, §G4).`,
		},
		{
			tag: "FAMILY-REPORT",
			sites: outsidePrefix("report-", ({ source, code }) => {
				const filer = findFirstSite(blankInert(source), FILER);
				if (filer.length > 0) return filer;
				const spawned = findFirstSite(code, FILER_PATH);
				return spawned.length > 0 ? spawned : findFirstSite(code, ISSUE_CREATE);
			}),
			message: buildMessage("files a GitHub issue", "report-"),
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
