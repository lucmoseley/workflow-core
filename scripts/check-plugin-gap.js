#!/usr/bin/env node
/*
 * check-plugin-gap.js — the SessionStart reporter for the adopter-upgrade
 * mechanism (workflow-core#238, workflow-core#243). Reads the four-record state through
 * `scripts/lib/plugin-state.js` and, where a gap is open, injects the exact
 * command that closes it and the id of `rule:adopter-materialise-sequence`
 * so a session composing advice fetches the sequence rather than invents it
 * (docs/agents/adopter-upgrade.md). Where the supply gap is open, also reads
 * user-scope `settings.json` (`scripts/lib/materialise-plugin.js`'s
 * `predictedRefConflict`) to predict the workflow-core#258 cross-scope ref conflict, or
 * the workflow-core#342 source-kind one, the SessionEnd materialiser would otherwise refuse
 * silently (workflow-core#318).
 *
 * Usage:
 *   node scripts/check-plugin-gap.js --notify   the SessionStart hook shape
 *
 * NOT IN THE `check-*` FAMILY'S CONTRACT, AND THIS IS THE DEPARTURE §G4 ASKS
 * FOR (workflow-core#251 item 7). §N3 routes a `check-*` name to `runCheck` and §N4's
 * five-outcome alphabet. This file uses neither, for two reasons that cannot
 * both be satisfied by that family:
 *   1. Its output is not a report for a screen. It is a `hookSpecificOutput`
 *      envelope whose `additionalContext` must reach the MODEL verbatim —
 *      an exact command a session will copy. `runCheck` owns stdout and has
 *      no route that emits that envelope; wrapping the text in a finding
 *      would put a severity tag through the middle of the command block.
 *   2. Its contract on error is the `guard-*` family's, not the `check-*`
 *      family's: fail open, silent, exit 0 (workflow-core#238). A checker's BROKEN
 *      (exit 2) at SessionStart is a broken session start over a reporter
 *      that missed a gap. The name stays `check-` because it checks and
 *      never acts — `guard-` would promise a `PreToolUse` hook it is not.
 * The one place the alphabet does bind is a bad invocation, which §N4 rules
 * BROKEN rather than a finding: an argv with no `--notify` prints usage on
 * fd 2 and exits 2, because nothing was checked. `--notify` itself still
 * never exits non-zero, so only a hand run naming no mode reaches the 2.
 *
 * Silent (exit 0, no output; workflow-core#238 user stories 3 and 9) where both gaps are
 * closed and the loaded plugin is the installed one, where the adopter is
 * directory-sourced, pinned to a branch or a SHA rather than a tag, or
 * unpinned, where no plugin manifest reads at the plugin root, or where the
 * founder has already declined this exact repo+tag through
 * `scripts/adopter-consent.js` (`scripts/lib/adopter-consent.js`, workflow-core#245).
 * Where a gap does report, the report also carries the exact
 * `adopter-consent.js accept`/`decline` commands so the session records the
 * founder's chat answer rather than inventing a route for it.
 *
 * TWO EXCEPTIONS TO THAT SILENCE, each reported regardless of gap state:
 *   - `.claude/workflow-core.json`'s `stepsOwed` (workflow-core#248), whenever it holds an
 *     undeclined entry. Read through `scripts/lib/steps-owed.js`, never
 *     through this file's own config reads, and printed with the exact
 *     `scripts/steps-owed.js` command that discharges each entry.
 *   - A `.husky/*` hook shim (workflow-core#1839) where no core resolves (FAIL: the
 *     shim refuses, so the repo cannot commit). A hook written before workflow-core#1839
 *     still names its plugin on a `WFC_PLUGIN_ROOT` line: one naming a
 *     directory that is gone is a FAIL (its first `.` of a script there
 *     aborts), and one naming another core than this session's
 *     `CLAUDE_PLUGIN_ROOT` a WARN (the git gates judge commits by another
 *     core than the guards) (workflow-core#1168). Where `CLAUDE_PLUGIN_ROOT` is unset only
 *     the missing limb reports. workflow-core's own hooks are neither, so it
 *     is silent there.
 *
 * Not `async`: the reads are cheap (`plugin-state.js` is pure fs) and the
 * line must be in context before the session composes advice, unlike the
 * `notify-report.js` persist-and-replay checkers this repo also runs.
 *
 * IMPLICIT:  on every SessionStart, injects a version-gap line, the
 *            adopter-upgrade rule text and the consent accept/decline
 *            commands into the session's context when the pin, supply and
 *            install disagree, or a materialised-not-live line where only
 *            this process lags, a predicted workflow-core#258 ref-conflict
 *            line (workflow-core#318) alongside it where the supply gap is open, and a
 *            `stepsOwed` block (workflow-core#248) whenever that field holds an
 *            undeclined entry, and a stale-hook-root block (workflow-core#1168) or an
 *            unresolved-shim block (workflow-core#1839) — the latter three independent
 *            of the gap.
 * JUSTIFIED: fail-safe — otherwise a stale plugin runs with nothing saying
 *            so (workflow-core#238).
 * DEFEAT:    for the gap report only, a decline for this exact repo+tag
 *            (scripts/lib/adopter-consent.js, workflow-core#245); the three independent
 *            blocks have none.
 */

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const { writeFd } = require("./lib/write-fd.js");
const path = require("node:path");
const { deref } = require("./lib/deref.js");
const { hostRoot } = require("./lib/host-root.js");
const { readPluginState, resolveConfigDir } = require("./lib/plugin-state.js");
const { ruleText } = require("./lib/rule-text.js");
const { scriptPath } = require("./lib/script-path.js");
const { parseOrExit } = require("./lib/cli-args.js");
const { isDeclined } = require("./lib/adopter-consent.js");
const { stepsOwed } = require("./lib/steps-owed.js");
const {
	HOOKS,
	hookRootOf,
	isHookShim,
	NO_CORE_FIX,
} = require("./lib/adopter-skeleton.js");
const { shellWord } = require("./lib/dirty-tree.js");
const {
	predictedRefConflict,
	refConflictExplanation,
} = require("./lib/materialise-plugin.js");

