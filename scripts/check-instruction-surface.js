#!/usr/bin/env node
/*
 * check-instruction-surface.js — is the instruction-surface census still true
 * of the tree, and which of its behavioural verdicts have gone unverified?
 *
 * Usage:
 *   node check-instruction-surface.js [--root <dir>] [--baseline <file>]
 *                                     [--threshold <pct>] [--json] [--warn]
 *   node check-instruction-surface.js --rebaseline [--root <dir>] [--baseline <file>]
 *                                     [--at <rev>] [--no-claim] [--only <key>[,<key>...]]
 *   node check-instruction-surface.js --touched-by <rev> [--root <dir>] [--baseline <file>]
 *
 * https://github.com/lucmoseley/workflow-core-tracker/blob/0a69e0d4be03/docs/research/instruction-surface-census.md (mantahostels#1716) counted four surfaces —
 * the always-loaded pool's rules, hook entries, rule-carrying scripts and skill
 * directories.
 *
 * THE SPLIT (mantahostels#1771's first call). The counts are mechanical and are
 * RE-RUN on every daily repo-checks run. The per-rule "does anything print this
 * at the moment of need" verdict is behavioural per mantahostels#886 — it needs a crafted
 * payload fed to a real guard — and is far too expensive for a cadence, so it is
 * REFRESHED ON CHANGE instead: every measured source is anchored by content
 * digest, and a digest that moves says the verdict taken against it is no longer
 * evidence.
 * A guard's digest hashes its code, not its comments (#1876), the rule files
 * it prints from (#1914, #3011) and the core a Node wrapper composes (#3129):
 * lib/census-digest.js.
 *
 * HOOK COMMAND TEXT IS A THIRD, MECHANICAL CHECK (mantahostels#1923): `hookCounts` below
 * only compares entry counts, so a flag added to a live command (mantahostels#1899) can
 * drift for months with nothing to catch it. `readHookCommands` anchors each
 * entry's full command line — `command` and the exec form's `args` joined
 * (mantahostels#2301) — in the anchors file's `hookCommands` section,
 * keyed by `buildHookKey`.
 *
 * NOT A SECOND check-guard-registry.js. That one asks whether the RULE SENTENCE
 * in CLAUDE.md still describes its guard, and anchors in
 * guard-registry-anchors.json. This asks whether the CENSUS'S MEASUREMENT of
 * what that guard prints still holds. A shared anchor file would clear one
 * question by answering the other.
 *
 * READS HEAD, NOT THE WORKING TREE, so a neighbour's half-saved guard is not
 * reported as a verdict expiring. Residual: a change that is committed but not
 * yet pushed reads the same as any other, and an untracked file falls back to
 * disk — never an untracked skill or settings file, which a git repo reads at
 * the revision alone (#1977, #2052).
 *
 * --touched-by NAMES THE ROWS ONE COMMIT EXPIRED (#1810), for .husky/post-commit,
 * so the session holding the change is the one told — a commit to a rule file a
 * guard prints from included (#1914). It reads no count, pool or hook command,
 * so a commit pays one diff-tree and a `git show` or two per guard it touched,
 * plus one read of every guard where it touched a rule file. Each read runs
 * inside lib/git-ceiling.js's ceiling (#2210): a read that hangs ends the run
 * BROKEN, naming it, and one starting past NOTICE_MS is named on stderr.
 *
 * WARN-ONLY, ALWAYS. Every finding here reads "go and re-measure", which no
 * commit can discharge and no session should be blocked on — check-suite-size-
 * drift.js's ruling, for the same reason (mantahostels#954).
 *
 * WHY THE POOL GETS A THRESHOLD AND THE GUARDS DO NOT. CLAUDE.md changes most
 * days, so a digest anchor on it would sit warning permanently and teach the
 * reader to skip the gate (mantahostels#155's severity model). What the census took over the
 * pool is a rule inventory with line citations, and that survives a typo fix;
 * DEFAULT_THRESHOLD_PCT is the judgement, set at mantahostels#1771, about when it does not.
 * A guard has one row and one verdict, so any edit is worth naming.
 *
 * IMPLICIT:  in the daily repo-checks run, re-counts the four surfaces the instruction-surface census measured and names the census rows whose evidence has expired, plus any live hook command the census never anchored at all (mantahostels#2648). It refuses nothing.
 * JUSTIFIED: fail-safe — the census going stale is silent, and the cost of a spurious warning is one line in the daily run's output.
 * DEFEAT:    convenience — a bare --rebaseline re-anchors everything without re-measuring anything, so a session can clear every finding it was meant to act on. Nothing detects that. --only <key>[,<key>...] (mantahostels#2105) narrows this to the named guards/hookCommands/poolFiles rows, and the `hooks` or `skills` count where named (#1879), alone — every other row is left exactly as it was, so a scoped re-anchor cannot silently clear a finding it did not name. A key naming no row is refused (BROKEN), never a silent no-op — except a live hook-command key, which a HOOK-COMMAND-NEW finding needs and which has no baseline row by definition (mantahostels#2648).
 */

const { gitOutcome } = require("./lib/git.js");
const fs = require("node:fs");
const path = require("node:path");
const {
	DEFAULT_ANCHORS,
	DigestUnavailable,
	readCommittedBytes,
	digestOf,
	guardsChangedBy,
} = require("./lib/census-digest");
const {
	brokenError,
	readCommitOrBroken,
	runCheck,
	errMessage,
} = require("./lib/check");
const { readObjectBatch, listTree } = require("./lib/git-objects");
const { GIT_MODE } = require("./lib/git-mode.js");
const { claimDataFile } = require("./lib/doc-map-generator");
const {
	readOwnHookSources,
	readOwnHooks,
	ownHooksFile,
} = require("./lib/core-hooks.js");
const { CeilingPassed } = require("./lib/git-ceiling.js");
const {
	TOUCHED_BY_CEILING_MS,
	readTouchedBy,
	touchedByCeiling,
} = require("./lib/touched-by.js");
const { buildHookCommandLine } = require("./lib/rule-emission");

