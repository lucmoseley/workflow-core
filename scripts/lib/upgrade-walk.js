/*
 * upgrade-walk.js — the walk from an adopter's pinned release to the
 * installed plugin, which upgrade.js, release-plugin.js and
 * lib/walk-and-commit.js run.
 *
 * A directory-sourced install (no tag, so no pin to walk from) is walked
 * too, on a different floor — decided at the `lowerBound` site below (#244).
 *
 * Every run, up to date or not, first brings each core-owned file to
 * `pluginRoot`'s form through `scripts/lib/core-owned-files.js` (#1501): the
 * hooks, helpers, rules file, settings keys, `.gitignore` block, context-cost
 * row and labels. So the git gates run the same core the guards do (#104,
 * #121), and a core-owned file added later reaches this adopter with no note.
 *
 * Every note's "## Manual steps" bullet a real run walks is recorded to
 * `.claude/workflow-core.json`'s `stepsOwed` — via `scripts/lib/steps-owed.js`,
 * this walker's only write to that field — once its note's own Verify has
 * passed, so a failed note's steps are never half-owed (#248). Discharging an
 * entry — clearing it, or declining a `choice` — is `scripts/steps-owed.js`'s
 * job, never this walker's; `docs/agents/adopter-upgrade.md` has the protocol.
 */

const fs = require("node:fs");
const path = require("node:path");
const { requiredGroup } = require("./regex-group.js");
const { runVerify } = require("./verify-run.js");
const { MIGRATIONS_DIR } = require("./workflow-core-config.js");
const { bringCoreFiles, readIfPresent } = require("./core-owned-files.js");
const { parseNote, parseSteps } = require("./migration-note.js");
const { skillDrift } = require("./skill-drift.js");
const { findPin } = require("./plugin-state.js");
const { readInstalledRecord } = require("./plugin-record.js");
const { appendStepsOwed } = require("./steps-owed.js");
const { formatConfigJson } = require("./config-json.js");
const { caught } = require("./caught.js");

/**
 * @param {string} v `v1.2.3` or `1.2.3`
 * @returns {[number, number, number]}
 */
function semver(v) {
	const [maj = 0, min = 0, pat = 0] = v
		.replace(/^v/, "")
		.split(".")
		.map((n) => Number.parseInt(n, 10));
	return [maj, min, pat];
}

/** @param {string} a @param {string} b */
function semverCompare(a, b) {
	const [am, ai, ap] = semver(a);
	const [bm, bi, bp] = semver(b);
	return am - bm || ai - bi || ap - bp;
}

/**
 * @param {string} root
 * @param {string} rel
 * @param {Record<string, unknown>} [fallback]
 * @returns {{path: string, json: Record<string, unknown>}}
 */
function readJson(root, rel, fallback = {}) {
	const at = path.join(root, rel);
	try {
		return { path: at, json: JSON.parse(fs.readFileSync(at, "utf8")) };
	} catch (err) {
		if (caught(err).code === "ENOENT") return { path: at, json: fallback };
		throw new Error(`${at} does not parse: ${caught(err).message}`, {
			cause: err,
		});
	}
}

/**
 * Every migration note shipped with the plugin, tag-ordered ascending.
 * @param {string} pluginRoot
 * @returns {{tag: string, file: string, text: string}[]}
 */
function loadNotes(pluginRoot) {
	const dir = path.join(pluginRoot, MIGRATIONS_DIR);
	if (!fs.existsSync(dir)) return [];
	return fs
		.readdirSync(dir)
		.filter((f) => /^v\d+\.\d+\.\d+\.md$/.test(f))
		.map((f) => ({
			tag: f.replace(/\.md$/, ""),
			file: path.join(dir, f),
			text: fs.readFileSync(path.join(dir, f), "utf8"),
		}))
		.sort((a, b) => semverCompare(a.tag, b.tag));
}