const USAGE = `usage: node ${scriptPath("check-plugin-gap.js")} --notify`;

/** @type {import("./lib/cli-args").CliSpec} */
const CLI = { usage: USAGE, flags: { "--notify": "boolean" } };

/**
 * @param {ReturnType<typeof readPluginState>} state
 * @param {string} marketplace
 * @param {string} pluginName
 * @returns {string[]}
 */
function commandsFor(state, marketplace, pluginName) {
	/** @type {string[]} */
	const out = [];
	if (state.gaps.supplyBehindPin)
		out.push(
			`claude plugin marketplace add ${state.pin?.url ?? "<url>"}#${state.pin?.ref} --scope project`,
		);
	if (state.gaps.installBehindSupply) {
		out.push(
			`claude plugin install ${pluginName}@${marketplace} -y --scope project`,
		);
		out.push(
			`claude plugin update ${pluginName}@${marketplace} --scope project -y`,
		);
	}
	return out;
}

/**
 * The `stepsOwed` block alone — undeclined entries, each with the exact
 * `scripts/steps-owed.js` command that discharges it. `null` where the
 * array holds nothing to report (workflow-core#248).
 * @param {string} root
 * @param {string} pluginRoot
 * @returns {string|null}
 */
function owedBlock(root, pluginRoot) {
	/* A malformed `.claude/workflow-core.json` must not silence the
	 * version-gap report below it — `stepsOwed()` throws on unparseable
	 * JSON. Caught here, at the source, rather than relying on the outer
	 * fail-open in `main()`, which would swallow the whole report instead of
	 * just this block. */
	let owed;
	try {
		owed = stepsOwed(root).filter((e) => !e.declined);
	} catch {
		return null;
	}
	if (owed.length === 0) return null;
	const cli = shellWord(`${pluginRoot}/scripts/steps-owed.js`);
	const lines = [
		`${owed.length} step${owed.length === 1 ? "" : "s"} owed from a prior walk, carried forward from its migration note:`,
	];
	for (const e of owed) {
		lines.push(`  [${e.type}] (${e.tag}) ${e.text}`);
		/* shellWord, never JSON.stringify's double quotes, inside which a step
		 * text's backticks and `$` run when pasted (workflow-core#430). */
		if (e.type === "choice")
			lines.push(
				`    node ${cli} decline ${shellWord(e.tag)} ${shellWord(e.text)}`,
			);
		lines.push(
			`    node ${cli} clear ${shellWord(e.tag)} ${e.type} ${shellWord(e.text)}`,
		);
	}
	return lines.join("\n");
}