/** @typedef {{ digest: string, verdict: string, selfSufficient?: string, source?: string }} GuardAnchor */
/** @typedef {{ total: number, byEvent: Record<string, number> }} HookCounts */
/** @typedef {{ distinct: number, own: number, vendored: number, disabled: number }} SkillCounts */
/** @typedef {{ link: boolean, text: string | null }} SkillEntry */

/*
 * Percent of a pool file's bytes, either direction, at which the census's rule
 * inventory over that file stops being evidence. A judgement (mantahostels#1771), not a
 * measurement. SHRINKAGE COUNTS TOO — a rule shed is a row that no longer
 * exists.
 */
const DEFAULT_THRESHOLD_PCT = 10;

/**
 * The sections that are one count apiece, which --only names whole (#1879).
 *
 * @type {Record<string, (root: string, rev: string | undefined) => object>}
 */
const COUNTERS = {
	hooks: (root, rev) => hookCountsPlain(root, rev),
	skills: (root, rev) => skillCounts(root, rev),
};

/** The baseline's sections, each BROKEN by its absence rather than skipped. */
const REQUIRED_SECTIONS = [
	"poolFiles",
	"poolRules",
	"hooks",
	"hookCommands",
	"skills",
	"guards",
];

/**
 * @param {string} file
 * @returns {string | null}
 */
function readIfPresent(file) {
	try {
		return fs.readFileSync(file, "utf8");
	} catch {
		return null;
	}
}

/**
 * Both halves of a census verdict, always together.
 *
 * TIMING AND SUFFICIENCY ARE SEPARATE FINDINGS, and quoting either alone
 * misrepresents the census: the `guard-issue-create-label` core fires `at need` and
 * still sheds 0 B, which the census's join table records as a DOWNGRADE to
 * insufficient. A message carrying the timing verdict on its own reads as a
 * guard confirmed to work.
 *
 * @param {GuardAnchor} anchor
 * @returns {string}
 */
const verdictOf = (anchor) =>
	`timing "${anchor.verdict}", self-sufficient "${anchor.selfSufficient ?? "unrecorded"}"`;

/**
 * Where `root`'s hooks are read: at `rev`, or from disk where `root` is no git
 * repo (#2052).
 * @param {string} root
 * @param {string} [rev]
 * @returns {{rev: string | undefined}}
 */
function readAt(root, rev = "HEAD") {
	return { rev: isGitRepo(root) ? rev : undefined };
}

/**
 * The hooks `root` registers itself (lib/core-hooks.js `ownHooks`: the
 * self-plugin's file and the canary its settings keep at the core,
 * `.claude/settings.json` elsewhere), or
 * BROKEN — the one read both `hookCounts` and `readHookCommands` share, so there
 * is exactly one error policy for a missing or unparseable file rather than
 * two that can drift apart (mantahostels#1923). Read at `rev`, so a neighbour's
 * uncommitted hook entry is neither reported nor anchored (#1879).
 *
 * @param {any} ctx
 * @param {string} root
 * @param {string} [rev]
 * @returns {Record<string, unknown>}
 */
function readHooks(ctx, root, rev = "HEAD") {
	const at = readAt(root, rev);
	let hooks;
	try {
		hooks = readOwnHooks(root, at);
	} catch (e) {
		return ctx.broken(`${errMessage(e)}. Nothing counted.`);
	}
	if (hooks === null)
		return ctx.broken(
			`no ${ownHooksFile(root, at)} ${at.rev ? `at ${rev} ` : ""}under ${root}. Nothing counted.`,
		);
	return hooks;
}

/**
 * Hook entries `root` registers, counted as the census counted them:
 * one per `hooks[]` command, not one per matcher group.
 *
 * @param {any} ctx
 * @param {string} root
 * @param {string} [rev]
 * @returns {HookCounts}
 */
function hookCounts(ctx, root, rev) {
	/** @type {Record<string, number>} */
	const byEvent = {};
	let total = 0;
	for (const [event, groups] of Object.entries(readHooks(ctx, root, rev))) {
		const n = (Array.isArray(groups) ? groups : []).reduce(
			(sum, g) => sum + (Array.isArray(g?.hooks) ? g.hooks.length : 0),
			0,
		);
		byEvent[event] = n;
		total += n;
	}
	return { total, byEvent };
}

/**
 * One hook entry's command line — `command` and the exec form's `args`
 * joined via `buildHookCommandLine()` (mantahostels#2301), so a script path living in `args`
 * alone is still seen — keyed by `<event> <scriptPath>`, plus ` if <cond>`
 * where the entry carries an `if` condition.
 * The event prefix is needed because a script wired to two events with
 * different args (`concision-backstop.sh start`/`stop`) would otherwise
 * collide on a path-only key and silently drop one command. The `if` suffix
 * is needed because one script wired once per condition in one event
 * (one script under `Bash(*cat *)`, another under `Bash(*sed *)`, …) is one key
 * per condition, not a collision (#1604). Two entries with the same script
 * and condition, and a command whose script path is wrapped
 * (`bg-run.sh run … node scripts/real.js`, keying on the wrapper), both still
 * drop an entry — closed not here but by the
 * `hooks.total`-versus-`Object.keys(hookCommands).length` check in `run()`.
 *
 * @param {any} ctx
 * @param {string} root
 * @param {string} [rev]
 * @returns {Record<string, string>}
 */
function readHookCommands(ctx, root, rev) {
	/** @type {Record<string, string>} */
	const out = {};
	for (const [event, groups] of Object.entries(readHooks(ctx, root, rev))) {
		for (const [key, line] of eventHookCommands(event, groups)) out[key] = line;
	}
	return out;
}

/**
 * One event's `[buildHookKey key, command line]` pairs, in settings order.
 *
 * @param {string} event
 * @param {unknown} groups
 * @returns {[string, string][]}
 */
function eventHookCommands(event, groups) {
	/** @type {[string, string][]} */
	const pairs = [];
	for (const g of Array.isArray(groups) ? groups : []) {
		for (const h of Array.isArray(g?.hooks) ? g.hooks : []) {
			const line = buildHookCommandLine(h);
			if (!line) continue;
			const key = buildHookKey(event, h, line);
			if (key) pairs.push([key, line]);
		}
	}
	return pairs;
}

