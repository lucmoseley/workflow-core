/*
 * adopter-skeleton.js — renders the day-one skeleton a fresh adopter needs:
 * the config, the core-owned session-rules file and its never-imported
 * reference sibling, `CLAUDE.md`, `AGENTS.md`, the
 * seven husky hook shims, the tracker's label set and
 * the non-npm tool probe (#5).
 *
 * Pure rendering only — every function takes its inputs and returns text or
 * data. scripts/lib/core-owned-files.js and scripts/init-adopter.js do the
 * writing, the `gh` calls and the probing, so each piece here is testable
 * without a repository. The one exception is `ciStatusCommand`.
 *
 * TEMPLATES SHIP UNDER scripts/, which the plugin release tree carries —
 * lib/plugin-tree.js's COPIED is the shipped set.
 *
 * THE RULES FILE IS REWRITTEN ON EVERY BUMP and the adopter never edits it, so
 * a line whose module is off must be absent rather than commented: an
 * always-loaded file pays for every byte it carries in every session.
 */

const fs = require("node:fs");
const path = require("node:path");
const { MODULES, COMMANDS, CONTRACT } = require("./workflow-core-config.js");
const { formatConfigJson } = require("./config-json.js");
const { requiredGroup } = require("./regex-group.js");
const { caught } = require("./caught.js");
const { CORE_STYLE, namespaced } = require("./output-styles.js");
const { withoutSelfPlugin } = require("./core-hooks.js");

const TEMPLATES = path.join(__dirname, "..", "templates", "adopter");

/** @typedef {import("./workflow-core-config.js").Module} Module */

/** The rules file's path in an adopter, and the marker its first line opens
 * on — `core-owned-files.js` re-renders only a file carrying it. */
const RULES_FILE = ".claude/workflow-core.md";
const CORE_OWNED = "<!-- CORE-OWNED.";

/** The rules file's sibling, never imported: what a session looks up rather
 * than obeys before its first tool call, and the provenance block (#2035). */
const REFERENCE_FILE = ".claude/workflow-core.reference.md";

/** The heading `renderPluginRecord` opens its block on, which `core-owned-files.js`
 * finds to carry that block over a re-render (#941). */
const PROVENANCE_HEADING = "## Plugin provenance";

/** A runner invoking a core script by a repo-relative path — the spelling
 * `rewriteRuleCommands` re-points at the plugin root. */
const RUNNER = /\b(node|bash|sh|python3) scripts\//g;

/** @param {string} name */
const readTemplate = (name) =>
	fs.readFileSync(path.join(TEMPLATES, name), "utf8");

/**
 * The module tag a rules-file line opens with, if any: `- [roadmap] …` or
 * `[governance] …`, tags being the module names alone, or `[!landing] …`, a
 * line kept only where that module is off (#2409).
 */
const TAG = new RegExp(`^(\\s*(?:-\\s+)?)\\[(!?)(${MODULES.join("|")})\\]\\s+`);

/** The comment block that tells a reader how the template is rendered — the
 * template's own instructions, which the rendered file has no use for. */
const TEMPLATE_HEADER = /^<!-- TEMPLATE for [\s\S]*?-->\n/;

/**
 * `read()`, or `absent` where the file it reads does not exist.
 * @template T
 * @param {() => T} read
 * @param {T} absent
 * @returns {T}
 */
function absentAs(read, absent) {
	try {
		return read();
	} catch (err) {
		if (caught(err).code === "ENOENT") return absent;
		throw err;
	}
}

