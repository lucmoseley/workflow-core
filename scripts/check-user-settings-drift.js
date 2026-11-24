#!/usr/bin/env node

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { runCheck } = require("./lib/check");
const { worktreeRoot } = require("./lib/host-root");
const { coreRoot } = require("./lib/script-path");
const { readText } = require("./lib/file-read.js");
const { requiredGroup } = require("./lib/regex-group");
const {
	userSettingsSnapshotPath,
	USER_SETTINGS_SNAPSHOT_DEFAULT,
} = require("./lib/workflow-core-config");
const { caught } = require("./lib/caught.js");
const { isBurnMarkerOn } = require("./lib/burn-mode.js");
const { modeSettings } = require("./lib/model-table.js");
const { copyBlockPattern } = require("./lib/settings-copy");
const { trimEndRun } = require("./lib/trim-run.js");

/** @typedef {import("./lib/check").Ctx} Ctx */

const JSON_BLOCK = /```json\n([\s\S]*?)\n```/;
const COPIES = [
	{
		live: ["statusline.sh"],
		fence: "```bash",
		missingIsDrift: false,
		ruleSectionsCut: false,
	},
	{
		live: ["CLAUDE.md"],
		fence: "````markdown",
		missingIsDrift: true,
		ruleSectionsCut: true,
	},
];

const { MIRRORED_SECTIONS } = require("./lib/machine-mirrored-rules.js");
const PLUGIN_ROOT = coreRoot();
const CONTRACT = path.join("docs", "working-contract.md");
const SOURCED = [
	{
		live: ["hooks", "browser-profile-guard.sh"],
		source: path.join("scripts", "browser-profile-guard.sh"),
	},
	{
		live: ["hooks", "practice-guard.sh"],
		source: path.join("scripts", "practice-guard.sh"),
	},
	{
		live: ["practice-crafts.md"],
		source: path.join("docs", "practice-crafts.md"),
	},
];