/**
 * Whether `note`'s own *Verify* command already passes against `root` — the
 * question "is this note's effect present here?", asked of a note the walk
 * would otherwise skip (#284).
 *
 * Reads the Verify command alone and ignores every other fault in the note: a
 * bullet the parser rejects says nothing about whether the note's effect is
 * present.
 *
 * ONLY A COMMAND THAT RAN AND EXITED NON-ZERO answers FALSE. A note with no
 * readable Verify, and one whose Verify could not be run at all — not found,
 * killed by a signal (a timeout included), output over `maxBuffer`, each
 * leaving node no numeric exit status — say so and answer TRUE, because
 * neither is evidence the note is unapplied.
 * @param {{tag: string, text: string}} note
 * @param {{root: string, out: (line: string) => void,
 *   env?: NodeJS.ProcessEnv, verifyTimeoutMs?: number}} at
 */
function verifyPasses(note, { root, out, env, verifyTimeoutMs }) {
	const parsed = parseNote(note.text);
	if (!parsed.verify) {
		out(`cannot probe ${note.tag} (no readable Verify) — leaving it skipped`);
		return true;
	}
	const result = runVerify(parsed.verify, {
		cwd: root,
		env,
		timeout: verifyTimeoutMs,
	});
	if (result.ok || result.status !== null) return result.ok;
	out(
		`cannot probe ${note.tag} (its Verify would not run: ${result.message}) — leaving it skipped`,
	);
	return true;
}

/**
 * Applies one note's *Residue* — idempotent: re-applying an already-applied
 * residue leaves every file byte-identical.
 * @param {{contract?: number, settingsKeys?: boolean, hookPaths?: boolean,
 *   labels?: boolean, ignoreBlock?: string[], roadmapMajorPin?: boolean}} residue
 * @param {{root: string, out: (line: string) => void}} at
 */
function applyResidue(residue, { root, out }) {
	if ("contract" in residue)
		applyContractResidue(residue.contract, { root, out });
	for (const key of EVERY_RUN) {
		if (residue[key]) out(`residue  ${key}: already brought current this run`);
	}
	if (residue.roadmapMajorPin) applyRoadmapMajorPinResidue({ root, out });
}

/* The residue keys `bringCoreFiles` now does on every run (#1501), still
 * valid in a note so a shipped one parses. */
const EVERY_RUN = /** @type {const} */ ([
	"settingsKeys",
	"hookPaths",
	"labels",
	"ignoreBlock",
]);

/**
 * @param {number|undefined} contract
 * @param {{root: string, out: (line: string) => void}} at
 */
function applyContractResidue(contract, { root, out }) {
	const { path: at, json } = readJson(root, ".claude/workflow-core.json");
	if (json.contract === contract) return;
	fs.writeFileSync(at, formatConfigJson({ ...json, contract }));
	out(`residue  contract -> ${contract}`);
}

/**
 * The `roadmapMajorPin` residue: backfills the pin from the roadmap's own
 * version line.
 * @param {{root: string, out: (line: string) => void}} at
 */
function applyRoadmapMajorPinResidue({ root, out }) {
	const { path: at, json: config } = readJson(
		root,
		".claude/workflow-core.json",
	);
	/* Already seeded — by init-adopter.js (#54) or a prior upgrade run —
	 * so left alone: re-deriving it here could disagree with a value the
	 * adopter has since hand-edited. */
	const owed =
		!("roadmapMajorPin" in config) &&
		Array.isArray(config.modules) &&
		config.modules.includes("roadmap");
	if (!owed) return;
	const htmlPath = path.join(root, "docs/reference-roadmap.html");
	const html = readIfPresent(htmlPath);
	/* Mirrors roadmap-edit/scripts/validate.js's own docmeta regex
	 * (the tripwire this pin feeds) rather than a looser spelling that
	 * could match an old version quoted in a card body. */
	const docmeta = /class="docmeta">v(\d+)\.(\d+)\s*·\s*updated ([^<]+)</;
	const m = html?.match(docmeta);
	if (!m) {
		out(
			`residue  roadmapMajorPin: ${htmlPath} is missing or carries no docmeta version line — leave unset, hand-add it (that file's own "v<major>.<minor> · updated" line names the major)`,
		);
		return;
	}
	const major = Number.parseInt(requiredGroup(m, 1, docmeta), 10);
	fs.writeFileSync(at, formatConfigJson({ ...config, roadmapMajorPin: major }));
	out(`residue  roadmapMajorPin backfilled from ${htmlPath} -> ${major}`);
}