/** The template's span kept only where the adopter has a CI workflow. */
const CI_SPAN = /\{\{#ci\}\}([\s\S]*?)\{\{\/ci\}\}/g;

/**
 * The command an adopter's rules file tells a session to read CI with after a
 * push, or null where it has no workflow to read (#739): its own `check:ci`
 * npm script where it declares one, else the plugin's checker, which
 * `rewriteRuleCommands` spells at the plugin root. Throws on a file it
 * cannot read or parse, rather than naming the wrong command.
 * @param {string} root the adopter's root
 * @returns {string|null}
 */
function ciStatusCommand(root) {
	const workflows = absentAs(
		() => fs.readdirSync(path.join(root, ".github", "workflows")),
		[],
	);
	if (!workflows.some((f) => /\.ya?ml$/.test(f))) return null;
	const scripts = absentAs(
		() =>
			JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"))
				.scripts,
		null,
	);
	return typeof scripts?.["check:ci"] === "string"
		? "npm run check:ci"
		: "node scripts/check-ci-status.js";
}

/**
 * The core-owned `.claude/workflow-core.md`: every untagged line, plus the
 * tagged lines whose module is on (off, for a `[!module]` tag), with the tag
 * stripped, the CI span where `ciCheck` is set, and every core command spelled
 * at `pluginRoot` (`rewriteRuleCommands`).
 * @param {{modules: Module[], founder: string, pluginRoot: string, ciCheck: string|null}} at
 * @returns {string}
 */
function renderSessionRules({ modules, founder, pluginRoot, ciCheck }) {
	const on = new Set(modules);
	const kept = readTemplate("session-rules.md")
		.replace(TEMPLATE_HEADER, "")
		.split("\n")
		.flatMap((line) => {
			const tag = line.match(TAG);
			if (!tag) return [line];
			const isOn = on.has(/** @type {Module} */ (requiredGroup(tag, 3, TAG)));
			const negated = tag[2] === "!";
			return isOn === negated
				? []
				: [line.replace(TAG, requiredGroup(tag, 1, TAG))];
		})
		.join("\n")
		.replace(CI_SPAN, (_, span) => (ciCheck ? span : ""));
	return rewriteRuleCommands(
		substitute(kept, { founder, ci_check: ciCheck ?? "" }),
		pluginRoot,
	);
}

/**
 * The core-owned `.claude/workflow-core.reference.md`, less its provenance
 * block, with every core command spelled at `pluginRoot`.
 * @param {string} pluginRoot
 * @returns {string}
 */
const renderReference = (pluginRoot) =>
	rewriteRuleCommands(
		readTemplate("reference.md").replace(TEMPLATE_HEADER, ""),
		pluginRoot,
	);

/**
 * The rules file's core commands spelled at the plugin's own copy (#654).
 *
 * THE PATH IS ABSOLUTE AND CARRIES THE VERSION: a markdown file has no
 * variable to define once. `core-owned-files.js`
 * re-renders the file on every upgrade, so a bump re-points it.
 *
 * A COMMAND IS a `node`/`bash`/`sh`/`python3 scripts/…` invocation, or a
 * backticked span opening on `scripts/` that carries an argument. A bare
 * backticked path is a file named in prose, and stays.
 * @param {string} text
 * @param {string} pluginRoot absolute path of the installed plugin
 */
function rewriteRuleCommands(text, pluginRoot) {
	const root = path.resolve(pluginRoot);
	const quotedRoot = /^[\w@%+=:,./-]+$/.test(root)
		? root
		: `"${root.replace(/["\\$`]/g, "\\$&")}"`;
	return text
		.replace(RUNNER, (_, runner) => `${runner} ${quotedRoot}/scripts/`)
		.replace(/`scripts\/(?=[^`\s]+ [^`]*`)/g, () => `\`${quotedRoot}/scripts/`);
}

/**
 * A one-line description of what init-adopter materialised, shared between
 * the `installed …` console line and the record appended to
 * `.claude/workflow-core.reference.md` so the two never drift. A directory source
 * carries the checkout's HEAD sha and whether it was dirty at install time
 * (both null where the plugin root carries no readable git — no `.git`
 * there at all, or a `.git` a `rev-parse HEAD` can't read, an unborn HEAD or
 * a corrupt repo among them); a url source carries the ref passed, plus the
 * sha `installed_plugins.json` currently records for it (null before an
 * install has ever landed, or where that file or entry is missing) (#108).
 * @param {import("./plugin-record.js").PluginRecord} at
 * @returns {string}
 */
function describePluginRecord(at) {
	if (at.source === "url") {
		return at.resolvedSha
			? `url source, ref ${at.ref}, HEAD ${at.resolvedSha}`
			: `url source, ref ${at.ref} (sha unknown)`;
	}
	if (at.headSha === null)
		return "directory source, no readable git at the plugin root";
	return `directory source, HEAD ${at.headSha}${at.dirty ? " (dirty)" : ""}`;
}

/**
 * The plugin-provenance block appended to `.claude/workflow-core.reference.md`
 * by every init and upgrade run, so an adopter can read what was installed
 * without re-running it. The seven husky hooks run the core they resolve at
 * each run (`renderHookShim`, below), so this describes what the last
 * init or upgrade installed, not what the hooks run today (#108, #941).
 * @param {import("./plugin-record.js").PluginRecord} at
 * @returns {string}
 */