/** @param {string} text */
const chunks = (text) => text.split(/(?=^## )/m);

const headingOf = (/** @type {string} */ chunk) =>
	chunk.startsWith("## ") ? chunk.slice(3).split("\n")[0] : null;

/**
 * @param {string} text
 * @param {string} heading
 */
function sectionBody(text, heading) {
	const chunk = chunks(text).find((c) => headingOf(c) === heading);
	return chunk === undefined
		? null
		: chunk
				.split("\n")
				.slice(1)
				.filter((l) => !l.startsWith("<!-- guard-registry"))
				.join("\n")
				.trim();
}

const withoutRuleSections = (/** @type {string} */ text) =>
	chunks(text)
		.filter((c) => !MIRRORED_SECTIONS.includes(headingOf(c) ?? ""))
		.join("");

/** @param {unknown} v */
const typeOf = (v) => {
	if (v === null) return "null";
	if (Array.isArray(v)) return "array";
	return typeof v;
};

/** @typedef {{side: string, lines: string[]}} Report */

/**
 * @param {any} a
 * @param {any} b
 * @param {string} at
 * @param {Report} out
 */
function diffObject(a, b, at, out) {
	for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
		const where = at ? `${at}.${k}` : k;
		if (!(k in a))
			out.lines.push(`${where}: missing from ${out.side}, present in live`);
		else if (k in b) diff(a[k], b[k], where, out);
		else out.lines.push(`${where}: present in ${out.side}, missing from live`);
	}
	return out.lines;
}

/**
 * @param {any} a
 * @param {any} b
 * @param {string} at
 * @param {Report} out
 */
function diffArray(a, b, at, out) {
	const n = Math.max(a.length, b.length);
	for (let i = 0; i < n; i++) {
		const where = `${at}[${i}]`;
		if (i >= a.length)
			out.lines.push(`${where}: only in live (${JSON.stringify(b[i])})`);
		else if (i >= b.length)
			out.lines.push(`${where}: only in ${out.side} (${JSON.stringify(a[i])})`);
		else diff(a[i], b[i], where, out);
	}
	return out.lines;
}

/**
 * @param {any} a
 * @param {any} b
 * @param {string} [at]
 * @param {Report} [out]
 * @returns {string[]}
 */
function diff(a, b, at = "", out = { side: "doc", lines: [] }) {
	const ta = typeOf(a);
	const tb = typeOf(b);

	if (ta !== tb) {
		out.lines.push(`${at || "(root)"}: ${out.side} has ${ta}, live has ${tb}`);
		return out.lines;
	}

	if (ta === "object") return diffObject(a, b, at, out);

	if (ta === "array") return diffArray(a, b, at, out);

	if (a !== b) {
		out.lines.push(
			`${at}: ${out.side} ${JSON.stringify(a)} ≠ live ${JSON.stringify(b)}`,
		);
	}
	return out.lines;
}

const ROUTED_KEYS = ["model", "modelSettings"];

/**
 * @param {Record<string, unknown>} o
 * @returns {[Record<string, unknown>, Record<string, unknown>]}
 */
const splitRouted = (o) => [
	Object.fromEntries(
		Object.entries(o).filter(([k]) => !ROUTED_KEYS.includes(k)),
	),
	Object.fromEntries(
		Object.entries(o).filter(([k]) => ROUTED_KEYS.includes(k)),
	),
];

/** @param {Ctx} ctx */
function snapshotAt(ctx) {
	if (ctx.args[0])
		return { docPath: ctx.args[0], docFile: ctx.args[0], declared: false };
	/** @type {string[]} */
	const refused = [];
	const docPath = userSettingsSnapshotPath({ say: (l) => refused.push(l) });
	if (refused.length > 0) ctx.broken(refused.join("\n"));
	return {
		docPath,
		docFile: path.join(worktreeRoot(), docPath),
		declared: docPath !== USER_SETTINGS_SNAPSHOT_DEFAULT,
	};
}

/**
 * @param {Ctx} ctx
 * @param {{ docPath: string, docFile: string, declared: boolean }} snapshot
 * @returns {{ doc: string, docJson: any }}
 */
function readSnapshot(ctx, { docPath, docFile, declared }) {
	if (!ctx.args[0] && !declared && !fs.existsSync(docFile))
		ctx.skip(`this repo has no ${docPath} — no settings snapshot to compare`);
	if (!fs.existsSync(docFile))
		ctx.broken(
			`${docPath} not found — the snapshot document is missing from the repo` +
				(declared
					? ", though userSettingsSnapshotPath in .claude/workflow-core.json names it."
					: "."),
		);

	const doc = fs.readFileSync(docFile, "utf8");

	const match = doc.match(JSON_BLOCK);
	if (!match)
		ctx.broken(
			`no \`\`\`json block found in ${docPath} — the snapshot is what this check exists to verify.`,
		);

	let docJson;
	try {
		docJson = JSON.parse(requiredGroup(match, 1, JSON_BLOCK));
	} catch (e) {
		ctx.broken(
			`the \`\`\`json block in ${docPath} is not valid JSON: ${caught(e).message}`,
		);
	}
	return { doc, docJson };
}

/**
 * @param {Ctx} ctx
 * @param {string} settingsPath
 * @returns {{ liveJson: any } | null}
 */
function readLive(ctx, settingsPath) {
	if (!fs.existsSync(settingsPath))
		ctx.skip(
			`${settingsPath} not found — nothing to compare against.\n` +
				"      Expected anywhere except the laptop that holds the live settings;\n" +
				"      this is not a failure. The snapshot's date remains its only signal.",
		);

	try {
		return { liveJson: JSON.parse(fs.readFileSync(settingsPath, "utf8")) };
	} catch (e) {
		const { message } = caught(e);
		ctx.warn(
			"LIVE-UNPARSEABLE",
			`${settingsPath} is not valid JSON: ${message}`,
		);
		ctx.say(`${settingsPath} is not valid JSON: ${message}`);
		return null;
	}
}

/**
 * @param {Ctx} ctx
 * @param {{ doc: string, docPath: string }} snapshot
 * @param {{ live: string[], fence: string, missingIsDrift: boolean, ruleSectionsCut: boolean }} copy
 * @returns {{ note: string, difference: string|null }}
 */
function compareCopy(
	ctx,
	{ doc, docPath },
	{ live, fence, missingIsDrift, ruleSectionsCut },
) {
	const livePath = path.join(os.homedir(), ".claude", ...live);
	const name = path.basename(livePath);
	const pattern = copyBlockPattern(name, fence);
	const found = doc.match(pattern);
	const markers = `\`<!-- BEGIN ${name} -->\` and \`<!-- END ${name} -->\` markers`;

	if (!found && !missingIsDrift)
		ctx.broken(
			`no ${name} block found in ${docPath} — expected between ${markers}.`,
		);

	const liveData = readOrBreak(ctx, livePath);
	if (liveData === null)
		return { note: `, ${name} absent (not compared)`, difference: null };

	if (!found)
		return {
			note: "",
			difference: `${name}: ${livePath} has no copy in ${docPath} — expected between ${markers}`,
		};

	const read = trimEndRun(liveData, "\n");
	const liveText = ruleSectionsCut
		? trimEndRun(withoutRuleSections(read), "\n")
		: read;
	const docText = requiredGroup(found, 1, pattern);
	if (docText === liveText)
		return {
			note: `, ${name} ${liveText.split("\n").length} lines`,
			difference: null,
		};

	const docLines = docText.split("\n");
	const liveLines = liveText.split("\n");
	const at = docLines.findIndex((l, i) => l !== liveLines[i]);
	const where =
		at === -1
			? `identical for the first ${Math.min(docLines.length, liveLines.length)} lines, then one side continues`
			: `first difference at line ${at + 1}`;
	return {
		note: "",
		difference:
			`${name}: doc copy differs from ${livePath} ` +
			`(doc ${docLines.length} lines, live ${liveLines.length}; ${where})`,
	};
}

/**
 * @param {Ctx} ctx
 * @param {string} file
 * @returns {string | null}
 */
function readOrBreak(ctx, file) {
	const read = readText(file);
	if (read.state === "unreadable")
		ctx.broken(
			`${file} is unreadable (${read.message}): restore it as a readable file, or move it aside, and re-run`,
		);
	return read.state === "read" ? read.data : null;
}

/**
 * @param {string} expected
 * @param {string} live
 */
function firstDifference(expected, live) {
	const a = expected.split("\n");
	const b = live.split("\n");
	const at = a.findIndex((l, i) => l !== b[i]);
	return at === -1
		? `identical for the first ${Math.min(a.length, b.length)} lines, then one side continues`
		: `first difference at line ${at + 1}`;
}

/**
 * @param {Ctx} ctx
 * @returns {{ note: string, differences: string[] }}
 */
function compareSourcedFiles(ctx) {
	const notes = [];
	const differences = [];
	for (const { live, source } of SOURCED) {
		const livePath = path.join(os.homedir(), ".claude", ...live);
		const name = path.basename(livePath);
		const want = readOrBreak(ctx, path.join(PLUGIN_ROOT, source));
		const got = readOrBreak(ctx, livePath);
		if (want === null || got === null) {
			notes.push(`, ${name} not compared`);
			continue;
		}
		if (want === got) notes.push(`, ${name} equal to ${source}`);
		else
			differences.push(
				`${name}: ${livePath} differs from ${source} (${firstDifference(want, got)})`,
			);
	}
	return { note: notes.join(""), differences };
}

/**
 * @param {Ctx} ctx
 * @returns {{ note: string, differences: string[] }}
 */
function compareRuleSections(ctx) {
	const claudeMd = path.join(os.homedir(), ".claude", "CLAUDE.md");
	const liveText = readOrBreak(ctx, claudeMd);
	const contract = readOrBreak(ctx, path.join(PLUGIN_ROOT, CONTRACT));
	if (liveText === null || contract === null)
		return { note: ", working rules not compared", differences: [] };
	const differences = [];
	for (const heading of MIRRORED_SECTIONS) {
		const want = sectionBody(contract, heading);
		const got = sectionBody(liveText, heading);
		if (want === null)
			ctx.broken(
				`${CONTRACT} has no "## ${heading}" section, which MIRRORED_SECTIONS names`,
			);
		if (got === null)
			differences.push(
				`CLAUDE.md: ${claudeMd} has no "## ${heading}" section, which ${CONTRACT} words`,
			);
		else if (got !== want)
			differences.push(
				`CLAUDE.md: "## ${heading}" differs from ${CONTRACT}'s (${firstDifference(want, got)})`,
			);
	}
	return {
		note: differences.length > 0 ? "" : `, working rules equal to ${CONTRACT}`,
		differences,
	};
}

/** @type {import("./lib/check.js").CheckSpec} */
const SPEC = {
	name: "user-settings-drift",
	usage:
		"node check-user-settings-drift.js [--warn] [<doc.md>] [<settings.json>]",
	run(/** @type {Ctx} */ ctx) {
		const { docPath, docFile, declared } = snapshotAt(ctx);
		const settingsPath =
			ctx.args[1] || path.join(os.homedir(), ".claude", "settings.json");

		const { doc, docJson } = readSnapshot(ctx, { docPath, docFile, declared });

		const live = readLive(ctx, settingsPath);
		if (live === null) return { noun: "unreadable live settings file" };
		const { liveJson } = live;
		const burn = isBurnMarkerOn(process.env);

		const [liveRest, liveRouted] = splitRouted(liveJson);
		let routedDiffs;
		try {
			routedDiffs = diff(modeSettings(burn), liveRouted, "", {
				side: "routing file",
				lines: [],
			});
		} catch (e) {
			ctx.broken(`the routing file will not load: ${caught(e).message}`);
		}
		const [docRest, docRouted] = splitRouted(docJson);
		const settingsDiffs = [
			...Object.keys(docRouted).map(
				(k) => `${k}: present in doc, which leaves it to the routing file`,
			),
			...diff(docRest, liveRest),
			...routedDiffs,
		];

		const copies = COPIES.map((sc) => compareCopy(ctx, { doc, docPath }, sc));
		const files = compareSourcedFiles(ctx);
		const rules = compareRuleSections(ctx);
		const copyNote =
			copies.map((sc) => sc.note).join("") + files.note + rules.note;
		const differences = [
			...settingsDiffs,
			...copies.flatMap((sc) =>
				sc.difference === null ? [] : [sc.difference],
			),
			...files.differences,
			...rules.differences,
		];

		for (const d of differences) ctx.fail("DRIFT", d);

		if (differences.length > 0) {
			ctx.say(
				`${docPath} has drifted from ${settingsPath} — ` +
					`${differences.length} difference(s):\n`,
			);
			for (const d of differences) ctx.say(`  - ${d}`);
			ctx.say(
				"\nFor settings.json and the fenced files the live files are the source of truth.\n" +
					"Re-copy ~/.claude/settings.json into the ```json block, leaving out `model` and\n" +
					"`modelSettings`, which the routing file owns (run scripts/burn-mode.sh for the\n" +
					"current mode to re-apply them), and each file into its own block, from\n" +
					`${COPIES.map((sc) => `~/.claude/${sc.live.join("/")}`).join(", ")} (CLAUDE.md less its\n` +
					`${MIRRORED_SECTIONS.map((h) => `"${h}"`).join(", ")} sections),\n` +
					"then re-date the snapshot line; never edit a block to change behaviour.\n" +
					"For the shipped files and those sections the repo is the source: copy\n" +
					`${SOURCED.map((sc) => `${sc.source} to ~/.claude/${sc.live.join("/")}`).join(", ")},\n` +
					`and each section from ${CONTRACT}. See docs/doc-map.md §A.`,
			);
		}

		return {
			okLine: `${docPath} matches ${settingsPath} (${
				Object.keys(liveJson).length
			} top-level keys${copyNote}).`,
			noun: "difference(s) between the snapshot and the live settings",
			data: { differences, docPath, settingsPath },
		};
	},
};

module.exports = { SPEC };
if (require.main === module) runCheck(SPEC);
