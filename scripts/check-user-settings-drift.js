#!/usr/bin/env node
/*
 * check-user-settings-drift.js — local guard that the settings snapshot
 * (`userSettingsSnapshotPath`, else docs/claude-user-settings.md) still matches
 * the live ~/.claude/settings.json, and its file copies the live files under
 * ~/.claude (COPIES below: #1547, #2174, #2322, #2324).
 *
 * Usage:
 *   node check-user-settings-drift.js [--warn] [<doc.md>] [<settings.json>]
 *   (defaults: `userSettingsSnapshotPath` in .claude/workflow-core.json, else
 *   docs/claude-user-settings.md, under the host root;  ~/.claude/settings.json)
 *
 * Why this is not a CI job. The source of truth lives OUTSIDE the repository,
 * is not version-controlled, and exists on exactly one laptop. A CI runner has
 * no ~/.claude/settings.json to compare against, so a CI job here could only
 * ever skip while showing green, which reads as coverage it is not.
 *
 * A snapshot that has silently drifted is worse than none: it will be trusted
 * to restore settings it no longer describes.
 *
 * The settings comparison is semantic, not textual — both sides are parsed and
 * compared as JSON, so key order and indentation never register as drift. Only a
 * real difference in settings does. The file copies compare as text. `model`
 * and `modelSettings` are compared against the routing file's current mode
 * (burn per its marker), never the snapshot, which leaves them out: burn mode
 * writes them on every switch (ROUTED_KEYS below).
 *
 * MISSING SOURCE IS NOT A FAILURE. ~/.claude/settings.json lives outside the
 * repo, so its absence SKIPs at exit 0. Absence of the DOC, or a doc whose JSON
 * block will not parse, is BROKEN at exit 2 — the doc is tracked, so that is a
 * repo-side problem visible everywhere. The asymmetry is the SKIP/BROKEN rule in
 * scripts/lib/check.js, not a special case (mantahostels#155 — the checker family's
 * exit-code and severity model — decision 6).
 *
 * Those BROKEN paths keep hard-blocking every commit from .husky/pre-commit;
 * --warn covers real drift only and cannot cap them. If that is ever unwanted,
 * the fix is `|| true` at the hook.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { runCheck } = require("./lib/check");
const { hostRoot } = require("./lib/host-root");
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
// The outside-the-repo files under ~/.claude that the settings call or a
// session reads. A doc missing a block added after the first is DRIFT, not BROKEN:
// a snapshot predating it, as an adopter's declared copy can, would otherwise
// block its every commit. The Markdown fences are four backticks, so a ``` fence
// inside the file cannot close them (#2174).
const COPIES = [
	{ live: ["statusline.sh"], fence: "```bash", missingIsDrift: false },
	{
		live: ["hooks", "browser-profile-guard.sh"],
		fence: "```bash",
		missingIsDrift: true,
	},
	{
		live: ["hooks", "practice-guard.sh"],
		fence: "```bash",
		missingIsDrift: true,
	},
	{ live: ["CLAUDE.md"], fence: "````markdown", missingIsDrift: true },
	{ live: ["practice-crafts.md"], fence: "````markdown", missingIsDrift: true },
];

/** @param {unknown} v */
const typeOf = (v) => {
	if (v === null) return "null";
	if (Array.isArray(v)) return "array";
	return typeof v;
};

/**
 * @typedef {{side: string, lines: string[]}} Report diff()'s accumulator: what
 *   the first side is called in a line, and each differing leaf's line
 */

/**
 * diff() over two objects. `any` for the reason diff() gives: both sides are
 * arbitrary parsed JSON.
 * @param {any} a
 * @param {any} b
 * @param {string} at
 * @param {Report} out accumulator: each differing leaf's line is pushed to `lines`; `side` names the expected side
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
 * diff() over two arrays. `any` for the reason diff() gives: both sides are
 * arbitrary parsed JSON.
 * @param {any} a
 * @param {any} b
 * @param {string} at
 * @param {Report} out accumulator: each differing leaf's line is pushed to `lines`; `side` names the expected side
 */