/**
 * @param {string} event
 * @param {{ if?: unknown }} hook the settings entry, for its `if` condition
 * @param {string} line its command line
 * @returns {string | null} null where the line names no script
 */
function buildHookKey(event, hook, line) {
	const m = line.match(/scripts\/[\w./-]+\.(?:sh|js)/);
	if (!m) return null;
	const cond = typeof hook.if === "string" && hook.if ? ` if ${hook.if}` : "";
	return `${event} ${m[0]}${cond}`;
}

/**
 * Skill directories, split own/vendored on the symlink — the same test
 * check-context-budget.js draws, and the one the census's own addendum adopted
 * (mantahostels#1757).
 *
 * Read at `rev` (#1977), as the hook entries are, so a neighbour's uncommitted
 * skill is neither reported nor anchored. Each SKILL.md is read through git's
 * own link resolution, so a linked skill directory, a linked SKILL.md and a
 * link to a link all reach their committed target's text (#2369). Disk answers
 * only where `root` is no git repo; a `rev` git cannot list is BROKEN.
 * Residual: a link resolving outside the repo is read from disk.
 *
 * @param {string} root
 * @param {string} [rev]
 * @returns {SkillCounts}
 */
function skillCounts(root, rev = "HEAD") {
	let listing;
	try {
		listing = listTree(rev, [".claude/skills/"], {
			cwd: root,
			recursive: false,
		});
	} catch (e) {
		if (!isGitRepo(root)) return diskSkillCounts(root);
		throw e;
	}
	const listed = listing
		.filter((e) => e.mode === GIT_MODE.tree || e.mode === GIT_MODE.symlink)
		.map((e) => ({ link: e.mode === GIT_MODE.symlink, rel: e.path }));
	const texts = followedTexts(
		root,
		rev,
		listed.map(({ rel }) => `${rel}/SKILL.md`),
	);
	return tallySkills(
		listed.map(({ link }, i) => ({ link, text: texts[i] ?? null })),
	);
}

/**
 * Each path's text at `rev` through git's own link resolution, null where git
 * finds no file there.
 *
 * @param {string} root
 * @param {string} rev
 * @param {string[]} rels relative to `root`, as ls-tree prints them
 * @returns {(string | null)[]}
 */
function followedTexts(root, rev, rels) {
	const objects = readObjectBatch(
		rels.map((rel) => `${rev}:./${rel}`),
		`${rev}'s SKILL.md files`,
		{ cwd: root, followSymlinks: true },
	);
	return rels.map((rel, i) => {
		const object = objects[i];
		if (object?.type === "blob") return object.body.toString("utf8");
		/* Git prints an absolute target without the path left to walk, so the
		 * outside read goes through the working tree's own link instead. */
		if (object?.type === "symlink") return readIfPresent(path.join(root, rel));
		return null;
	});
}

/**
 * Whether `root` is a git repo: `rev-parse --git-dir` exits 128 outside one,
 * and any other failure is a git that will not answer, BROKEN (#3068).
 * @param {string} root
 */
function isGitRepo(root) {
	const r = gitOutcome(["-C", root, "rev-parse", "--git-dir"], [128]);
	if (!r.ok) throw brokenError(`git rev-parse --git-dir failed: ${r.why}`);
	return r.out !== "";
}

/**
 * @param {string} root
 * @returns {SkillCounts}
 */
function diskSkillCounts(root) {
	const dir = path.join(root, ".claude", "skills");
	let names;
	try {
		names = fs.readdirSync(dir);
	} catch {
		return tallySkills([]);
	}
	/** @type {SkillEntry[]} */
	const entries = [];
	for (const name of names.sort()) {
		const at = path.join(dir, name);
		try {
			entries.push({
				link: fs.lstatSync(at).isSymbolicLink(),
				text: readIfPresent(path.join(at, "SKILL.md")),
			});
		} catch {
			// Removed between the listing and the stat: no skill.
		}
	}
	return tallySkills(entries);
}

/**
 * A directory without a SKILL.md is no skill and is skipped.
 *
 * @param {SkillEntry[]} entries
 * @returns {SkillCounts}
 */
function tallySkills(entries) {
	let own = 0;
	let vendored = 0;
	let disabled = 0;
	for (const { link, text } of entries) {
		if (text === null) continue;
		if (link) vendored++;
		else own++;
		/* Strict on the bare `true`, as check-context-budget.js is: a spelling
		 * nobody writes falls through and is counted enabled. */
		if (/^disable-model-invocation:\s*true\s*$/m.test(text)) disabled++;
	}
	return { distinct: own + vendored, own, vendored, disabled };
}

/**
 * Bytes for each pool file the baseline names, null where gone — from git, as
 * readCommittedBytes reads.
 *
 * @param {string} root
 * @param {Record<string, number>} baselined
 * @param {string} [rev]
 * @returns {Record<string, number | null>}
 */
function readPoolSizes(root, baselined, rev) {
	/** @type {Record<string, number | null>} */
	const out = {};
	for (const rel of Object.keys(baselined)) {
		const bytes = readCommittedBytes(root, rel, rev);
		out[rel] = bytes === null ? null : bytes.length;
	}
	return out;
}

/**
 * Live digest per baselined guard, null where the script is gone.
 *
 * @param {string} root
 * @param {Record<string, GuardAnchor>} guards
 * @returns {Record<string, string | null>}
 */
function guardDigests(root, guards) {
	/** @type {Record<string, string | null>} */
	const out = {};
	for (const rel of Object.keys(guards)) out[rel] = digestOf(root, rel);
	return out;
}

/**
 * Every event whose count moved, `PreToolUse 16 -> 17`, so the reader is told
 * which of Table A's five sections to re-read rather than the total alone.
 *
 * @param {Record<string, number>} live
 * @param {Record<string, number>} was
 * @returns {string}
 */
function perEvent(live, was = {}) {
	const events = [
		...new Set([...Object.keys(live), ...Object.keys(was)]),
	].sort();
	const moved = events
		.filter((e) => (live[e] ?? 0) !== (was[e] ?? 0))
		.map((e) => `${e} ${was[e] ?? 0} -> ${live[e] ?? 0}`);
	return moved.length > 0 ? moved.join("; ") : "no single event moved";
}