/** @param {string} root @returns {string} */
function versionAt(root) {
	try {
		const { version } = JSON.parse(
			fs.readFileSync(path.join(root, ".claude-plugin/plugin.json"), "utf8"),
		);
		if (typeof version === "string") return version;
	} catch {
		/* no readable manifest: the plugin cache names each root by its version */
	}
	return path.basename(root);
}

/**
 * Each core hook this adopter installs, with its text.
 * @param {string} root
 * @returns {{hook: string, text: string}[]}
 */
function installedHooks(root) {
	return HOOKS.flatMap((hook) => {
		try {
			return [
				{
					hook,
					text: fs.readFileSync(path.join(root, ".husky", hook), "utf8"),
				},
			];
		} catch {
			return [];
		}
	});
}

/**
 * Each hook's `WFC_PLUGIN_ROOT` that is not `running`, bucketed by whether it
 * no longer exists or names another install; a skewed one only where a
 * running root is known.
 * @param {string} root
 * @param {string|null} running
 */
function hookRootsOffRunning(root, running) {
	const runningReal = running === null ? null : deref(running);
	/** @type {Map<string, string[]>} */
	const missing = new Map();
	/** @type {Map<string, string[]>} */
	const skewed = new Map();
	for (const { hook, text } of installedHooks(root)) {
		const raw = hookRootOf(text);
		if (raw === null) continue;
		// as the hook's shell reads it, from the repo top a git hook runs in
		const named = path.resolve(root, raw);
		if (deref(named) === runningReal) continue;
		const bucket = fs.existsSync(named) ? skewed : missing;
		if (bucket === skewed && running === null) continue;
		bucket.set(named, [...(bucket.get(named) ?? []), `.husky/${hook}`]);
	}
	return { missing, skewed };
}

/**
 * The hooks whose `WFC_PLUGIN_ROOT` is missing or is not `runningRoot`, with
 * the `upgrade.js` command that re-points them (workflow-core#1168). `null` where every
 * hook matches or carries no such line.
 * @param {string} root
 * @param {string|undefined} runningRoot
 * @returns {string|null}
 */
function hookRootBlock(root, runningRoot) {
	const running = runningRoot ? path.resolve(runningRoot) : null;
	const { missing, skewed } = hookRootsOffRunning(root, running);
	if (missing.size === 0 && skewed.size === 0) return null;
	const lines = [];
	for (const [named, hooks] of missing)
		lines.push(
			`FAIL: ${hooks.join(", ")} run from ${named}, which no longer exists — ` +
				"each aborts on its first script there, so this repo cannot commit.",
		);
	if (running)
		for (const [named, hooks] of skewed)
			lines.push(
				`WARN: ${hooks.join(", ")} run workflow-core ${versionAt(named)} (${named}), ` +
					`this session runs ${versionAt(running)} (${running}) — ` +
					"commits are judged by a different core than this session's guards.",
			);
	const upgrade = running
		? `node ${shellWord(`${running}/scripts/upgrade.js`)} --root ${shellWord(root)} --plugin-root ${shellWord(running)}`
		: `node <installed plugin root>/scripts/upgrade.js --root ${shellWord(root)} --plugin-root <installed plugin root>`;
	lines.push(
		"Turn them into shims with upgrade.js, which rewrites every core hook on any run, up to date or not:",
		`  ${upgrade}`,
	);
	return lines.join("\n");
}