function renderPluginRecord(at) {
	return [
		"",
		PROVENANCE_HEADING,
		"",
		`- ${describePluginRecord(at)}`,
		"- the seven husky hooks run from `WFC_PLUGIN_ROOT` in both branches, so this is what the last init or upgrade installed, not what the hooks run today",
		"",
	].join("\n");
}

/**
 * @param {string} text
 * @param {Record<string, string>} values
 */
function substitute(text, values) {
	return text.replace(/\{\{(\w+)\}\}/g, (whole, key) => values[key] ?? whole);
}

/**
 * The adopter's config: `founder` plus whatever the founder chose, and nothing
 * derivable — `tracker`, `login` and `corpus` are read off the remote and `gh`
 * at the moment of use, so writing them here would freeze a copy. The one
 * exception is a `corpus` naming extra trackers, which has no derived form.
 * @param {{founder: string, corpus?: string[], modules: Module[], categories: Record<string, string>, commands: Record<string, string|null>, roadmapVersion?: string, walkedTo?: string}} at
 * @returns {string}
 */
function renderConfig({
	founder,
	corpus,
	modules,
	categories,
	commands,
	roadmapVersion,
	walkedTo,
}) {
	/** @type {Record<string, unknown>} */
	const config = { contract: CONTRACT, founder };
	if (corpus) config.corpus = corpus;
	const declared = Object.fromEntries(
		COMMANDS.filter((c) => commands[c]).map((c) => [c, commands[c]]),
	);
	if (Object.keys(declared).length > 0) config.commands = declared;
	config.modules = modules;
	if (Object.keys(categories).length > 0) config.categories = categories;
	/* Only a directory-sourced bootstrap passes this (#252) — a url source
	 * walks from its pin instead, which upgrade.js reads fresh off
	 * `.claude/settings.json` rather than needing a recorded floor here. */
	if (walkedTo) config.walkedTo = walkedTo;
	/* Seeds validate.js's VERSION TRIPWIRE at this repo's own day-one major,
	 * not the core's schema-review checkpoint — an adopter running the core's
	 * unmodified validate.js otherwise trips the warning on its first run
	 * (#54, the ticket that found it). */
	if (modules.includes("roadmap") && roadmapVersion) {
		const major = Number(roadmapVersion.split(".")[0]);
		if (Number.isInteger(major)) config.roadmapMajorPin = major;
	}
	/* Absent already reads as off; written out so the adopter sees the switch
	 * it turns on once it has applied the test it was only offered (#1980,
	 * #2035). */
	config.admissionGate = false;
	config.alwaysLoaded = ["CLAUDE.md", "AGENTS.md", ".claude/workflow-core.md"];
	return formatConfigJson(config);
}

/**
 * `CLAUDE.md`, written once and then the adopter's own.
 * @param {{founder: string, project: string, commands: Record<string, string|null>}} at
 */
function renderClaudeMd({ founder, project, commands }) {
	const declared = COMMANDS.filter((c) => commands[c]).map(
		(c) => `- \`${commands[c]}\` — the repo's ${c.replace("_", " ")} command.`,
	);
	return substitute(readTemplate("CLAUDE.md"), {
		founder,
		project,
		commands:
			declared.length > 0
				? declared.join("\n")
				: "<!-- None declared: `.claude/workflow-core.json` has no `commands`, so every command-gated check skips. -->",
	});
}

/** `AGENTS.md`'s four generic safety sections and its blank invariants section. */
const renderAgentsMd = () => readTemplate("AGENTS.md");

/**
 * The day-one `docs/doc-map.md`: §A with one register table for the generator
 * to render into, and an empty §B and §C.
 * @param {{project: string, date: string}} at
 */
const renderDocMap = ({ project, date }) =>
	substitute(readTemplate("doc-map.md"), { project, date });

/** The day-one `docs/code-standards.md`: the header and an empty primitives
 * table, where a new adopter meets the table at adoption (#3466).
 * @param {{project: string}} at */
const renderCodeStandards = ({ project }) =>
	substitute(readTemplate("code-standards.md"), { project });

/** The day-one `docs/called-cards.md`, under `roadmap`.
 * @param {{founder: string}} at */
const renderCalledCards = ({ founder }) =>
	substitute(readTemplate("called-cards.md"), { founder });