/**
 * @param {any} ctx
 * @param {string} file
 * @returns {any}
 */
function readBaseline(ctx, file) {
	const text = readIfPresent(file);
	if (text === null)
		return ctx.broken(
			`no baseline at ${file}. Write one with --rebaseline, or point --baseline at it.`,
		);
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch (e) {
		return ctx.broken(`${file} will not parse: ${errMessage(e)}`);
	}
	const missing = REQUIRED_SECTIONS.filter((k) => !parsed[k]);
	if (missing.length > 0)
		return ctx.broken(
			`${file} is missing ${missing.join(", ")} — nothing to compare against.`,
		);
	return parsed;
}

/**
 * rebaseline()'s narrowing: `only` is --only's keys (null for the whole
 * baseline).
 * @typedef {{ rev?: string, only?: Set<string> | null }} RebaselineScope
 */

/**
 * @param {string} root
 * @param {any} baseline
 * @param {RebaselineScope} scope
 * @returns {{ rows: Record<string, GuardAnchor>, anchored: string[], goneNamed: string[] }}
 *   the section, and which --only keys it re-anchored or dropped
 */
function rebaselineGuards(root, baseline, { rev, only }) {
	/** @type {Record<string, GuardAnchor>} */
	const guards = {};
	/** @type {string[]} */
	const anchored = [];
	/** @type {string[]} */
	const goneNamed = [];
	for (const [rel, anchor] of Object.entries(
		/** @type {Record<string, GuardAnchor>} */ (baseline.guards),
	)) {
		if (only && !only.has(rel)) {
			guards[rel] = anchor; // untouched: not named by --only
			continue;
		}
		const digest = digestOf(root, rel, rev);
		if (digest === null) {
			if (only) goneNamed.push(rel); // named, but the guard is gone — dropped
			continue; // a guard that is gone leaves no anchor
		}
		guards[rel] = { ...anchor, digest };
		if (only) anchored.push(rel);
	}
	return { rows: guards, anchored, goneNamed };
}

/**
 * @param {string} root
 * @param {any} baseline
 * @param {RebaselineScope} scope
 * @returns {{ rows: Record<string, number>, anchored: string[], goneNamed: string[] }}
 *   the section, and which --only keys it re-anchored or dropped
 */
function rebaselinePoolFiles(root, baseline, { rev, only }) {
	if (!only)
		return {
			rows: /** @type {Record<string, number>} */ (
				Object.fromEntries(
					Object.entries(readPoolSizes(root, baseline.poolFiles, rev)).filter(
						([, bytes]) => bytes !== null,
					),
				)
			),
			anchored: [],
			goneNamed: [],
		};
	/** @type {string[]} */
	const anchored = [];
	/** @type {string[]} */
	const goneNamed = [];
	const rows = {
		.../** @type {Record<string, number>} */ (baseline.poolFiles),
		...Object.fromEntries(
			[...only]
				.filter((k) => k in baseline.poolFiles)
				.map((k) => {
					const bytes = readCommittedBytes(root, k, rev);
					if (bytes === null) {
						goneNamed.push(k); // named, but the pool file is gone
						return [k, undefined];
					}
					anchored.push(k);
					return [k, bytes.length];
				})
				.filter(([, bytes]) => bytes !== undefined),
		),
	};
	return { rows, anchored, goneNamed };
}

/**
 * @param {any} baseline
 * @param {Record<string, string>} liveHookCommands
 * @param {RebaselineScope} scope
 * @returns {{ rows: Record<string, string>, anchored: string[] }} the
 *   section, and which --only keys it re-anchored; a named key gone from the
 *   live tree is left out of both, and knownButGone reports it
 */
function rebaselineHookCommands(baseline, liveHookCommands, { only }) {
	if (!only) return { rows: liveHookCommands, anchored: [] };
	const anchored = [...only].filter((k) => k in liveHookCommands);
	const rows = Object.fromEntries(
		Object.entries(
			/** @type {Record<string, string>} */ (baseline.hookCommands),
		).filter(([k]) => !only.has(k) || k in liveHookCommands),
	);
	for (const k of anchored)
		rows[k] = /** @type {string} */ (liveHookCommands[k]);
	return { rows, anchored };
}

/**
 * @param {any} baseline
 * @param {Set<string>} only
 * @param {Set<string>} settled the keys a section re-anchored or dropped
 * @returns {string[]}
 */
function knownButGone(baseline, only, settled) {
	// known, but no live subject carries it now
	return [...only].filter(
		(k) =>
			!settled.has(k) &&
			(k in baseline.hookCommands || k in baseline.poolFiles),
	);
}

/**
 * Re-anchors the baseline to the tree as it stands, keeping every authored
 * field — the verdicts, the rule inventory, the citation of the census that
 * produced them.
 *
 * THE CLAIM IS THIS SCRIPT'S OWN. The PreToolUse claim hook watches
 * Write/Edit/NotebookEdit, so a script writing a docs/ path is invisible to it,
 * and the claim is what records the bytes being replaced. Fails open (mantahostels#1194).
 *
 * @param {string} root
 * @param {string} file
 * @param {any} baseline
 * @param {{ claim: boolean, rev?: string, only?: Set<string> | null }} opts
 *   `rev` anchors at this revision rather than HEAD — for a
 *   measurement taken against a tree that is no longer the tip.
 *   `only` (mantahostels#2105, RebaselineScope): the caller validates every key
 *   names an existing row before calling this — see refuseUnknownOnlyKeys's
 *   "no row in the baseline" usageError.
 * @returns {{ next: any, anchored: Set<string>, goneNamed: Set<string> }}
 *   `anchored`/`goneNamed` partition `only` (empty when `only` is null): which
 *   named keys were actually re-measured, and which were named but dropped
 *   because their live subject is gone.
 */