/**
 * The shims, where no core resolves for them, with resolve-core's reason and
 * the fix (workflow-core#1839). `null` where none is a shim or a core resolves.
 * @param {string} root
 * @returns {string|null}
 */
function shimBlock(root) {
	const shims = installedHooks(root)
		.filter(({ text }) => isHookShim(text))
		.map(({ hook }) => hook);
	if (shims.length === 0) return null;
	/* Looked up as the shim does, from the repo's own cwd, so a linked worktree
	 * resolves through its main checkout. The core's copy, not the adopter's:
	 * the lookup is frozen, so both answer alike. Version drift is the gap
	 * report's. */
	const r = spawnSync(
		process.execPath,
		[
			"-e",
			`try {
  require(${JSON.stringify(require.resolve("./lib/resolve-core.js"))}).resolveCore({ warn: () => undefined });
} catch (err) {
  process.stderr.write(err instanceof Error ? err.message : String(err));
  process.exit(1);
}`,
		],
		{ cwd: root, encoding: "utf8", stdio: ["ignore", "ignore", "pipe"] },
	);
	if (r.status === 0) return null;
	return [
		`FAIL: ${shims.map((hook) => `.husky/${hook}`).join(", ")} find no workflow-core to run, so this repo's commits are refused and its other hook checks do not run:`,
		`  ${r.stderr.trim()}`,
		NO_CORE_FIX,
	].join("\n");
}

/**
 * The plugin's manifest, or null where it will not read.
 * @param {string} pluginRoot
 */
function readManifest(pluginRoot) {
	try {
		return JSON.parse(
			fs.readFileSync(`${pluginRoot}/.claude-plugin/plugin.json`, "utf8"),
		);
	} catch {
		return null;
	}
}

/**
 * The line saying a newer install awaits the next session, or null.
 * @param {any} state
 * @param {string} name
 * @returns {string|null}
 */
function materialisedNotLiveLine(state, name) {
	if (!state.materialisedNotLive) return null;
	return (
		`${name}: materialised but not yet live — ${state.runningPlugin?.version} is installed, this session is running ${state.loadedVersion}. ` +
		"Nothing to do: this session keeps the plugin it started with, and the next one will be current."
	);
}

/**
 * The lines predicting the rotation's refusal, or none.
 * @param {any} state
 * @returns {string[]}
 */
function refConflictLines(state) {
	/* The same cross-scope ref conflict `materialisePlugin`'s
	 * `predictedRefConflict` (workflow-core#258) checks, read here too (workflow-core#318). Predicted
	 * only, re-checked every session. */
	if (!state.gaps.supplyBehindPin || typeof state.pin.url !== "string")
		return [];
	const conflict = predictedRefConflict(
		resolveConfigDir(),
		state.pin.marketplace,
		`${state.pin.url}#${state.pin.ref}`,
	);
	if (!conflict) return [];
	return [
		"",
		"This rotation is predicted to be refused: " +
			`${refConflictExplanation(state.pin.marketplace, conflict)} — then run ` +
			"the commands above.",
	];
}

/**
 * The rule fragments the report carries, each preceded by a blank line.
 * @param {boolean} supplyBehindPin
 * @returns {string[]}
 */
function ruleLines(supplyBehindPin) {
	const lines = [];
	try {
		lines.push("", ruleText("adopter-materialise-sequence"));
	} catch {
		/* A missing/empty fragment is caught elsewhere (check-guard-registry.js);
		 * the gap and commands above still reach the session either way. */
	}
	if (supplyBehindPin) {
		/* Only where the pin itself has moved: a session reading this report
		 * may be the one about to advance it further, and the consent
		 * boundary is about that write, never about closing the gap below it. */
		try {
			lines.push("", ruleText("adopter-pin-consent"));
		} catch {
			/* see above */
		}
	}
	return lines;
}

/**
 * @param {{root: string, pluginRoot: string, runningRoot?: string}} at
 *   `runningRoot` is `CLAUDE_PLUGIN_ROOT`, absent where unset — never
 *   `pluginRoot`'s fallback to the host root
 * @returns {string|null}
 */