/**
 * The day-one `docs/reference-roadmap.html`: the phase template — five phases,
 * one placeholder card each, current phase 0 — under the adopter's own name and
 * areas.
 * @param {{project: string, categories: Record<string, string>, version: string, stamp: string}} at
 */
function renderRoadmap({ project, categories, version, stamp }) {
	const areas = Object.entries(
		Object.keys(categories).length > 0 ? categories : { core: "Core" },
	)
		.map(([k, v]) => `  ${k}:${JSON.stringify(v)}`)
		.join(",\n");
	return substitute(readTemplate("reference-roadmap.html"), {
		project,
		areas,
		version,
		stamp,
	});
}

/**
 * The hooks whose refusal would stop git: every hook but these three. pre-push
 * refuses no push on a checker that cannot run (#1444), and git ignores
 * post-commit's and post-merge's exit, so none refuses where no core resolves.
 */
const FAIL_OPEN_HOOKS = new Set(["pre-push", "post-commit", "post-merge"]);

/** A line every shim carries, which tells it from an adopter's own hook. */
const SHIM_MARK = "# workflow-core hook shim:";

/** What makes a shim resolve a core, said wherever one does not. */
const NO_CORE_FIX =
	"Fix: open a Claude Code session in this repo so its project-scope workflow-core plugin installs, or set WORKFLOW_CORE_DIR to a workflow-core checkout.";

/**
 * The hook an adopter commits under `.husky/<hook>`: it finds the core at run
 * time through the adopter's own `scripts/lib/resolve-core.js`, exports it as
 * `WFC_PLUGIN_ROOT`, and runs that core's `.husky/<hook>` (#1839). It names no
 * path and no version, so a bump, a pruned plugin version or a fresh clone
 * leaves it as it is.
 *
 * `node -e` requires the helper from the cwd, which git sets to the working
 * tree's top before any hook, and reads no stdin, which `pre-push`'s body
 * needs whole.
 * @param {string} hook one of `HOOKS`
 */
function renderHookShim(hook) {
	const failOpen = FAIL_OPEN_HOOKS.has(hook);
	const consequence = failOpen
		? `workflow-core's ${hook} checks did not run.`
		: "refused: no workflow-core resolves to run this repo's gates.";
	return `#!/usr/bin/env sh
${SHIM_MARK} core-owned; init and upgrade write it and a plugin
# bump leaves it unchanged. A pre-commit gate of this repo's own goes in
# .husky/pre-commit.local.
#
# IMPLICIT:  on every ${hook}, finds workflow-core through scripts/lib/resolve-core.js and runs that core's .husky/${hook}; ${failOpen ? "where none resolves, says so and lets git go on" : "where none resolves, refuses"}.
# JUSTIFIED: fail-safe — a hook naming no plugin path cannot be left pointing at a pruned version or at another machine's install (#1839).
# DEFEAT:    WORKFLOW_CORE_DIR or WORKFLOW_CORE_CHECKOUT chooses the core that runs; the core's .husky/${hook} names its own.

set -e # an adopter's git runs this file itself, outside husky's errexit wrapper (#745)
WFC_PLUGIN_ROOT="$(node -e '
try {
  process.stdout.write(require("./scripts/lib/resolve-core.js").resolveCore());
} catch (err) {
  process.stderr.write(String(err instanceof Error ? err.message : err) + "\\n");
  process.exit(1);
}' </dev/null)" || {
  echo "${hook}: ${consequence} ${NO_CORE_FIX}" >&2
  exit ${failOpen ? 0 : 1}
}
export WFC_PLUGIN_ROOT
exec sh -e "$WFC_PLUGIN_ROOT/.husky/${hook}" "$@"
`;
}

/** @param {string} text */
const isHookShim = (text) =>
	text.split("\n").some((line) => line.startsWith(SHIM_MARK));

/* A hook init or upgrade wrote before #1839 carried the plugin's path on this
 * line (#1168). */
const HOOK_ROOT_LINE = /^WFC_PLUGIN_ROOT=(.*)$/m;

/**
 * The root a pre-#1839 hook's text names, quotes stripped; `null` for a hook
 * carrying no such line, which is the adopter's own, and for a shim, whose
 * assignment is its run-time lookup.
 * @param {string} text
 * @returns {string|null}
 */
function hookRootOf(text) {
	if (isHookShim(text)) return null;
	const value = HOOK_ROOT_LINE.exec(text)?.[1];
	if (value === undefined) return null;
	return value.trim().replace(/^"(.*)"$/, "$1");
}