function rebaseline(root, file, baseline, { claim, rev, only }) {
	const scope = { rev, only };

	const guards = rebaselineGuards(root, baseline, scope);
	const poolFiles = rebaselinePoolFiles(root, baseline, scope);
	const liveHookCommands = readHookCommandsPlain(root, rev);
	const hookCommands = rebaselineHookCommands(
		baseline,
		liveHookCommands,
		scope,
	);
	const anchored = new Set([
		...guards.anchored,
		...poolFiles.anchored,
		...hookCommands.anchored,
		...Object.keys(COUNTERS).filter((k) => only?.has(k)),
	]);
	const goneNamed = new Set([...guards.goneNamed, ...poolFiles.goneNamed]);
	if (only)
		for (const k of knownButGone(
			baseline,
			only,
			new Set([...anchored, ...goneNamed]),
		))
			goneNamed.add(k);
	const next = {
		...baseline,
		poolFiles: poolFiles.rows,
		hookCommands: hookCommands.rows,
		guards: guards.rows,
		...Object.fromEntries(
			Object.entries(COUNTERS).map(([k, count]) => [
				k,
				only && !only.has(k) ? baseline[k] : count(root, rev),
			]),
		),
	};
	if (claim) claimDataFile(file);
	fs.writeFileSync(file, `${JSON.stringify(next, null, "\t")}\n`);
	return { next, anchored, goneNamed };
}

/** A ctx substitute with no reporting behind it — --rebaseline's path. */
const plainCtx = {
	broken: (/** @type {string} */ m) => {
		throw brokenError(m);
	},
};

/** hookCounts without a ctx to be BROKEN through — --rebaseline's path. */
function hookCountsPlain(
	/** @type {string} */ root,
	/** @type {string | undefined} */ rev,
) {
	return hookCounts(plainCtx, root, rev);
}

/** readHookCommands without a ctx to be BROKEN through — --rebaseline's path. */
function readHookCommandsPlain(
	/** @type {string} */ root,
	/** @type {string | undefined} */ rev,
) {
	return readHookCommands(plainCtx, root, rev);
}

/**
 * @param {any} ctx
 * @param {string} root
 * @param {string} file
 * @param {any} baseline
 */
function runRebaseline(ctx, root, file, baseline) {
	const only = ctx.has("--only")
		? new Set(
				ctx
					.value("--only", "")
					.split(",")
					.map((/** @type {string} */ s) => s.trim())
					.filter(Boolean),
			)
		: null;
	if (only && only.size === 0) ctx.usageError("--only named no key.");
	/*
	 * A key naming no row in the baseline is a bad invocation, not a
	 * no-op (mantahostels#2105): unvalidated, a typo'd guard path or
	 * hook-command key re-anchors nothing and still exits OK, which is
	 * silent under-clearing.
	 */
	const rev = ctx.value("--at", "HEAD");
	/* Before any read, so every scope is refused alike rather than by
	 * whichever read meets the bad rev first (#2052). */
	if (isGitRepo(root) && readCommitOrBroken(rev, root) === null)
		ctx.usageError(`--at ${rev} names no commit git can resolve.`);
	if (only) refuseUnknownOnlyKeys(ctx, root, baseline, { only, rev });
	const { next, anchored, goneNamed } = rebaseline(root, file, baseline, {
		claim: !ctx.has("--no-claim"),
		rev,
		only,
	});
	return {
		okLine: only
			? `re-anchored ${path.relative(root, file)}: ${anchored.size} of ${only.size} named row(s) (${[...anchored].join(", ") || "none"})${goneNamed.size > 0 ? `; ${goneNamed.size} named row(s) dropped, gone from the live tree (${[...goneNamed].join(", ")})` : ""}. Every unnamed row and count is untouched.`
			: `re-anchored ${path.relative(root, file)}: ${Object.keys(next.guards).length} guards, ${next.hooks.total} hook entries (${Object.keys(next.hookCommands).length} command texts), ${next.skills.distinct} skills. The verdicts are unchanged — re-anchoring asserts you re-measured them.`,
		data: { rebaselined: true },
	};
}

/**
 * Refuse an --only key naming no baseline row and no live hook command.
 *
 * @param {any} ctx
 * @param {string} root
 * @param {any} baseline
 * @param {{ only: Set<string>, rev: string }} scope
 */
function refuseUnknownOnlyKeys(ctx, root, baseline, { only, rev }) {
	const known = new Set([
		...Object.keys(COUNTERS),
		...Object.keys(baseline.guards),
		...Object.keys(baseline.hookCommands),
		...Object.keys(baseline.poolFiles),
		...Object.keys(readHookCommandsPlain(root, rev)),
		/* A HOOK-COMMAND-NEW key has no baseline row by definition
		 * (mantahostels#2648). Without it here the only way to anchor a newcomer
		 * is the bare --rebaseline this flag exists to avoid. */
	]);
	const unknown = [...only].filter((k) => !known.has(k));
	if (unknown.length > 0)
		ctx.usageError(
			`--only names ${unknown.length} key(s) with no row in the baseline: ${unknown.join(", ")}. A guard or pool-file key is its rel path (e.g. scripts/guard-foo.sh or CLAUDE.md); the hook-entry and skill counts are \`hooks\` and \`skills\`; a hook-command key is "<event> <path>", plus " if <cond>" where the entry has an \`if\` condition; --only splits on commas, so a condition holding one cannot be named.`,
		);
}

/** @typedef {(tag: string, message: string, data: object, key: string) => void} Raise */

/**
 * HOOK-COUNT: the total against the census's, or per event at an unchanged
 * total.
 *
 * @param {Raise} raise
 * @param {HookCounts} hooks
 * @param {any} baseline
 * @param {string} file where the hooks are registered
 */
function checkHookCounts(raise, hooks, baseline, file) {
	if (hooks.total !== baseline.hooks.total) {
		raise(
			"HOOK-COUNT",
			`${hooks.total} hook entries in ${file} against the census's ${baseline.hooks.total} (${perEvent(hooks.byEvent, baseline.hooks.byEvent)}). Table A is out of date; its count alone re-anchors with --only hooks.`,
			{ live: hooks.byEvent, baseline: baseline.hooks.byEvent },
			"HOOK-COUNT",
		);
		return;
	}
	for (const [event, n] of Object.entries(hooks.byEvent))
		if (n !== baseline.hooks.byEvent?.[event])
			raise(
				"HOOK-COUNT",
				`${event} carries ${n} hook entries against the census's ${baseline.hooks.byEvent?.[event] ?? 0}, at an unchanged total. Table A's rows moved between events; the count alone re-anchors with --only hooks.`,
				{},
				`HOOK-COUNT\t${event}`,
			);
}