/**
 * Walks `.claude/workflow-core.json`'s `walkedTo` (or the pin, where
 * `walkedTo` is absent) forward to the installed plugin, applying and
 * verifying each migration note between them. Never advances the pin, and
 * never materialises the plugin — that is wholly the reconciler's job.
 *
 * `ceiling` is the reconciler's seam (#249), never passed by the CLI. Left
 * `undefined`, the walk runs its ordinary course, up to the installed
 * plugin. Given a tag, the walk stops there instead — a bounded REPLAY of a
 * prefix already proven to verify, which is how the reconciler reproduces
 * "every note through the last one that verified" on a tree it has just
 * reset to clean, without knowing which files any single note touched (two
 * notes can rewrite the same `.gitignore` block or the same
 * `workflow-core.json`, so a per-note file-level discard cannot be exact).
 * Given `null`, no note is walked at all — for a first note that itself
 * failed Verify, where there is no earlier tag to replay through — and
 * `walkedTo` is left untouched rather than fabricated.
 *
 * `env` and `verifyTimeoutMs` reach every Verify this run shells out to —
 * the walk's own (below) and the one-shot probe's (`verifyPasses`) alike.
 * Left `undefined`, a Verify inherits this process's env and runs unbounded,
 * the ordinary CLI and reconciler behaviour (#300).
 *
 * `measureCore` seeds the core's missing row in the adopter's context-cost
 * table (#679), and `labels` syncs the tracker's labels (#1484). Left
 * `undefined`, neither calls out; the CLI and the reconciler pass real ones.
 * @param {{root: string, pluginRoot: string, dryRun?: boolean,
 *   out?: (line: string) => void, ceiling?: string|null,
 *   env?: NodeJS.ProcessEnv, verifyTimeoutMs?: number,
 *   measureCore?: import("./core-context-cost.js").Measurer,
 *   labels?: import("./core-owned-files.js").Labels}} at
 * @returns {{status: 0|1|2|3, reason?: string}} 0 up to date or fully
 *   upgraded; 1 a note is malformed or its Verify failed; 2 the installed
 *   plugin's manifest is wrong; 3 the pin is ahead of the installed plugin.
 *   upgrade.js exits with it.
 */
function upgrade({
	root,
	pluginRoot,
	dryRun = false,
	out = () => {
		/* silent unless a caller wants progress */
	},
	ceiling,
	env,
	verifyTimeoutMs,
	measureCore,
	labels,
}) {
	const read = readPluginManifest(pluginRoot);
	if (read.failure) return read.failure;
	const plugin = read.plugin;
	const installed = `v${plugin.version}`;

	reportForkDrift({ root, pluginRoot, out });

	const { json: settings } = readJson(root, ".claude/settings.json");
	const {
		marketplace,
		ref: pinned,
		source: pinnedSource,
	} = findPin(
		/** @type {import("./plugin-state.js").AdopterSettings} */ (settings),
		plugin.name,
	);

	refreshAdopterFiles({
		root,
		pluginRoot,
		dryRun,
		out,
		plugin,
		marketplace,
		pinnedSource,
		measureCore,
		labels,
	});

	if (pinned && semverCompare(pinned, installed) > 0) {
		return {
			status: 3,
			reason:
				`pin ${pinned} is ahead of the installed plugin ${installed} — ` +
				`install owes: re-materialise to ${pinned} (full recipe: ` +
				"materialisePlugin's JSDoc in scripts/lib/materialise-plugin.js)",
		};
	}

	const { notes, probedTags, walkCeiling } = planWalk({
		root,
		pluginRoot,
		out,
		ceiling,
		env,
		verifyTimeoutMs,
		installed,
		pinned,
		pinnedSource,
	});

	if (notes.length === 0)
		return finishWithoutNotes(walkCeiling, { root, dryRun, out });

	/* A PROBED NOTE NEVER FAILS THE RUN (#284): a probed note that is
	 * malformed, or whose Verify still fails once its residue has run, is
	 * reported and stepped over — a note whose residue no-ops while its
	 * Verify does not would otherwise exit 1 on every run thereafter,
	 * recoverable only by hand.
	 * An in-range note keeps the hard refusal. */
	for (const note of notes) {
		const failure = walkNote(note, {
			optional: probedTags.has(note.tag),
			root,
			dryRun,
			out,
			env,
			verifyTimeoutMs,
		});
		if (failure) return failure;
	}

	/* notes.length > 0 here, and `planWalk`'s filter only ever admits a note when
	 * walkCeiling is non-null, so this is reachable only with a real tag. */
	const reached = /** @type {string} */ (walkCeiling);
	if (!dryRun) advanceWalkedTo(root, reached);
	out(dryRun ? `would reach ${reached}` : `upgraded to ${reached}`);
	return { status: 0 };
}