function diffArray(a, b, at, out) {
	// Order matters in these settings (deny lists are read as ordered), so
	// compare positionally rather than as sets.
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
 * Collect every leaf path where the two structures differ.
 *
 * Both sides are arbitrary parsed JSON, so `any`: typeOf() returns a string
 * tag, which narrows neither side for diffObject() and diffArray().
 *
 * @param {any} a  the expected side — the doc's snapshot, or the routing file's writes — at this level
 * @param {any} b  the live settings, at this level
 * @param {string} [at]  dotted path to this level, for the report
 * @param {Report} [out]  accumulator: each differing leaf's line is pushed to `lines`; `side` names the expected side
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

// The keys the routing file owns (see the header).
const ROUTED_KEYS = ["model", "modelSettings"];

/**
 * @param {Record<string, unknown>} o
 * @returns {[Record<string, unknown>, Record<string, unknown>]} the rest, and the routed keys present
 */
const splitRouted = (o) => [
	Object.fromEntries(
		Object.entries(o).filter(([k]) => !ROUTED_KEYS.includes(k)),
	),
	Object.fromEntries(
		Object.entries(o).filter(([k]) => ROUTED_KEYS.includes(k)),
	),
];

/**
 * Where the snapshot is read. An explicit argument is taken from the working
 * directory; otherwise the host's declaration, under its root (#447). A
 * declaration the reader refuses, or a config that will not read, is BROKEN
 * rather than a fall back to the default, which would SKIP.
 * @param {Ctx} ctx
 */
function snapshotAt(ctx) {
	if (ctx.args[0])
		return { docPath: ctx.args[0], docFile: ctx.args[0], declared: false };
	/** @type {string[]} */
	const refused = [];
	const docPath = userSettingsSnapshotPath({ say: (l) => refused.push(l) });
	if (refused.length > 0) ctx.broken(refused.join("\n"));
	return {
		docPath,
		docFile: path.join(hostRoot(), docPath),
		declared: docPath !== USER_SETTINGS_SNAPSHOT_DEFAULT,
	};
}

/**
 * The doc and its parsed JSON-fenced snapshot block, BROKEN where either is
 * missing or the block will not parse; SKIP where this repo keeps no snapshot.
 * `docJson` is `any` for the reason diff() gives: arbitrary parsed JSON.
 * @param {Ctx} ctx
 * @param {{ docPath: string, docFile: string, declared: boolean }} snapshot
 * @returns {{ doc: string, docJson: any }}
 */
function readSnapshot(ctx, { docPath, docFile, declared }) {
	// The snapshot is machine-level and kept by one repo; every other adopter
	// has none by default (mantahostels#3515 F3, #2).
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

	// The doc carries more than one fenced block (a bash re-copy hint, plus the
	// snapshot). Take the ```json one specifically rather than the first fence.
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
 * The live settings, parsed; null where the file will not parse, which is
 * raised and said here. `liveJson` is `any` for the reason diff() gives:
 * arbitrary parsed JSON.
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
		/* The live file being broken is a real problem, but it lives outside the
		 * repo and is not this repo's to fail over — an intrinsic WARN, so it is
		 * reported loudly and the exit code stays 0. */
		ctx.warn(
			"LIVE-UNPARSEABLE",
			`${settingsPath} is not valid JSON: ${message}`,
		);
		ctx.say(`${settingsPath} is not valid JSON: ${message}`);
		return null;
	}
}

/**
 * One file against its doc copy: the ok line's note, and the difference
 * where there is one.
 *
 * Textual compare, not semantic: a shell script's or Markdown file's
 * whitespace is not free.
 * @param {Ctx} ctx
 * @param {{ doc: string, docPath: string }} snapshot
 * @param {{ live: string[], fence: string, missingIsDrift: boolean }} copy
 * @returns {{ note: string, difference: string|null }}
 */
function compareCopy(ctx, { doc, docPath }, { live, fence, missingIsDrift }) {
	const livePath = path.join(os.homedir(), ".claude", ...live);
	const name = path.basename(livePath);
	const pattern = copyBlockPattern(name, fence);
	const found = doc.match(pattern);
	const markers = `\`<!-- BEGIN ${name} -->\` and \`<!-- END ${name} -->\` markers`;

	if (!found && !missingIsDrift)
		ctx.broken(
			`no ${name} block found in ${docPath} — expected between ${markers}.`,
		);

	if (!fs.existsSync(livePath))
		return { note: `, ${name} absent (not compared)`, difference: null };

	if (!found)
		return {
			note: "",
			difference: `${name}: ${livePath} has no copy in ${docPath} — expected between ${markers}`,
		};

	const liveText = trimEndRun(fs.readFileSync(livePath, "utf8"), "\n");
	const docText = requiredGroup(found, 1, pattern);
	if (docText === liveText)
		return {
			note: `, ${name} ${liveText.split("\n").length} lines`,
			difference: null,
		};

	const docLines = docText.split("\n");
	const liveLines = liveText.split("\n");
	// findIndex returns -1 when every shared line matches and one side
	// simply has more — report that as a length difference, not "line 0".
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

runCheck({
	name: "user-settings-drift",
	usage:
		"node check-user-settings-drift.js [--warn] [<doc.md>] [<settings.json>]",
	run(/** @type {Ctx} */ ctx) {
		const { docPath, docFile, declared } = snapshotAt(ctx);
		const settingsPath =
			ctx.args[1] || path.join(os.homedir(), ".claude", "settings.json");

		// --- Read the doc's snapshot block ---------------------------------------

		const { doc, docJson } = readSnapshot(ctx, { docPath, docFile, declared });

		// --- Read the live settings ----------------------------------------------

		const live = readLive(ctx, settingsPath);
		if (live === null) return { noun: "unreadable live settings file" };
		const { liveJson } = live;
		const burn = isBurnMarkerOn(process.env);

		// --- Compare --------------------------------------------------------------

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

		// --- Compare the file copies -----------------------------------------------

		const copies = COPIES.map((sc) => compareCopy(ctx, { doc, docPath }, sc));
		const copyNote = copies.map((sc) => sc.note).join("");
		const differences = [
			...settingsDiffs,
			...copies.flatMap((sc) =>
				sc.difference === null ? [] : [sc.difference],
			),
		];

		for (const d of differences) ctx.fail("DRIFT", d);

		if (differences.length > 0) {
			// No severity prefix: check.js owns the one `SEVERITY:` line a run emits,
			// and it is the thing that knows whether --warn demoted this.
			ctx.say(
				`${docPath} has drifted from ${settingsPath} — ` +
					`${differences.length} difference(s):\n`,
			);
			for (const d of differences) ctx.say(`  - ${d}`);
			ctx.say(
				"\nThe live files are the source of truth. Re-copy ~/.claude/settings.json into\n" +
					"the ```json block, leaving out `model` and `modelSettings`, which the routing\n" +
					"file owns (run scripts/burn-mode.sh for the current mode to re-apply them),\n" +
					"and each file into its own block, from\n" +
					`${COPIES.map((sc) => `~/.claude/${sc.live.join("/")}`).join(", ")},\n` +
					"then re-date the snapshot line; never edit a block to change behaviour.\n" +
					"See docs/doc-map.md §A.",
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
});