/**
 * A hookCommands key split into its event, its subject (the script path and
 * any ` if <cond>`, which a move between events keeps), and the script path
 * alone. A script path holds no space, so the first space after the event
 * ends it.
 *
 * @param {string} key
 * @returns {{ event: string, subject: string, path: string }}
 */
function parseHookKey(key) {
	const sep = key.indexOf(" ");
	if (sep === -1) return { event: "", subject: key, path: key };
	const subject = key.slice(sep + 1);
	const end = subject.indexOf(" ");
	return {
		event: key.slice(0, sep),
		subject,
		path: end === -1 ? subject : subject.slice(0, end),
	};
}

/**
 * Where a baseline hookCommands key that has no live entry went: the live key
 * with the same subject under another event (a move), else the live key with
 * the same event and script under another `if` condition (a condition change).
 * Neither is a hook gone. Null where it is.
 *
 * @param {{ event: string, subject: string, path: string }} was the parsed baseline key
 * @param {string[]} liveKeys
 * @returns {{ key: string, kind: "event" | "condition" } | null}
 */
function successorOf(was, liveKeys) {
	const moved = liveKeys.find((k) => parseHookKey(k).subject === was.subject);
	if (moved) return { key: moved, kind: "event" };
	const recond = liveKeys.find((k) => {
		const live = parseHookKey(k);
		return live.event === was.event && live.path === was.path;
	});
	return recond ? { key: recond, kind: "condition" } : null;
}

/**
 * @param {string} key the baseline key with no live entry
 * @param {{ event: string, subject: string }} parsed that key, parsed
 * @param {{ key: string, kind: "event" | "condition" } | null} successor
 * @returns {string}
 */
function buildGoneMessage(key, parsed, successor) {
	if (!successor)
		return `${key} no longer runs as a hook command; the census's citation of it has no live subject.`;
	if (successor.kind === "condition")
		return `${key} now runs under another condition, as \`${successor.key}\`; the census's citation of it under the old condition has no live subject.`;
	return `${parsed.subject} moved from ${parsed.event} to ${parseHookKey(successor.key).event}; the census's citation of it under the old event has no live subject there.`;
}

/**
 * HOOK-COMMAND-GONE and HOOK-COMMAND: each census hook command against the
 * live one. Returns the live keys a GONE named as a move's destination.
 *
 * @param {Raise} raise
 * @param {Record<string, string>} hookCommands
 * @param {any} baseline
 * @returns {Set<string>}
 */
function checkHookCommandsGone(raise, hookCommands, baseline) {
	/* Each live key GONE has already accounted for as a move, so
	 * HOOK-COMMAND-NEW below does not report it a second time. */
	/** @type {Set<string>} */
	const reportedMoves = new Set();

	for (const [key, was] of Object.entries(
		/** @type {Record<string, string>} */ (baseline.hookCommands),
	)) {
		const parsed = parseHookKey(key);
		const { event, path: scriptPath } = parsed;
		const now = hookCommands[key];
		if (now === undefined) {
			const successor = successorOf(parsed, Object.keys(hookCommands));
			const movedTo = successor?.key;
			if (movedTo) reportedMoves.add(movedTo);
			raise(
				"HOOK-COMMAND-GONE",
				buildGoneMessage(key, parsed, successor),
				{
					event,
					path: scriptPath,
					baseline: was,
					movedTo: movedTo ?? null,
				},
				`HOOK-COMMAND-GONE\t${key}`,
			);
			continue;
		}
		if (now === was) continue;
		raise(
			"HOOK-COMMAND",
			`${key}'s live hook command has changed since the census recorded it (was \`${was}\`, now \`${now}\`). Table A's row for it is unverified.`,
			{
				event,
				path: scriptPath,
				live: now,
				baseline: was,
			},
			`HOOK-COMMAND\t${key}`,
		);
	}
	return reportedMoves;
}

/**
 * HOOK-COMMAND-NEW: a live hook command with no census row.
 *
 * @param {Raise} raise
 * @param {Record<string, string>} hookCommands
 * @param {any} baseline
 * @param {Set<string>} reportedMoves
 */
function checkHookCommandsNew(raise, hookCommands, baseline, reportedMoves) {
	for (const [key, now] of Object.entries(hookCommands)) {
		if (key in baseline.hookCommands) continue;
		if (reportedMoves.has(key)) continue;
		const { event, path: scriptPath } = parseHookKey(key);
		raise(
			"HOOK-COMMAND-NEW",
			`${key} runs as a hook command with no row in the census's hookCommands (\`${now}\`). Table A has never covered it.`,
			{ event, path: scriptPath, live: now },
			`HOOK-COMMAND-NEW\t${key}`,
		);
	}
}

/**
 * SKILL-COUNT: each skill-directory count against the census's.
 *
 * @param {Raise} raise
 * @param {SkillCounts} skills
 * @param {any} baseline
 */
function checkSkillCounts(raise, skills, baseline) {
	for (const key of /** @type {(keyof SkillCounts)[]} */ ([
		"distinct",
		"own",
		"vendored",
		"disabled",
	]))
		if (skills[key] !== baseline.skills?.[key])
			raise(
				"SKILL-COUNT",
				`${skills[key]} ${key} skill directories against the census's ${baseline.skills?.[key] ?? 0}. Part 3's table is out of date; its counts alone re-anchor with --only skills.`,
				{ key, live: skills[key], baseline: baseline.skills?.[key] },
				`SKILL-COUNT\t${key}`,
			);
}

/**
 * POOL-GONE and POOL-DRIFT: each census pool file's live bytes.
 *
 * @param {Raise} raise
 * @param {Record<string, number | null>} pool
 * @param {any} baseline
 * @param {number} threshold
 */