/** The hooks an adopter installs, which is every hook the core runs. */
const HOOKS = [
	"pre-commit",
	"prepare-commit-msg",
	"commit-msg",
	"pre-merge-commit",
	"pre-applypatch",
	"post-commit",
	"post-merge",
	"pre-push",
];

/**
 * The credential reads no session has a reason to make, as `permissions.deny`
 * patterns. Repo-relative and `~`-relative only: the core spells its home
 * directory absolutely, which is one machine's path, so an adopter's own
 * absolute entries are the founder's to add. The secrets file's pair names its
 * default home only: one moved by XDG_CONFIG_HOME (lib/env-file.js) is not
 * covered (#3202).
 */
const SECRET_DENIES = [
	"Read(./.env)",
	"Read(./.env.*)",
	"Read(./**/*.pem)",
	"Read(~/.config/workflow-core/**)",
	"Bash(cat ~/.ssh/*)",
	"Bash(cat ~/.config/gh/*)",
	"Bash(cat ~/.config/workflow-core/*)",
	"Bash(cat .env*)",
	"Bash(gh auth token*)",
];

/**
 * The settings keys the bootstrap writes AFTER the plugin install, merged onto
 * whatever the adopter's settings already carry: the install rewrites
 * `.claude/settings.json`, so writing them before it loses them.
 * @param {{marketplace: string, source: object, plugin: string, outputStyle: string|null}} at
 * @param {Record<string, unknown>} [existing]
 * @returns {{permissions: {deny: string[]} & Record<string, unknown>,
 *   env: Record<string, unknown>, autoCompactWindow: unknown,
 *   autoMemoryEnabled: unknown,
 *   worktree: Record<string, unknown>,
 *   outputStyle: unknown, extraKnownMarketplaces: Record<string, unknown>,
 *   enabledPlugins: Record<string, boolean>} & Record<string, unknown>} the
 *   shape `.claude/settings.json` takes
 */
function settingsKeys(
	{ marketplace, source, plugin, outputStyle },
	existing = {},
) {
	const env = /** @type {Record<string, unknown>} */ (existing.env ?? {});
	const permissions = /** @type {{deny?: string[]}} */ (
		existing.permissions ?? {}
	);
	const worktree = /** @type {{bgIsolation?: unknown}} */ (
		existing.worktree ?? {}
	);
	return {
		...existing,
		/* A UNION, never a replacement: a deny the adopter added is a deny it
		 * wanted, and dropping one silently widens what a session can read. */
		permissions: {
			...permissions,
			deny: [...new Set([...(permissions.deny ?? []), ...SECRET_DENIES])],
		},
		env: { ...env, CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP: "1" },
		/* `autoCompactWindow` and `autoMemoryEnabled` below default to the core's
		 * own `.claude/settings.json` (#1237). */
		autoCompactWindow: existing.autoCompactWindow ?? 320_000,
		/* Auto-memory off, because the store it writes is unversioned and
		 * machine-local while everything else this core asks a session to
		 * remember is an authored, reviewed document or issue. The key cannot
		 * ride in the plugin's own settings file — unknown keys there are
		 * ignored — so the bootstrap has to write it here. An adopter's
		 * explicit `null` reads as unset and becomes `false` (#192). */
		autoMemoryEnabled: existing.autoMemoryEnabled ?? false,
		/* With isolation on, the tool that performs it is not offered in a
		 * background session, so every file edit fails — including the edit to
		 * this key (02ab82f3, carried to adopters at #193). Concurrent sessions
		 * are held apart by the arbiter's file claims instead, which an adopter
		 * gets from the plugin. A nested merge, not a flat one: an adopter's
		 * other `worktree` keys, and a deliberate value here, stay. A `null`
		 * either side reads as unset. */
		worktree: {
			...worktree,
			bgIsolation: worktree.bgIsolation ?? "none",
		},
		/* `core-voice` was this default until #1944, and names no style: the
		 * harness namespaces a plugin's, so a setting still carrying it is the
		 * old default and takes the new one. Residual: an adopter's own project
		 * style named `core-voice` is replaced too. */
		outputStyle:
			outputStyle ??
			(existing.outputStyle === "core-voice"
				? undefined
				: existing.outputStyle) ??
			namespaced(plugin, CORE_STYLE),
		extraKnownMarketplaces: {
			.../** @type {object} */ (existing.extraKnownMarketplaces ?? {}),
			[marketplace]: { source },
		},
		enabledPlugins: {
			...withoutSelfPlugin(
				/** @type {Record<string, boolean>} */ (existing.enabledPlugins ?? {}),
			),
			[`${plugin}@${marketplace}`]: true,
		},
	};
}