/**
 * @param {string} pluginRoot
 * @returns {{plugin: {name: string, version: string}, failure: null} |
 *   {plugin: null, failure: {status: 2, reason: string}}}
 */
function readPluginManifest(pluginRoot) {
	try {
		return {
			plugin: JSON.parse(
				fs.readFileSync(
					path.join(pluginRoot, ".claude-plugin/plugin.json"),
					"utf8",
				),
			),
			failure: null,
		};
	} catch (err) {
		return {
			plugin: null,
			failure: {
				status: 2,
				reason: `${pluginRoot}/.claude-plugin/plugin.json: ${caught(err).message}`,
			},
		};
	}
}

/**
 * Every run reports fork drift, whether or not the plugin itself moved —
 * a fork can go stale against an already-installed version too (#7,
 * AC3; spec §Override model, story 19). Skipped, never refused, where the
 * config cannot be read — a mid-walk contract bump this run's own notes
 * are about to apply is exactly the case `readConfig` refuses, and drift
 * reporting is not what should stop an upgrade over that.
 * @param {{root: string, pluginRoot: string, out: (line: string) => void}} at
 */
function reportForkDrift({ root, pluginRoot, out }) {
	try {
		for (const { name, recordedFrom, drifted, reason } of skillDrift({
			root,
			pluginRoot,
		})) {
			if (reason) continue;
			if (drifted)
				out(
					`"${name}" is forked (recorded from ${recordedFrom}) and has drifted from the plugin's current copy — review the fork against .claude/skills/${name}/SKILL.md`,
				);
		}
	} catch {
		/* see above */
	}
}

/**
 * @param {{root: string, pluginRoot: string, dryRun: boolean,
 *   out: (line: string) => void, plugin: {name: string, version: string},
 *   marketplace: string|null,
 *   pinnedSource: import("./plugin-state.js").MarketplaceSource|null,
 *   measureCore?: import("./core-context-cost.js").Measurer,
 *   labels?: import("./core-owned-files.js").Labels}} at
 */
function refreshAdopterFiles({
	root,
	pluginRoot,
	dryRun,
	out,
	plugin,
	marketplace,
	pinnedSource,
	measureCore,
	labels,
}) {
	bringCoreFiles({
		root,
		pluginRoot,
		dryRun,
		out,
		record: readInstalledRecord({
			root,
			plugin,
			marketplace,
			source: pinnedSource,
		}),
		/* No pin, no settings keys: merging them would declare a marketplace
		 * with no source. */
		pin:
			marketplace && pinnedSource
				? { marketplace, source: pinnedSource, plugin: plugin.name }
				: null,
		measureCore,
		labels,
	});
}

/**
 * @param {{root: string, pluginRoot: string, out: (line: string) => void,
 *   ceiling?: string|null, env?: NodeJS.ProcessEnv, verifyTimeoutMs?: number,
 *   installed: string, pinned: string|null,
 *   pinnedSource: import("./plugin-state.js").MarketplaceSource|null}} at
 * @returns {{notes: {tag: string, file: string, text: string}[],
 *   probedTags: Set<string>, walkCeiling: string|null}}
 */