function checkPoolFiles(raise, pool, baseline, threshold) {
	for (const [rel, was] of Object.entries(
		/** @type {Record<string, number>} */ (baseline.poolFiles),
	)) {
		const now = pool[rel];
		/* readPoolSizes measures every key of this same object. */
		if (now === undefined)
			throw new Error(`readPoolSizes returned no entry for ${rel}`);
		if (now === null) {
			raise(
				"POOL-GONE",
				`${rel} is no longer in the tree. Every census row citing it is dead.`,
				{},
				`POOL-GONE\t${rel}`,
			);
			continue;
		}
		const drift = ((now - was) / was) * 100;
		if (Math.abs(drift) < threshold) continue;
		const signed = `${drift >= 0 ? "+" : ""}${Math.round(drift)}%`;
		raise(
			"POOL-DRIFT",
			`${rel} is ${now} B against the ${was} B the census inventoried, ${signed}. Its share of the ${baseline.poolRules.total}-rule inventory, and every line citation into it, is unverified.`,
			{ path: rel, live: now, baseline: was, driftPct: Math.round(drift) },
			`POOL-DRIFT\t${rel}`,
		);
	}
}

/**
 * GUARD-GONE and GUARD-CHANGED: each anchored guard's live digest.
 *
 * @param {Raise} raise
 * @param {Record<string, string | null>} digests
 * @param {any} baseline
 */
function checkGuards(raise, digests, baseline) {
	for (const [rel, anchor] of Object.entries(
		/** @type {Record<string, GuardAnchor>} */ (baseline.guards),
	)) {
		const now = digests[rel];
		if (now === null) {
			raise(
				"GUARD-GONE",
				`${rel} is gone; the census's verdict — ${verdictOf(anchor)} — has no subject left.`,
				{
					path: rel,
					verdict: anchor.verdict,
					selfSufficient: anchor.selfSufficient,
				},
				`GUARD-GONE\t${rel}`,
			);
			continue;
		}
		if (now === anchor.digest) continue;
		raise(
			"GUARD-CHANGED",
			`${rel} has changed since it was measured (anchored ${anchor.digest}, now ${now}). Its verdict — ${verdictOf(anchor)} — is unverified until the guard is fed a triggering payload again.`,
			{
				path: rel,
				verdict: anchor.verdict,
				selfSufficient: anchor.selfSufficient,
			},
			`GUARD-CHANGED\t${rel}`,
		);
	}
}

/**
 * @param {any} ctx
 * @param {string} against the census edition and the baseline anchoring it
 * @param {string} counted
 * @param {string[]} lines
 */
function sayFindings(ctx, against, counted, lines) {
	ctx.say(`Counted ${counted}, against ${against}.`);
	for (const line of lines) ctx.say(line);
	ctx.say(
		"  Re-measure a guard: feed it a triggering payload and read what it prints (mantahostels#886), then re-anchor.",
	);
	ctx.say(
		"  Re-anchor everything:  node scripts/check-instruction-surface.js --rebaseline",
	);
	ctx.say(
		"  Re-anchor named rows only, leaving the rest reporting:  node scripts/check-instruction-surface.js --rebaseline --only <key>[,<key>...]  (mantahostels#2105)",
	);
}

/**
 * The anchored rows whose guard, or a rule file it prints from, `rev` touched:
 * each row's anchor and digest at `rev`, null where the guard is gone, and the
 * rule files a row was reached through.
 *
 * @param {string} root
 * @param {string} rev
 * @param {Map<string, string>} touched readTouchedBy's answer
 * @param {object} from
 * @param {Record<string, GuardAnchor>} from.anchored the baseline's rows
 * @param {import("./lib/git-ceiling.js").GitCeiling} from.ceiling
 */
function rowsTouched(root, rev, touched, { anchored, ceiling }) {
	const guardsOf = guardsChangedBy(root, Object.keys(anchored), rev, {
		ceiling,
	});
	/** @type {Set<string>} */
	const reached = new Set();
	/** @type {Map<string, string[]>} */
	const through = new Map();
	for (const changed of touched.keys())
		for (const rel of guardsOf(changed)) {
			reached.add(rel);
			if (rel !== changed)
				through.set(rel, [...(through.get(rel) ?? []), changed]);
		}
	const guards = Object.fromEntries(
		Object.entries(anchored).filter(([rel]) => reached.has(rel)),
	);
	/** @type {Record<string, string | null>} */
	const digests = Object.fromEntries(
		Object.keys(guards).map((rel) => [
			rel,
			touched.get(rel) === "D" ? null : digestOf(root, rel, rev, { ceiling }),
		]),
	);
	return { guards, digests, through };
}

/**
 * --touched-by: the guard rows `rev` itself expired.
 *
 * @param {import("./lib/check").CheckContext} ctx
 * @param {string} root
 * @param {string} file
 * @param {{ guards: Record<string, GuardAnchor>, measuredAt?: { document?: string } }} baseline
 */
function runTouched(ctx, root, file, baseline) {
	if (ctx.has("--rebaseline"))
		ctx.usageError(
			"--touched-by reports; it does not combine with --rebaseline.",
		);
	const rev = ctx.value("--touched-by", "HEAD");
	const ceiling = touchedByCeiling();
	let touched;
	try {
		touched = readTouchedBy(root, rev, ceiling);
	} catch (e) {
		if (e instanceof CeilingPassed) throw e;
		return ctx.broken(
			`git cannot list what ${rev} changed: ${errMessage(e).split("\n")[0]}`,
		);
	}
	const { guards, digests, through } = rowsTouched(root, rev, touched, {
		anchored: baseline.guards,
		ceiling,
	});
	/** @type {string[]} */
	const lines = [];
	checkGuards(
		(tag, message, detail, key) => {
			ctx.warn(tag, message, detail, key);
			lines.push(`  ${tag}  ${message}`);
		},
		digests,
		{ guards },
	);
	if (ctx.findings.length === 0)
		return {
			okLine: `${rev} left every guard the census measured as anchored.`,
		};
	const keys = Object.keys(guards);
	const anchors = path.relative(root, file);
	ctx.say(
		"This commit changed a guard the instruction-surface census measured, or a rule file one prints (#1810, #1914):",
	);
	for (const line of lines) ctx.say(line);
	for (const rel of keys) {
		const reanchor = `node scripts/check-instruction-surface.js --rebaseline --only ${rel}`;
		if (digests[rel] === null) {
			ctx.say(
				`  ${rel} is gone: drop its row with  ${reanchor}  and commit ${anchors}. If it moved, measure it at its new path and add a row there.`,
			);
			continue;
		}
		/* A row a neighbour's commit expired first is still owed the
		 * neighbour's change, which re-anchoring HEAD's bytes vouches for. */
		const since =
			digestOf(root, rel, `${rev}^`, { ceiling }) === guards[rel]?.digest
				? "one aimed at what you changed"
				: "one aimed at every change since its row was anchored, which was already stale before this commit";
		const via = through.get(rel);
		ctx.say(
			`  Once your changes to ${rel}${via ? ` (through ${via.join(", ")})` : ""} are done, re-measure it: feed it its payload from ${baseline.measuredAt?.document ?? "the census"} Part 2 and ${since}; rewrite its row in ${anchors} from what it prints; re-anchor that row alone with  ${reanchor}  and commit ${anchors}.`,
		);
	}
	return { noun: "census row this commit expired", count: keys.length };
}