/**
 * The tracker's labels: the core's 19, the module-gated ones, and one per
 * declared category. Never the five vendored-vocabulary names, which this repo
 * retired — a label created here is a label a skill will offer.
 * @param {{modules: Module[], categories: Record<string, string>}} at
 * @returns {{name: string, color: string, description: string}[]}
 */
function labelPlan({ modules, categories }) {
	const on = new Set(modules);
	const labels = [...CORE_LABELS];
	if (on.has("governance")) labels.push(GATED_LABELS["manual-finding"]);
	if (on.has("suites")) labels.push(GATED_LABELS["ci-red"]);
	for (const [key, title] of Object.entries(categories)) {
		labels.push({
			name: key,
			color: "BFD4F2",
			description: `Category: ${title}. One per \`categories\` key in .claude/workflow-core.json.`,
		});
	}
	return labels;
}

/** @type {{name: string, color: string, description: string}[]} */
const CORE_LABELS = [
	{
		name: "takes:wayfinder",
		color: "1d76db",
		description:
			"An open question whose resolution is a decision. /wayfinder <n>.",
	},
	{
		name: "takes:to-spec",
		color: "1d76db",
		description:
			"A chunk large enough to need a spec before tickets. /to-spec <n>.",
	},
	{
		name: "takes:to-tickets",
		color: "1d76db",
		description: "A spec ready to break into tickets. /to-tickets <n>.",
	},
	{
		name: "takes:implement",
		color: "1d76db",
		description: "A specified unit of work. /implement <n>.",
	},
	{
		name: "takes:triage",
		color: "1d76db",
		description: "Disposition not yet decided. /triage <n>.",
	},
	{
		name: "takes:human",
		color: "5319e7",
		description: "Done outside Claude Code entirely.",
	},
	{
		name: "takes:children",
		color: "5319e7",
		description:
			"A container: every remaining action sits on its open sub-issues. Open a child, not this.",
	},
	{
		name: "kind:spec",
		color: "5319E7",
		description: "A spec/PRD — parent document, not a unit of work",
	},
	{
		name: "kind:ticket",
		color: "0052CC",
		description: "A unit of implementable work, broken out of a spec",
	},
	{
		name: "kind:brief",
		color: "0E8A16",
		description:
			"A hand-off ticket a many-destination map files per deliverable, awaiting its spec",
	},
	{
		name: "wayfinder:map",
		color: "0E4B99",
		description: "Wayfinder map (root issue)",
	},
	{
		name: "wayfinder:research",
		color: "1D76DB",
		description: "Wayfinder ticket: research (AFK)",
	},
	{
		name: "wayfinder:prototype",
		color: "5319E7",
		description: "Wayfinder ticket: prototype (HITL)",
	},
	{
		name: "wayfinder:grilling",
		color: "B60205",
		description: "Wayfinder ticket: grilling (HITL)",
	},
	{
		name: "wayfinder:task",
		color: "0E8A16",
		description: "Wayfinder ticket: task",
	},
	{
		name: "waiting:external",
		color: "FBCA04",
		description:
			"Handed off outside the project; selection ranks it up once the wait reaches 7 days.",
	},
	{
		name: "parked",
		color: "FEF2C0",
		description:
			"Waits on the founder; an away-mode refill loop skips it, a normal-mode one resumes it first.",
	},
	{
		name: "urgent",
		color: "D93F0B",
		description:
			"Jumps the selection queue, for every descendant and blocker. Holds until closed or removed.",
	},
	{
		name: "measured:effort-low",
		color: "C5DEF5",
		description:
			"Implemented by a session at Opus --effort low. Provenance, not state; nothing routes on it.",
	},
];

const GATED_LABELS = {
	"manual-finding": {
		name: "manual-finding",
		color: "C2E0C6",
		description:
			"A finding wider than one settled fact, for the next full operating-manual sync to read.",
	},
	"ci-red": {
		name: "ci-red",
		color: "B60205",
		description: "A red scheduled suite or workflow, filed by the sweep.",
	},
};