function planWalk({
	root,
	pluginRoot,
	out,
	ceiling,
	env,
	verifyTimeoutMs,
	installed,
	pinned,
	pinnedSource,
}) {
	/* A `directory`-sourced install (init-adopter.js's default, no
	 * `--marketplace-ref`) carries no tag at all — `findPin`'s `ref` stays
	 * `source.ref ?? null` for it, and nothing below ever writes one back, so
	 * no residue path can fabricate a pin here. */
	const isDirectorySourced = pinnedSource?.source === "directory";

	const walkedTo = readWalkedTo(root);
	/* The lower bound the walk resumes from, never the pin alone — a pin
	 * advanced past a stalled walk (the ordinary state once a note's Verify
	 * has failed and the founder has since consented further) must not read
	 * as "up to date" while notes between `walkedTo` and `installed` are
	 * still unapplied.
	 *
	 * A directory-sourced adopter with no `walkedTo` yet gets `installed`
	 * as its floor, DECIDED rather than derived (#244): walking every note
	 * ever cut, for lack of a tag to start from, would replay residue
	 * against a tree that may already carry it, with nothing recording what
	 * bootstrap already did.
	 *
	 * That floor stays `installed` AT THIS RUN even after #252, which only
	 * closes the path for a NEW adopter — init-adopter.js now writes
	 * `walkedTo` at the plugin version it actually bootstrapped from. A
	 * pre-existing adopter with no `walkedTo` recorded gets nothing derived
	 * here automatically; recovering it, where needed, is manual — the
	 * plugin's own git history cross-referenced against a bootstrap-time
	 * commit of the provenance line, in `.claude/workflow-core.md` before
	 * #2035 and `.claude/workflow-core.reference.md` since. #244's
	 * `installed`-at-first-run floor stands for that adopter instead,
	 * DECIDED rather than merely left unfixed (#252 AC3). */
	const firstSeenFloor = isDirectorySourced ? installed : pinned;
	/* Read as a tag: `inRange` and the probe below only compare against it
	 * where a pin or a directory floor stands behind it. */
	const lowerBound = /** @type {string} */ (walkedTo ?? firstSeenFloor);

	/* `ceiling === null` is the reconciler replaying a run whose very first
	 * note failed Verify: no earlier tag to walk through, so no note runs and
	 * `walkedTo` is left exactly as read, by `finishWithoutNotes`. */
	const bounded = ceiling !== undefined;
	const walkCeiling = ceiling === undefined ? installed : ceiling;

	const inRange =
		walkCeiling !== null && (pinned || isDirectorySourced)
			? loadNotes(pluginRoot).filter(
					(n) =>
						semverCompare(n.tag, lowerBound) > 0 &&
						semverCompare(n.tag, walkCeiling) <= 0,
				)
			: [];

	const probed = probeNotes({
		root,
		pluginRoot,
		out,
		env,
		verifyTimeoutMs,
		walkedTo,
		pinned,
		isDirectorySourced,
		lowerBound,
		walkCeiling,
	});

	const probedTags = new Set(probed.map((n) => n.tag));
	const notes = [...probed, ...inRange].sort((a, b) =>
		semverCompare(a.tag, b.tag),
	);

	if (!bounded && isDirectorySourced && walkedTo === null)
		reportDirectoryFloor(pluginRoot, installed, out);

	return { notes, probedTags, walkCeiling };
}

/**
 * @param {string} root
 * @returns {string|null} `.claude/workflow-core.json`'s `walkedTo`, where it
 *   holds a string
 */
function readWalkedTo(root) {
	const { json: wfConfig } = readJson(root, ".claude/workflow-core.json");
	return typeof (/** @type {any} */ (wfConfig).walkedTo) === "string"
		? /** @type {any} */ (wfConfig).walkedTo
		: null;
}