runCheck({
	name: "instruction-surface",
	usage: `node check-instruction-surface.js [--root <dir>] [--baseline <file>] [--threshold <pct>] [--json] [--warn] | --touched-by <rev> (BROKEN past ${TOUCHED_BY_CEILING_MS / 1000}s) | --rebaseline [--at <rev>] [--no-claim] [--only <key>[,<key>...]]`,
	valueFlags: [
		"--root",
		"--baseline",
		"--threshold",
		"--at",
		"--only",
		"--touched-by",
	],
	flags: ["--no-claim", "--rebaseline"],
	run(/** @type {any} */ ctx) {
		try {
			return runChecks(ctx);
		} catch (e) {
			if (e instanceof DigestUnavailable || e instanceof CeilingPassed)
				return ctx.broken(e.message);
			throw e;
		}
	},
});

/** @param {import("./lib/check").CheckContext} ctx */
function runChecks(ctx) {
	const root = path.resolve(ctx.value("--root", process.cwd()));
	const file = path.resolve(root, ctx.value("--baseline", DEFAULT_ANCHORS));
	const threshold = Number(
		ctx.value("--threshold", String(DEFAULT_THRESHOLD_PCT)),
	);
	if (!Number.isFinite(threshold) || threshold <= 0)
		ctx.usageError(`--threshold must be a positive number, got ${threshold}`);

	const baseline = readBaseline(ctx, file);

	if (ctx.has("--touched-by")) return runTouched(ctx, root, file, baseline);
	if (ctx.has("--rebaseline")) return runRebaseline(ctx, root, file, baseline);

	/* A finding is printed where it is raised, not just recorded: runCheck's
	 * own reporting tail prints the ::warning:: annotations in Actions and the
	 * summary line everywhere, never the messages themselves. */
	/** @type {string[]} */
	const lines = [];
	/** @type {Raise} */
	const raise = (tag, message, detail, key) => {
		ctx.warn(tag, message, detail, key);
		lines.push(`  ${tag}  ${message}`);
	};

	const hooks = hookCounts(ctx, root);
	const hookCommands = readHookCommands(ctx, root);
	const skills = skillCounts(root);
	const pool = readPoolSizes(root, baseline.poolFiles);
	const digests = guardDigests(root, baseline.guards);

	const data = {
		hooks: { live: hooks, baseline: baseline.hooks },
		hookCommands: { live: hookCommands, baseline: baseline.hookCommands },
		skills: { live: skills, baseline: baseline.skills },
		pool: { live: pool, baseline: baseline.poolFiles, threshold },
		measuredAt: baseline.measuredAt,
	};

	checkHookCounts(
		raise,
		hooks,
		baseline,
		readOwnHookSources(root, readAt(root))
			.map((source) => path.relative(root, source.file))
			.join(" and "),
	);

	/* Every way a hook-command entry can go missing at read time — two
	 * entries with one event, script and condition, a wrapped script path —
	 * shows up as this count
	 * falling short of hooks.total. An unanchored newcomer is NOT one of them: it lifts
	 * hooks.total and the live key count together, so they still match, and
	 * HOOK-COMMAND-NEW below is what catches it (mantahostels#2648). */
	const liveCommandCount = Object.keys(hookCommands).length;
	if (liveCommandCount !== hooks.total)
		raise(
			"HOOK-COMMAND-COUNT",
			`${liveCommandCount} distinct hook-command keys against ${hooks.total} hook entries — a collision (two entries with the same event, script and condition) or a command with no recognisable script path dropped at least one entry.`,
			{ live: liveCommandCount, hooks: hooks.total },
			"HOOK-COMMAND-COUNT",
		);

	const reportedMoves = checkHookCommandsGone(raise, hookCommands, baseline);

	/* HOOK-COMMAND-GONE's mirror: a live hook command the census never
	 * anchored (mantahostels#2648). Without it a hook wired after the census was taken
	 * is invisible — Table A neither cites it nor is told it is missing one.
	 * A hook that merely MOVED event already reports as GONE against its old
	 * key, so the one key GONE named as its destination is skipped here
	 * rather than counted twice. Skipping on the script path instead would
	 * swallow a second wiring landing alongside a move. */
	checkHookCommandsNew(raise, hookCommands, baseline, reportedMoves);

	checkSkillCounts(raise, skills, baseline);

	checkPoolFiles(raise, pool, baseline, threshold);

	checkGuards(raise, digests, baseline);

	const counted = `${hooks.total} hook entries, ${skills.distinct} skill directories, ${Object.keys(baseline.guards).length} measured guards, ${Object.keys(baseline.poolFiles).length} pool files`;
	if (ctx.findings.length === 0)
		return {
			okLine: `census still holds: ${counted} (measured ${baseline.measuredAt?.date ?? "unknown"}, ${baseline.measuredAt?.census ?? "mantahostels#1716"}).`,
			data,
		};

	sayFindings(
		ctx,
		`${baseline.measuredAt?.document ?? "the instruction-surface census"} as anchored in ${path.relative(root, file)}`,
		counted,
		lines,
	);
	return { noun: "expired census row", count: ctx.findings.length, data };
}