function buildReport({ root, pluginRoot, runningRoot }) {
	// the blocks that report whatever the gap state (header)
	const standing =
		[
			shimBlock(root),
			hookRootBlock(root, runningRoot),
			owedBlock(root, pluginRoot),
		]
			.filter(Boolean)
			.join("\n\n") || null;
	/** @param {string|null} text @returns {string|null} */
	const join = (text) => {
		if (!standing) return text;
		return text ? `${text}\n\n${standing}` : standing;
	};

	const plugin = readManifest(pluginRoot);
	if (!plugin?.name) return join(null);

	const state = readPluginState({ root, pluginRoot });
	// directory-sourced, branch- or SHA-pinned, or no pin resolved at all
	if (!state.pin) return join(null);
	if (!state.gaps.supplyBehindPin && !state.gaps.installBehindSupply)
		/* Nothing is owed on the PIN here — the records agree and the only
		 * thing behind is this process's own bytes, which end with it (workflow-core#243). */
		return join(materialisedNotLiveLine(state, plugin.name));
	// The founder already said no to this exact tag in this exact repo (workflow-core#245)
	// — a different tag, or the same tag in a different adopter, still reports.
	if (isDeclined(root, state.pin.ref)) return join(null);

	const lines = [];
	const gaps = [];
	if (state.gaps.supplyBehindPin) gaps.push("supply behind pin");
	if (state.gaps.installBehindSupply) gaps.push("install behind supply");
	/* Three records, each named as itself: a single "previously" label would
	 * name the supply's ref, which is the previous version only in the
	 * both-gaps case (workflow-core#251 item 4). */
	lines.push(
		`${plugin.name}: ${gaps.join(", ")} — pin is ${state.pin.ref}, ` +
			`supply is on ${state.supply.ref ?? "unresolved"}, ` +
			`running ${state.runningPlugin?.version ?? "unknown"}.`,
	);
	for (const cmd of commandsFor(state, state.pin.marketplace, plugin.name))
		lines.push(`  ${cmd}`);
	lines.push(...refConflictLines(state));
	if (state.contention)
		lines.push(
			`The supply currently sits on ${state.contention}, not this repo's pin — rotating it moves that ref too.`,
		);
	lines.push(...ruleLines(state.gaps.supplyBehindPin));
	const consentCli = `${pluginRoot}/scripts/adopter-consent.js`;
	lines.push(
		"",
		"Put this to the founder as a priced yes/no. Record the answer once given — never invent another route (workflow-core#245):",
		`  node ${shellWord(consentCli)} accept  ${shellWord(root)} ${shellWord(state.pin.ref)}`,
		`  node ${shellWord(consentCli)} decline ${shellWord(root)} ${shellWord(state.pin.ref)}`,
	);
	return join(lines.join("\n"));
}

/** @param {string[]} argv */
function main(argv) {
	/* Outside the try: a bad invocation is not a fail-open case. Nothing was
	 * checked, so it is BROKEN in §N4's alphabet even though the rest of this
	 * file departs from that family (see the header). */
	if (!parseOrExit(argv, CLI).flags["--notify"]) {
		writeFd(2, `${USAGE}\n`);
		return 2;
	}
	try {
		const root = hostRoot();
		const runningRoot = process.env.CLAUDE_PLUGIN_ROOT;
		const pluginRoot = runningRoot ?? root;
		const text = buildReport({ root, pluginRoot, runningRoot });
		if (!text) return 0;
		writeFd(
			1,
			`${JSON.stringify({
				hookSpecificOutput: {
					hookEventName: "SessionStart",
					additionalContext: text,
				},
			})}\n`,
		);
		return 0;
	} catch {
		/* Fails open, silent (workflow-core#238). §N5's third limb — print where a human
		 * reads the output — cannot be met here: this hook's only channel is
		 * the model's context, and a line there on every broken read is the
		 * noise workflow-core#243 forbade. The swallow shows as a gap that stops being
		 * named. */
		return 0;
	}
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