/**
 * The notes at or below the floor whose Verify fails here.
 *
 * A tag-pinned adopter with no `walkedTo` has its floor at the pin, so
 * every note at or below that pin reads as applied — true where the pin
 * was moved BY a run of this walker, and false where it was moved by
 * hand, which is the ordinary way an adopter takes a release (#284).
 *
 * So probe rather than assume. A note's *Verify* command answers in one
 * direction only: where it FAILS, the note was demonstrably never applied,
 * whatever the pin claims, and the note joins the walk. A pass proves less
 * than it looks — v1.1.1's Verify proves its config parses and says so
 * itself, not that its residue ran — so a note that passes stays skipped.
 * The error is one-sided by construction, and skipping is where the walk
 * already stood.
 *
 * ONE-SHOT, and narrower than it reads: the probe fires only where no
 * `walkedTo` is recorded, and every completed run records one. An adopter
 * that ran `upgrade` before this landed has its historically skipped notes
 * out of reach, and recovering one is still hand-writing `walkedTo`.
 *
 * THE PROBE RUNS UNDER `--dry-run` TOO, unlike the walk's own Verify in
 * `walkNote`, because a dry run's product is the list of notes it would
 * apply and that list cannot be built without asking. So a note's Verify
 * must only read: `scripts/lib/migration-note.js` requires one shell
 * command whose exit code proves the bump and forbids it nothing, and a
 * future one that wrote would write here, in a dry run, against a tree its
 * own residue has not reached.
 *
 * Left alone deliberately: a directory-sourced install, which #244 floored
 * at `installed` for a different reason — it has no tag to walk from, so a
 * failing probe there cannot distinguish "never applied" from "this tree
 * predates the note", and #252 AC3 decided that case stands.
 * @param {{root: string, pluginRoot: string, out: (line: string) => void,
 *   env?: NodeJS.ProcessEnv, verifyTimeoutMs?: number,
 *   walkedTo: string|null, pinned: string|null,
 *   isDirectorySourced: boolean, lowerBound: string,
 *   walkCeiling: string|null}} at
 * @returns {{tag: string, file: string, text: string}[]}
 */
function probeNotes({
	root,
	pluginRoot,
	out,
	env,
	verifyTimeoutMs,
	walkedTo,
	pinned,
	isDirectorySourced,
	lowerBound,
	walkCeiling,
}) {
	/* Semver-shaped pins only. `semverCompare` reads a SHA beginning with a
	 * digit as a version — `3f9a2c1` parses as 3.0.0 — and a branch name as
	 * NaN, so an unfixed ref would put notes on the wrong side of a floor that
	 * means nothing. #251 left that hole open on the in-range side; the probe
	 * does not widen it. */
	const pinIsTag =
		typeof pinned === "string" && /^v?\d+\.\d+\.\d+$/.test(pinned);

	const probed =
		walkedTo === null && pinIsTag && !isDirectorySourced && walkCeiling !== null
			? loadNotes(pluginRoot).filter(
					(n) =>
						semverCompare(n.tag, lowerBound) <= 0 &&
						/* The ceiling binds a probed note exactly as it binds an
						 * in-range one: the reconciler replays a half-way walk with
						 * `.claude/workflow-core.json` reset, so `walkedTo` reads
						 * null and the probe re-enters — and a probed note past the
						 * ceiling would walk past the tag that replay is bounded to. */
						semverCompare(n.tag, walkCeiling) <= 0 &&
						!verifyPasses(n, { root, out, env, verifyTimeoutMs }),
				)
			: [];
	if (probed.length > 0)
		out(
			`no walkedTo recorded and the pin ${lowerBound} claims ` +
				`${probed.map((n) => n.tag).join(", ")} applied, but their Verify ` +
				"fails here — applying them",
		);
	return probed;
}

/**
 * Names the notes a first-seen directory-sourced install treats as applied.
 * @param {string} pluginRoot
 * @param {string} installed
 * @param {(line: string) => void} out
 */
function reportDirectoryFloor(pluginRoot, installed, out) {
	const flooredPast = loadNotes(pluginRoot).filter(
		(n) => semverCompare(n.tag, installed) <= 0,
	);
	if (flooredPast.length > 0)
		out(
			`first sight of this directory-sourced install: floored at ${installed}, ` +
				`treating ${flooredPast.map((n) => n.tag).join(", ")} as already ` +
				"applied — read them by hand if this tree predates them",
		);
}

/**
 * Advances `walkedTo` past `tag` in `.claude/workflow-core.json` — the
 * walk's progress marker, never the pin. Advances only, never retreats — the
 * call site in `walkNote` says which note that rules out.
 * @param {string} root
 * @param {string} tag
 */
function advanceWalkedTo(root, tag) {
	const { path: at, json: current } = readJson(
		root,
		".claude/workflow-core.json",
	);
	const recorded = /** @type {{walkedTo?: unknown}} */ (current).walkedTo;
	if (typeof recorded === "string" && semverCompare(tag, recorded) <= 0) return;
	fs.writeFileSync(at, formatConfigJson({ ...current, walkedTo: tag }));
}