/** The tools the machinery needs and no package install supplies.
 *
 * Two are odd ones out; the rest each leave a gate silent when absent.
 * `ruff` refuses the first commit, which stages `scripts/browse.py` (#1463,
 * #1590). `playwright` (#133) leaves `scripts/browse.py` unusable. It is a
 * Python package installed once per machine, never per repo.
 *
 * `which()` looks for a binary on PATH, whereas `browse.py` does `import
 * playwright` — a pip install that puts the CLI somewhere off PATH reads as
 * MISSING though the helper works, and an npm `playwright` shim reads as
 * present though the Python package is absent. `python3 -c "import playwright"`
 * is the real test, which `docs/environment.md` §Browsing a page gives. */
const TOOLS = [
	"shellcheck",
	"actionlint",
	"ruff",
	"jq",
	"gitleaks",
	"gh",
	"playwright",
];

/** Core-owned helper scripts every adopter carries, rewritten on every run.
 * Each is self-contained. `resolve-core.js` is what the hook shims run before
 * any core is found (#1839). */
const HELPERS = ["scripts/browse.py", "scripts/lib/resolve-core.js"];

/** The marked block `core-owned-files.js` keeps in an adopter's `.gitignore`
 * (#737, #773): the core writes its markers and scratch under `.claude/tmp/`
 * and its throwaway suite worktrees under `.claude/worktrees/` (#1774), and
 * `AGENTS.md` tells a session a person's record lives in gitignored
 * `private/`. */
const IGNORE_BEGIN = "# workflow-core:begin";
const IGNORE_END = "# workflow-core:end";
const IGNORED = [".claude/tmp/", ".claude/worktrees/", "/private/"];

/** Each marker pair a block may stand under, rewritten in that order: the
 * current pair, then the one init wrote from #737 until #773, so a repo
 * bootstrapped between the two gains no second copy.
 * @type {[string, string][]} */
const IGNORE_MARKERS = [
	[IGNORE_BEGIN, IGNORE_END],
	[
		"# --- workflow-core: paths the core's rules assume are untracked (init-adopter.js) ---",
		"# --- end workflow-core ignores ---",
	],
];

/**
 * `text` with `lines` appended as whole lines, a missing final newline
 * supplied first.
 * @param {string} text
 * @param {string[]} lines
 */
const appendLines = (text, lines) =>
	`${text}${text === "" || text.endsWith("\n") ? "" : "\n"}${lines.join("\n")}\n`;

/**
 * `.gitignore`'s text with the block holding exactly `lines`, or null where it
 * already does. An existing block — or a legacy one — has its contents
 * replaced where it stands; otherwise the block is appended last, so it
 * overrides an adopter's earlier negation of any of its paths.
 *
 * Residual: a `# workflow-core:begin` with no closing marker after it reads as
 * no block, so a second block is appended — and the next call replaces
 * everything from the stray opener down.
 * @param {string} text the current `.gitignore`, "" where there is none
 * @param {string[]} [lines]
 * @returns {string|null}
 */
function withIgnoreBlock(text, lines = IGNORED) {
	const block = [IGNORE_BEGIN, ...lines, IGNORE_END];
	const rows = text.split("\n");
	/* A CRLF checkout leaves each marker line ending in `\r`. */
	const bare = rows.map((row) => row.replace(/\r$/, ""));
	for (const [open, close] of IGNORE_MARKERS) {
		const start = bare.indexOf(open);
		const end = start === -1 ? -1 : bare.indexOf(close, start + 1);
		if (end === -1) continue;
		const next = [
			...rows.slice(0, start),
			...block,
			...rows.slice(end + 1),
		].join("\n");
		return next === text ? null : next;
	}
	return appendLines(text, block);
}

module.exports = {
	renderSessionRules,
	renderReference,
	ciStatusCommand,
	describePluginRecord,
	renderPluginRecord,
	renderConfig,
	renderClaudeMd,
	renderAgentsMd,
	withIgnoreBlock,
	appendLines,
	renderDocMap,
	renderCodeStandards,
	renderCalledCards,
	renderRoadmap,
	renderHookShim,
	isHookShim,
	NO_CORE_FIX,
	RULES_FILE,
	REFERENCE_FILE,
	CORE_OWNED,
	PROVENANCE_HEADING,
	settingsKeys,
	labelPlan,
	HOOKS,
	hookRootOf,
	HELPERS,
	TOOLS,
};