/**
 * @param {string|null} walkCeiling
 * @param {{root: string, dryRun: boolean, out: (line: string) => void}} at
 * @returns {{status: 0}}
 */
function finishWithoutNotes(walkCeiling, { root, dryRun, out }) {
	if (walkCeiling === null) {
		/* ceiling: null — see `upgrade`'s own JSDoc. */
		out("nothing verified");
		return { status: 0 };
	}
	/* Still records reaching `walkCeiling`, even with no note in between —
	 * otherwise a later bump's `lowerBound` falls back to a stale pin
	 * instead of resuming from here, and can silently skip a note that
	 * lands between this run and that one. */
	if (!dryRun) advanceWalkedTo(root, walkCeiling);
	out(`up to date at ${walkCeiling}`);
	return { status: 0 };
}

/**
 * Applies and verifies one note.
 * @param {{tag: string, file: string, text: string}} note
 * @param {{optional: boolean, root: string, dryRun: boolean,
 *   out: (line: string) => void, env?: NodeJS.ProcessEnv,
 *   verifyTimeoutMs?: number}} at
 * @returns {{status: 1, reason: string} | null} the run's failure, or null
 *   where the walk goes on
 */
function walkNote(note, { optional, root, dryRun, out, env, verifyTimeoutMs }) {
	const parsed = parseNote(note.text);
	if (parsed.faults.length > 0) {
		if (!optional)
			return {
				status: 1,
				reason: `${note.file} is malformed:\n  ${parsed.faults.join("\n  ")}`,
			};
		out(
			`skipping ${note.tag} — it is malformed:\n  ${parsed.faults.join("\n  ")}`,
		);
		return null;
	}
	out(`applying ${note.tag}`);
	if (!dryRun) applyResidue(parsed.residue ?? {}, { root, out });
	const steps = parsed.sections["Manual steps"]
		? parseSteps(parsed.sections["Manual steps"])
		: [];
	if (steps.length > 0) {
		out(`manual steps for ${note.tag}:\n${parsed.sections["Manual steps"]}`);
	}
	if (dryRun) return null;
	const result = runVerify(/** @type {string} */ (parsed.verify), {
		cwd: root,
		env,
		timeout: verifyTimeoutMs,
	});
	if (!result.ok) {
		if (!optional)
			return {
				status: 1,
				reason: `${note.tag} Verify failed (\`${parsed.verify}\`)${result.suffix}:\n${result.said}`,
			};
		out(
			`${note.tag} was applied but its Verify still fails${result.suffix} — stepping over it:\n${result.said}`,
		);
		return null;
	}
	out(`verified ${note.tag}`);
	/* Printed HERE, per note, rather than batched after the loop: a later
	 * note's own Verify failing must not swallow the commit-body record of
	 * an earlier note this same run already wrote to `stepsOwed` (#248). */
	if (steps.length > 0) recordStepsOwed(root, note.tag, steps, out);
	/* Advances past THIS note only — a later note failing leaves a
	 * re-run resuming there instead of re-verifying what already passed.
	 *
	 * A PROBED note is the exception and records nothing (#284): it sits at
	 * or below the pin, so writing it as the marker would leave an adopter
	 * whose walk then failed committed below its own pin — and the next run,
	 * seeing a marker, skips the probe and re-applies every note between
	 * that tag and the pin. Its progress is carried by the run completing. */
	if (!optional) advanceWalkedTo(root, note.tag);
	return null;
}

/**
 * @param {string} root
 * @param {string} tag
 * @param {ReturnType<typeof parseSteps>} steps
 * @param {(line: string) => void} out
 */
function recordStepsOwed(root, tag, steps, out) {
	appendStepsOwed(root, tag, steps);
	out("");
	out(
		`commit message body for ${tag} — paste verbatim (the permanent ` +
			"record that survives stepsOwed being cleared):",
	);
	for (const s of steps) out(`- [${s.type}] (${tag}) ${s.text}`);
}

module.exports = { upgrade };
