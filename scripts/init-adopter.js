#!/usr/bin/env node
/*
 * init-adopter.js — writes the day-one skeleton into a fresh repository, so its
 * first session runs /pick-next, /wayfinder and /implement as they run in the
 * core (#5, build-order step 7).
 *
 * Usage: USAGE below, which `--help` prints. An unknown flag is refused before
 * anything is written, as is a root that is the plugin's own checkout (#743).
 * cli-args-exempt: its own `parse` meets that contract, and the repeatable
 * `--category`/`--command` pairs have no lib/cli-args.js form (#941).
 *
 * --founder and --modules fall back to the config already written, so editing
 * its `modules` and re-running switches a module on (#715); --marketplace-ref
 * falls back to the url pin already in settings, so that re-run does not
 * re-source the plugin from its cache folder (#730, the #700 fault), and with
 * no --plugin-root a directory source keeps its declared path (#731) and a url
 * source's hooks and rules file run from its install row (#736). Commands are
 * inferred where no --command names them (`scripts/lib/infer-commands.js`).
 * A first run with no --modules switches on each module whose subject the
 * tree tracks (`scripts/lib/gate-subjects.js`, #1506). --corpus takes the
 * extra trackers only (#692).
 *
 * --config-dir (#134): opt-in only. With none passed, every `claude` call and
 * the sha read back off it use whatever CLAUDE_CONFIG_DIR the calling session
 * already carries. Passed (resolved against the current working directory,
 * not `--root`), it isolates both from that session's own plugin registry,
 * for a caller (an adopter bootstrap, a test) that must not touch it.
 *
 * THE INSTALL RUNS BEFORE THE SETTINGS KEYS ARE WRITTEN, deliberately: the
 * `claude plugin marketplace add` → `install` → `update` sequence (full
 * recipe: `materialisePlugin`'s JSDoc in `scripts/lib/materialise-plugin.js`)
 * rewrites `.claude/settings.json`'s
 * own marketplace entry as a side effect, dropping a `ref` on a url source, so
 * the settings keys written here would be erased by an install that ran after
 * them (mantahostels#3515 F17). Declaring the plugin in `.claude/settings.json` is not
 * the same as loading it, either way round: nothing reads hooks or skills off
 * that JSON without running that sequence to actually materialise them (#75,
 * #103).
 * `--no-plugin-install` skips it, for a session with no `claude` on `PATH` or
 * a repo that will run the commands itself.
 *
 * IDEMPOTENT, and the two halves differ. The core-owned files —
 * `scripts/lib/core-owned-files.js` lists them — are brought current on
 * every run, as `upgrade.js` brings them; `CLAUDE.md`, `AGENTS.md` and the
 * config are repo-owned and written once — a second run leaves the adopter's
 * own edits alone and says so. `--dry-run` prints the same lines and writes
 * nothing.
 *
 * EXITS 0 written or usage printed / 1 a write or child failed / 2 the arguments
 * are wrong.
 */

const fs = require("node:fs");
const { writeFd } = require("./lib/write-fd.js");
const path = require("node:path");
const { hostRoot } = require("./lib/host-root.js");
const { pluginRecord } = require("./lib/plugin-record.js");
const {
	run,
	installFailure: reason,
	materialisePlugin,
	fixByHand,
} = require("./lib/materialise-plugin.js");
const {
	readConfig,
	resolveKey,
	requireKey,
	MODULES,
	COMMANDS,
	unsetCommands,
	UPSTREAM_TRACKER,
	codeRepoUrl,
	TRACKER_SHAPE,
} = require("./lib/workflow-core-config.js");
const {
	inferCommands,
	runsLintStaged,
	BIOME_STAGED_COMMAND,
} = require("./lib/infer-commands.js");
const { subjectModules } = require("./lib/gate-subjects.js");
const { ghBinary } = require("./lib/gh.js");
const {
	findInstallRecord,
	resolveConfigDir,
	isTagRef,
	sameRelease,
} = require("./lib/plugin-state.js");
const { COST_TABLE, measurerFor } = require("./lib/core-context-cost.js");
const {
	ciStatusCommand,
	describePluginRecord,
	renderConfig,
	renderClaudeMd,
	renderAgentsMd,
	renderDocMap,
	renderCalledCards,
	renderRoadmap,
	RULES_FILE: RULES,
	TOOLS,
} = require("./lib/adopter-skeleton.js");
const {
	bringCoreFiles,
	coreOwnedPaths,
	skeletonPaths,
	ghLabels,
} = require("./lib/core-owned-files.js");
const { RUFF_INSTALL } = require("./lib/formatters.js");
const { caught } = require("./lib/caught.js");

/** @typedef {import("./lib/workflow-core-config.js").Module} Module */

const CONFIG = ".claude/workflow-core.json";
const SETTINGS = ".claude/settings.json";
const ANCHORS = ".claude/guard-registry-anchors.json";

/** The doc-map sidecars every adopter carries, each with its day-one text. */
const SIDECARS = {
	"docs/doc-map-admissions.json": "{}\n",
	"docs/doc-map-high-water.json": '{\n\t"highWaterMark": 0\n}\n',
	"docs/doc-map-restatements.json": "{}\n",
	"docs/doc-map-retired-vocabulary.json": "{}\n",
	"docs/doc-map-superseded.json": "{}\n",
};

/**
 * @typedef {{section: string, class: string, role?: string, route?: string,
 *   reader?: string}} Entry
 */

/** The §A class of every file this writes, by path — the day-one register. */
/** @type {Record<string, Entry>} */
const CLASSES = {
	"CLAUDE.md": {
		section: "Repo-root contracts",
		class: "source-of-truth",
		reader: "agent",
	},
	"AGENTS.md": {
		section: "Repo-root contracts",
		class: "source-of-truth",
		reader: "agent",
	},
	[CONFIG]: {
		section: "Skills & settings",
		class: "source-of-truth",
		role: "The adopter's config — contract, modules, commands, categories",
	},
	[RULES]: {
		section: "Skills & settings",
		class: "generated-only",
		route:
			"workflow-core's `init` only, which rewrites it on every bump; override through `.claude/workflow-core.json`",
		reader: "agent",
	},
	[SETTINGS]: { section: "Skills & settings", class: "free-edit" },
	[ANCHORS]: {
		section: "Skills & settings",
		class: "generated-only",
		route:
			"`node scripts/check-guard-registry.js --review`, which re-anchors a guard whose annotation has been read",
	},
	"docs/doc-map.md": {
		section: "Governance & process docs",
		class: "source-of-truth",
		reader: "agent",
	},
	"docs/doc-map-classes.json": {
		section: "Governance & process docs",
		class: "source-of-truth",
		route:
			"`node scripts/register-doc.js <path> --class <token> --section <name>` for a new key",
	},
};

for (const s of Object.keys(SIDECARS)) {
	CLASSES[s] = {
		section: "Governance & process docs",
		class: "source-of-truth",
	};
}

/** The `roadmap` module's own three documents. */
/** @type {Record<string, Entry>} */
const ROADMAP_CLASSES = {
	"docs/reference-roadmap.html": {
		section: "The roadmap triple",
		class: "source-of-truth",
		route: "**`roadmap-edit` skill only.** Never hand-edit",
		reader: "both",
	},
	"docs/roadmap-digest.md": {
		section: "The roadmap triple",
		class: "derived",
		route: "`gen-roadmap-digest.js`, committed with the HTML",
		reader: "agent",
	},
	"docs/called-cards.md": {
		section: "Governance & process docs",
		class: "source-of-truth",
		route: "Direct, by any session, for a card the founder has called",
		reader: "both",
	},
};

const USAGE = `usage: node scripts/init-adopter.js --founder "<name>" [--root <dir>]
  [--project <name>] [--modules roadmap,suites] [--category tech="Tech & Stack"]
  [--command test="npm test"] [--corpus <owner/name>[,…]] [--plugin-root <dir>]
  [--marketplace <name>] [--marketplace-ref <tag>] [--no-tracker]
  [--no-plugin-install] [--dry-run] [--config-dir <dir>] [--help]`;

/** The flags `main` reads, by whether one takes a value. */
const VALUE_FLAGS = new Set([
	"founder",
	"root",
	"project",
	"modules",
	"corpus",
	"plugin-root",
	"marketplace",
	"marketplace-ref",
	"config-dir",
]);
const BARE_FLAGS = new Set(["no-tracker", "no-plugin-install", "dry-run"]);

/** @param {string[]} argv */
function parse(argv) {
	/** @type {Record<string, string>} */
	const values = {};
	/** @type {Set<string>} */
	const flags = new Set();
	/** @type {Record<string, string>} */
	const categories = {};
	/** @type {Record<string, string|null>} */
	const commands = unsetCommands();
	const parsed = { values, flags, categories, commands };
	for (let i = 0; ; i++) {
		const arg = argv[i];
		if (arg === undefined) break;
		i = takeArg(arg, { argv, i }, parsed);
	}
	return parsed;
}

/**
 * Records `arg`, which sits at `argv[i]`, in `parsed`.
 * @param {string} arg
 * @param {{argv: string[], i: number}} at
 * @param {{values: Record<string, string>, flags: Set<string>, categories: Record<string, string>, commands: Record<string, string|null>}} parsed accumulator: the argument lands in its table or flag set
 * @returns {number} the index of the last argument consumed
 */
function takeArg(arg, { argv, i }, parsed) {
	if (arg === "--category" || arg === "--command") {
		const { key, value } = takePair(arg, argv[i + 1] ?? "");
		if (arg === "--category") parsed.categories[key] = value;
		else parsed.commands[key] = value;
		return i + 1;
	}
	if (arg === "--help" || arg === "-h") {
		parsed.flags.add("help");
		return i;
	}
	if (!arg.startsWith("--")) throw new Error(`unexpected argument "${arg}"`);
	const { name, value } = takeFlag(arg, argv[i + 1]);
	if (value === undefined) {
		parsed.flags.add(name);
		return i;
	}
	parsed.values[name] = value;
	return i + 1;
}

/**
 * One `--category`/`--command` pair, split for its table.
 * @param {string} arg
 * @param {string} pair
 * @returns {{key: string, value: string}}
 */
function takePair(arg, pair) {
	const at = pair.indexOf("=");
	if (at < 1) throw new Error(`${arg} wants <key>=<value>, got "${pair}"`);
	const key = pair.slice(0, at);
	const value = pair.slice(at + 1);
	if (arg === "--command" && !COMMANDS.includes(/** @type {never} */ (key)))
		throw new Error(`no command "${key}" — one of ${COMMANDS.join(", ")}`);
	return { key, value };
}

/**
 * One `--<name>` flag, bare or taking the value after it.
 * @param {string} arg
 * @param {string|undefined} next
 * @returns {{name: string, value?: string}} the flag, with `value` where it
 *   consumed `next`
 */
function takeFlag(arg, next) {
	const name = arg.slice(2);
	if (BARE_FLAGS.has(name)) return { name };
	if (!VALUE_FLAGS.has(name)) throw new Error(`unknown flag "${arg}"`);
	if (next !== undefined && !next.startsWith("--"))
		return { name, value: next };
	return { name };
}

/**
 * Whether two paths name one directory, symlinks resolved.
 * @param {string} a
 * @param {string} b
 */
function sameDir(a, b) {
	try {
		return fs.realpathSync(a) === fs.realpathSync(b);
	} catch {
		return path.resolve(a) === path.resolve(b);
	}
}

/** The date an adopter's documents are stamped with, in the roadmap's format. */
function stamp() {
	const now = new Date();
	/* THE MACHINE'S OWN ZONE, not UTC. The roadmap validator compares the stamp
	 * against the local day, so a UTC stamp WARNs `STAMP MISDATED` on the
	 * bootstrap's own first commit wherever the machine is far enough east
	 * (#5). TZ in the environment overrides it, as it does everywhere else. */
	const date = now.toLocaleDateString("en-GB", {
		day: "numeric",
		month: "long",
		year: "numeric",
	});
	const time = now.toLocaleTimeString("en-GB", {
		hour: "2-digit",
		minute: "2-digit",
	});
	return { date, stamp: `${date}, ${time}` };
}

/**
 * The roadmap's own version line, at the core's major: `vMAJOR.MINOR`, which
 * is the only shape check-digest-version.js reads — the plugin's third
 * component has no place in a document version.
 */
/**
 * A `.claude-plugin/<file>` manifest, parsed, or `null` where it is missing,
 * unreadable or not an object — the one shape `coreVersion` and
 * `manifestMarketplaceName` both need.
 * @param {string} pluginRoot
 * @param {string} file
 * @returns {Record<string, unknown>|null}
 */
function readManifest(pluginRoot, file) {
	try {
		const parsed = JSON.parse(
			fs.readFileSync(path.join(pluginRoot, ".claude-plugin", file), "utf8"),
		);
		return parsed && typeof parsed === "object" ? parsed : null;
	} catch {
		return null;
	}
}

/**
 * The plugin's own declared full version at `pluginRoot` — never defaulted,
 * so a caller that must not guess (a directory bootstrap's `walkedTo`, #252)
 * can tell "the manifest didn't say" from "1.0.0".
 * @param {string} pluginRoot
 * @returns {string|null}
 */
function manifestVersion(pluginRoot) {
	const version = readManifest(pluginRoot, "plugin.json")?.version;
	return typeof version === "string" ? version : null;
}

/**
 * @param {string} pluginRoot
 * @param {string|null} [ref] a url pin, whose tag stands in for a manifest
 *   not yet installed at `pluginRoot` (#736)
 */
function coreVersion(pluginRoot, ref) {
	const full =
		manifestVersion(pluginRoot) ||
		(ref && isTagRef(ref) ? ref.replace(/^v/, "") : "1.0.0");
	const [major, minor = "0"] = full.split(".");
	return `${major}.${minor}`;
}

/**
 * Why `dir` is not the plugin pinned at `ref`, or null where it is: a checkout
 * whose HEAD carries no `ref` tag, or an install whose manifest names another
 * version.
 * @param {string} dir
 * @param {string} ref
 * @returns {string|null}
 */
function offPin(dir, ref) {
	if (fs.existsSync(path.join(dir, ".git"))) {
		let tags;
		try {
			tags = run(dir, ["git", "tag", "--points-at", "HEAD"]).split("\n");
		} catch (err) {
			return `a checkout whose tags git could not read (${reason(err)})`;
		}
		return tags.includes(ref) ? null : `a checkout whose HEAD is not ${ref}`;
	}
	const version = manifestVersion(dir);
	return sameRelease(version, ref)
		? null
		: `version ${version ?? "unknown"}, not ${ref}`;
}

/**
 * `pluginRoot` where its manifest can be read, else the code running: a
 * --plugin-root the install has yet to create answers nothing (#736).
 * @param {string} pluginRoot
 */
const readableRoot = (pluginRoot) =>
	manifestVersion(pluginRoot) ? pluginRoot : path.join(__dirname, "..");

/**
 * The plugin copy a url-sourced adopter's hooks and rules file run from where
 * no --plugin-root names one (#736): this repo's own install row, else
 * `fallback`, with a warning where that is off the pin.
 * @param {{root: string, marketplace: string, ref: string, fallback: string,
 *   configDir?: string, out: (line: string) => void}} at
 */
function installedRoot({ root, marketplace, ref, fallback, configDir, out }) {
	const row = findInstallRecord(
		path.join(resolveConfigDir(configDir), "plugins"),
		"workflow-core",
		marketplace,
		root,
	);
	const chosen =
		row &&
		fs.statSync(row.installPath, { throwIfNoEntry: false })?.isDirectory()
			? row.installPath
			: fallback;
	const off = offPin(chosen, ref);
	if (off)
		out(
			`WARNING the hooks and rules file run from ${chosen}, ${off}${chosen === fallback ? ", since no install row names this repo" : ""} — re-run with --plugin-root <the installed ${ref} copy>`,
		);
	return chosen;
}

/**
 * The marketplace's own declared name — `.claude-plugin/marketplace.json`'s
 * `name` field. `claude plugin marketplace add` registers under THIS name
 * regardless of what a caller believes the marketplace is called, so it is
 * the source of truth the pluginId is built from. Null where the manifest is
 * missing, unreadable or names nothing, so an unusual plugin root skips the
 * check rather than blocking every run (#90).
 * @param {string} pluginRoot
 * @returns {string|null}
 */
function manifestMarketplaceName(pluginRoot) {
	const name = readManifest(pluginRoot, "marketplace.json")?.name;
	return typeof name === "string" ? name : null;
}

/** @typedef {import("./lib/plugin-record.js").PluginSource} PluginSource */

class Writer {
	/** @param {{root: string, dryRun: boolean, out: (line: string) => void}} at */
	constructor({ root, dryRun, out }) {
		this.root = root;
		this.dryRun = dryRun;
		this.out = out;
	}

	/**
	 * @param {string} rel
	 * @param {string} body
	 * @param {{once?: boolean, mode?: number}} [opts] `once` leaves an existing
	 *   file alone.
	 */
	write(rel, body, { once = false, mode } = {}) {
		const at = path.join(this.root, rel);
		const exists = fs.existsSync(at);
		if (once && exists) {
			this.out(`kept    ${rel} (repo-owned, already written)`);
			return false;
		}
		if (!this.dryRun) {
			fs.mkdirSync(path.dirname(at), { recursive: true });
			fs.writeFileSync(at, body);
			if (mode !== undefined) fs.chmodSync(at, mode);
		}
		this.out(
			this.dryRun
				? `would   ${exists ? "rewrite" : "write"} ${rel}`
				: `${exists ? "rewrote" : "wrote  "} ${rel}`,
		);
		return true;
	}
}

/**
 * The `commands` line: each declared command and where it came from.
 * @param {{commands: Record<string, string|null>,
 *   commandsFrom: Record<string, string>, kept: Record<string, unknown>|null,
 *   out: (line: string) => void}} at
 */
function reportCommands({ commands, commandsFrom, kept, out }) {
	const found = COMMANDS.filter((c) => commands[c]);
	if (found.length > 0)
		out(
			`commands ${found.map((c) => `${c}: ${commands[c]} (${commandsFrom[c]})`).join("; ")}`,
		);
	else if (kept) out(`commands none declared in ${CONFIG}`);
	else
		out(
			"commands none — no package.json script, pytest config or *.test.js file names one",
		);
}

/**
 * The `corpus` line, or why a kept config does not carry it.
 * @param {{corpus?: string[], kept: Record<string, unknown>|null,
 *   out: (line: string) => void}} at
 */
function reportCorpus({ corpus, kept, out }) {
	if (corpus && !kept) out(`corpus   ${corpus.join(", ")}`);
	else if (corpus && JSON.stringify(kept?.corpus) !== JSON.stringify(corpus))
		out(
			`corpus   NOT written — ${CONFIG} is kept, so declare it there by hand: ${JSON.stringify(corpus)}`,
		);
}

/**
 * The install source: a url pin where a marketplace ref is set, else a
 * directory.
 * @param {{pluginRoot: string, marketplaceRef: string|null,
 *   marketplacePath: string|null}} at
 * @returns {PluginSource}
 */
function installSource({ pluginRoot, marketplaceRef, marketplacePath }) {
	return marketplaceRef
		? {
				source: "url",
				url: codeRepoUrl({ root: readableRoot(pluginRoot) }),
				ref: marketplaceRef,
			}
		: { source: "directory", path: marketplacePath ?? pluginRoot };
}

/**
 * @param {{root: string, pluginRoot: string, pluginRootGiven: boolean,
 *   founder: string, project: string,
 *   modules: Module[], categories: Record<string, string>, corpus?: string[],
 *   commands: Record<string, string|null>, commandsFrom: Record<string, string>,
 *   kept: Record<string, unknown>|null,
 *   marketplace: string,
 *   marketplaceRef: string|null, marketplacePath: string|null, tracker: boolean, pluginInstall: boolean,
 *   dryRun: boolean, configDir?: string, out: (line: string) => void}} at
 */
function init(at) {
	const {
		root,
		pluginRoot: givenRoot,
		founder,
		project,
		modules,
		categories,
		corpus,
		commands,
		commandsFrom,
		kept,
		dryRun,
		out,
	} = at;
	const w = new Writer({ root, dryRun, out });
	reportCommands({ commands, commandsFrom, kept, out });
	reportCorpus({ corpus, kept, out });
	const when = stamp();
	const version = coreVersion(givenRoot, at.marketplaceRef);
	const roadmap = modules.includes("roadmap");

	/* The install source, resolved before anything is written: the "installed
	 * …" line and the record (step 4, after materialise settles a url
	 * source's resolved sha) both describe it. */
	const source = installSource(at);

	/* A directory-sourced bootstrap's own floor (#252): the full plugin
	 * version being bootstrapped from, not `version`'s major.minor (that one
	 * seeds `roadmapMajorPin`, a different pin with a different shape).
	 * upgrade.js reads this as `walkedTo` so a directory adopter whose plugin
	 * checkout moves on before its first `upgrade` run still floors at what
	 * bootstrap actually saw. A url source gets none: it walks from its pin
	 * instead.
	 *
	 * `walkedTo` is omitted rather than written at a guessed floor where the
	 * manifest is unreadable. */
	const bootstrapVersion = manifestVersion(givenRoot);

	/* 1. The config, core-owned only. */
	w.write(
		CONFIG,
		renderConfig({
			founder,
			corpus,
			modules,
			categories,
			commands,
			roadmapVersion: version,
			walkedTo:
				source.source === "directory" && bootstrapVersion
					? `v${bootstrapVersion}`
					: undefined,
		}),
		{ once: true },
	);

	/* 2. The repo-owned half, written once. */
	w.write("CLAUDE.md", renderClaudeMd({ founder, project, commands }), {
		once: true,
	});
	w.write("AGENTS.md", renderAgentsMd(), { once: true });

	/* 3. Materialise the plugin, before declaring it (header, above). Idempotent
	 * on all three calls: an already-declared marketplace no-ops rather than
	 * erroring, and an already-installed plugin is caught up by the trailing
	 * `update` call rather than left at whatever it was (`install` alone
	 * no-ops there without re-fetching, #103). Non-fatal: a session with no
	 * `claude` on PATH, or a source it can't reach, leaves
	 * the repo usable, one hand-run command short of loading. `WFC_CLAUDE_BIN`
	 * overrides the binary, matching every other script that shells out to
	 * `claude` (docs/code-standards-base.md §N7, scripts/lib/agent-liveness.js). */
	const claudeBin = process.env.WFC_CLAUDE_BIN || "claude";
	const pluginId = `workflow-core@${at.marketplace}`;
	const result = materialiseStep({ at, source, claudeBin, pluginId });

	/* Read fresh here, after materialise above ran (or didn't) — a re-run
	 * under `--no-plugin-install` still resolves a url source's sha where an
	 * earlier run already installed it, since this reads what's actually on
	 * disk rather than gating on this run's own outcome. */
	const record = pluginRecord(source, {
		root,
		pluginName: "workflow-core",
		marketplace: at.marketplace,
		configDir: at.configDir,
	});
	out(`record   ${describePluginRecord(record)}`);

	const pluginRoot = resolvePluginRoot({ at, source });
	if (result) reportInstall({ result, pluginId, record, out });

	/* 4. Every core-owned file — the hooks, helpers, rules file, settings
	 * keys, `.gitignore` block, context-cost row and labels — through the one
	 * module every upgrade also runs (#1501). After the install, which rewrites
	 * `.claude/settings.json` (header), and after `record`. The cost row is
	 * measured only off an install that succeeded, so `--no-plugin-install`
	 * still makes no `claude` call (#679); a dry run wrote no settings for it
	 * to read. */
	if (dryRun) out(`would   add the ${pluginId} row to ${COST_TABLE}`);
	/* A dry run calls gh not at all, as the tracker step's own does. */
	/** @type {import("./lib/core-owned-files.js").Labels} */
	let labels = ghLabels(root);
	if (!at.tracker) labels = { off: "--no-tracker" };
	else if (dryRun) labels = { off: "--dry-run calls gh not at all" };
	bringCoreFiles({
		root,
		pluginRoot,
		dryRun,
		out,
		fresh: true,
		config: { founder, modules, categories },
		record,
		pin: { marketplace: at.marketplace, source, plugin: "workflow-core" },
		measureCore: dryRun ? undefined : costMeasurer({ at, result, claudeBin }),
		labels,
	});
	if (!dryRun) run(root, ["git", "config", "core.hooksPath", ".husky"]);
	out("set     core.hooksPath to .husky");

	/* The hooks' own IMPLICIT / JUSTIFIED / DEFEAT annotations are the core's,
	 * read and accepted upstream, so the adopter's registry records them as
	 * anchored rather than failing its first commit on seven unread headers. */
	const anchored = anchorHooks({ root, pluginRoot, dryRun, out });

	/* 7. The roadmap triple, under its module. */
	if (roadmap)
		writeRoadmap({
			w,
			root,
			pluginRoot,
			project,
			founder,
			categories,
			version,
			stamp: when.stamp,
			dryRun,
			out,
		});
	else {
		out(`skipped the roadmap triple — module "roadmap" is off`);
	}

	/* 8. The doc-map: §A over this residue, empty §B, §C and sidecars. Written
	 * under every module set, because check-doc-map.js is ungated: a repo with
	 * no doc map fails its first commit. */
	w.write("docs/doc-map.md", renderDocMap({ project, date: when.date }), {
		once: true,
	});
	for (const [sidecar, seed] of Object.entries(SIDECARS))
		w.write(sidecar, seed, { once: true });
	writeClassSidecar({ w, root, sidecar: classRows({ roadmap, anchored }) });
	renderSectionA({ root, pluginRoot, dryRun, out });

	/* 9. The tracker: gh pointed at origin and features probed, nothing
	 * toggled. Its labels are step 4's. */
	if (at.tracker) tracker({ root, dryRun, out });
	else out("skipped the tracker — --no-tracker");

	/* 10. The tools no package install supplies. */
	reportTools(out);

	out("");
	out(
		"Next: commit the skeleton through the full hook stack — that commit IS the test.",
	);
	/* INTENT-TO-ADD FIRST. A pathspec commit cannot reach a path git has never
	 * seen, and every path here is new, so without this git exits 1 having
	 * committed nothing. */
	/* A dry run wrote nothing, so it names every path a real run may. */
	const paths = skeletonPaths(
		(rel) => dryRun || fs.existsSync(path.join(root, rel)),
	).join(" ");
	out(`  git add -N ${paths}`);
	out(`  git commit -m "<why this repo exists>" -- ${paths}`);
	return 0;
}

/** @typedef {(line: string) => void} Out */

/**
 * What a step copying files out of the plugin root carries: the writer, the
 * root it copies from, and where it reports.
 * @typedef {{w: Writer, pluginRoot: string, out: Out}} CopyStep
 */

/**
 * What a step running a plugin script against the adopter's repo carries:
 * the repo, the plugin root the script lives in, whether this is a dry run,
 * and where it reports.
 * @typedef {{root: string, pluginRoot: string, dryRun: boolean, out: Out}} RunStep
 */

/**
 * Step 3's install, or the line saying why it did not run.
 * @param {{at: {root: string, marketplace: string, pluginInstall: boolean,
 *   dryRun: boolean, configDir?: string, out: Out}, source: PluginSource,
 *   claudeBin: string, pluginId: string}} step
 * @returns {ReturnType<typeof materialisePlugin> | null}
 */
function materialiseStep({ at, source, claudeBin, pluginId }) {
	if (at.dryRun) {
		at.out(
			`would  materialise workflow-core@${at.marketplace} (claude plugin marketplace add → install → update)`,
		);
		return null;
	}
	if (!at.pluginInstall) {
		at.out("skipped materialising the plugin — --no-plugin-install");
		return null;
	}
	/* `#<ref>` is the CLI's own syntax for a non-default branch/tag on a git
	 * source — with no ref, main's HEAD is what gets cloned and installed,
	 * whatever `ref` settingsKeys() goes on to declare. */
	const addSource =
		source.source === "url" ? `${source.url}#${source.ref}` : source.path;
	return materialisePlugin({
		root: at.root,
		claudeBin,
		addSource,
		pluginId,
		configDir: at.configDir,
	});
}

/**
 * The plugin root everything below step 3 renders or runs, refused where it
 * does not exist.
 * @param {{at: {root: string, pluginRoot: string, pluginRootGiven: boolean,
 *   marketplace: string, dryRun: boolean, configDir?: string, out: Out},
 *   source: PluginSource}} step
 * @returns {string}
 */
function resolvePluginRoot({ at, source }) {
	/* Everything below renders or runs the plugin at this path, which a url
	 * pin wants to be its installed copy, resolvable only after the install. */
	const pluginRoot =
		source.source === "url" && !at.pluginRootGiven
			? installedRoot({
					root: at.root,
					marketplace: at.marketplace,
					ref: source.ref,
					fallback: at.pluginRoot,
					configDir: at.configDir,
					out: at.out,
				})
			: at.pluginRoot;
	if (!at.dryRun && !fs.statSync(pluginRoot, { throwIfNoEntry: false }))
		throw new Error(
			`the plugin root ${pluginRoot} does not exist, so the hooks and rules file would run nothing — install the plugin there, then re-run`,
		);
	return pluginRoot;
}

/**
 * What the install did, and the hand-run command where it fell short.
 * @param {{result: ReturnType<typeof materialisePlugin>, pluginId: string,
 *   record: ReturnType<typeof pluginRecord>, out: Out}} at
 */
function reportInstall({ result, pluginId, record, out }) {
	if (!result.ok) {
		out(
			`FAILED materialising the plugin: ${result.reason} — finish by hand: ` +
				fixByHand(result),
		);
		return;
	}
	out(
		`installed ${pluginId} — hooks and skills now load with no --plugin-dir (${describePluginRecord(record)})`,
	);
	if (result.updateFailed)
		out(
			`update after install FAILED for ${pluginId}: ${result.updateFailed} — finish by hand: ${result.pluginUpdate.join(" ")}`,
		);
}

/**
 * @param {{at: {root: string, configDir?: string},
 *   result: ReturnType<typeof materialisePlugin> | null, claudeBin: string}} step
 */
function costMeasurer({ at, result, claudeBin }) {
	return result?.ok
		? measurerFor({ root: at.root, claudeBin, configDir: at.configDir })
		: () => ({ reason: "the plugin was not materialised this run" });
}

/**
 * @param {RunStep} at
 * @returns {boolean} false where the anchoring run failed
 */
function anchorHooks({ root, pluginRoot, dryRun, out }) {
	const registry = path.join(pluginRoot, "scripts/check-guard-registry.js");
	if (dryRun) {
		out(`would  anchor the seven hooks in ${ANCHORS}`);
		return true;
	}
	try {
		run(root, [process.execPath, registry, "--review"], { quiet: true });
		out(`wrote   ${ANCHORS} (the seven hooks anchored)`);
		return true;
	} catch (err) {
		/* Registering an absent file in the class sidecar would fail the
		 * first commit at check-doc-map.js instead, on a message naming
		 * neither this step nor its cause. */
		out(
			`FAILED anchoring the hooks: ${reason(err)} — the first commit will report seven unread hook headers; clear them with \`node <plugin>/scripts/check-guard-registry.js --review\``,
		);
		return false;
	}
}

/**
 * Step 7's roadmap triple: the HTML and called cards written once, the digest
 * rendered from the HTML.
 * @param {CopyStep & RunStep & {project: string, founder: string,
 *   categories: Record<string, string>, version: string, stamp: string}} at
 */
function writeRoadmap(at) {
	const { w, root, pluginRoot, project, founder, dryRun, out } = at;
	w.write(
		"docs/reference-roadmap.html",
		renderRoadmap({
			project,
			categories: at.categories,
			version: at.version,
			stamp: at.stamp,
		}),
		{ once: true },
	);
	w.write("docs/called-cards.md", renderCalledCards({ founder }), {
		once: true,
	});
	const generator = path.join(
		pluginRoot,
		".claude/skills/roadmap-edit/scripts/gen-roadmap-digest.js",
	);
	if (dryRun) out("would  docs/roadmap-digest.md (from the roadmap HTML)");
	else if (fs.existsSync(generator)) {
		run(root, [
			process.execPath,
			generator,
			"docs/reference-roadmap.html",
			"--out",
			"docs/roadmap-digest.md",
		]);
		out("wrote   docs/roadmap-digest.md (rendered from the roadmap HTML)");
	} else out(`MISSING ${generator} — no digest was rendered`);
}

/**
 * The class sidecar's rows for every file this writes, the anchors file left
 * out where anchoring failed.
 * @param {{roadmap: boolean, anchored: boolean}} at
 * @returns {Record<string, object>}
 */
function classRows({ roadmap, anchored }) {
	/** @type {Record<string, object>} */
	const sidecar = {};
	for (const [rel, entry] of Object.entries({
		...CLASSES,
		...(roadmap ? ROADMAP_CLASSES : {}),
	})) {
		if (rel === ANCHORS && !anchored) continue;
		sidecar[rel] = {
			section: entry.section,
			class: entry.class,
			classQualifier: null,
			role: entry.role ?? null,
			route: entry.route ?? null,
			consumes: null,
			...(entry.reader ? { reader: entry.reader } : {}),
		};
	}
	return sidecar;
}

/**
 * `docs/doc-map-classes.json`, merged under any kept copy.
 * @param {{w: Writer, root: string, sidecar: Record<string, object>}} at
 */
function writeClassSidecar({ w, root, sidecar }) {
	/* A kept sidecar is the adopter's, but a module switched on since it was
	 * written brings documents it never registered, and check-doc-map.js
	 * refuses the commit over them (#730) — so add the rows it lacks, and
	 * change none it has. */
	const keptClasses = keptJson(root, "docs/doc-map-classes.json");
	const keptKeys = new Set(Object.keys(keptClasses ?? {}));
	const merged = { ...sidecar, ...keptClasses };
	/* The sidecar's canonical bytes: keys sorted, tabs, one trailing newline —
	 * register-doc.js's write form, which check-doc-map.js gates. */
	const sorted = Object.fromEntries(
		Object.keys(merged)
			.sort()
			.map((k) => [k, merged[k]]),
	);
	w.write(
		"docs/doc-map-classes.json",
		`${JSON.stringify(sorted, null, "\t")}\n`,
		{
			once:
				keptClasses !== null &&
				Object.keys(sidecar).every((k) => keptKeys.has(k)),
		},
	);
}

/**
 * @param {RunStep} at
 */
function renderSectionA({ root, pluginRoot, dryRun, out }) {
	const sectionA = path.join(
		pluginRoot,
		"scripts/generate-doc-map-section-a.js",
	);
	if (dryRun) {
		out("would  render docs/doc-map.md §A from the class sidecar");
		return;
	}
	run(root, [
		process.execPath,
		sectionA,
		"--no-claim",
		"--map",
		path.join(root, "docs/doc-map.md"),
		"--data-file",
		path.join(root, "docs/doc-map-classes.json"),
	]);
	out("wrote   docs/doc-map.md §A, rendered from the class sidecar");
}

/**
 * @param {Out} out
 */
function reportTools(out) {
	const missing = TOOLS.filter((tool) => !which(tool));
	if (missing.length === 0) {
		out(`tools    all present: ${TOOLS.join(", ")}`);
		return;
	}
	if (missing.includes("ruff"))
		out(
			`MISSING ruff — the format gate refuses the first commit, which stages scripts/browse.py (#1463); install it: ${RUFF_INSTALL}`,
		);
	const silent = missing.filter((tool) => tool !== "ruff");
	if (silent.length > 0)
		out(
			`MISSING tools, each leaving a gate silent or a helper unusable rather than failing: ${silent.join(", ")}`,
		);
}

/**
 * PATH, except for gitleaks: `WFC_GITLEAKS` overrides it the same way it
 * overrides the hooks' `"${WFC_GITLEAKS:-gitleaks}"` (#239), so this report
 * agrees with them on a var-only machine instead of calling gitleaks missing
 * while the hooks run it happily. An absolute override is checked directly;
 * a bare name is still resolved against PATH. A cwd-relative override (e.g.
 * `./tools/gitleaks`) is neither: it is joined onto every PATH dir here and
 * so reports missing, though the hooks — which exec it directly — would run
 * it. Untested; the shape isn't ruled out, just unhandled.
 *
 * @param {string} tool
 */
function which(tool) {
	const target =
		tool === "gitleaks" ? process.env.WFC_GITLEAKS || "gitleaks" : tool;
	if (path.isAbsolute(target)) return fs.existsSync(target);
	for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
		if (dir && fs.existsSync(path.join(dir, target))) return true;
	}
	return false;
}

/**
 * @param {{root: string, dryRun: boolean, out: (line: string) => void}} at
 */
function tracker({ root, dryRun, out }) {
	const repo = resolveKey("tracker", { root });
	setGhDefaultRepo({
		root,
		repo: typeof repo === "string" ? repo : undefined,
		dryRun,
		out,
	});
	if (typeof repo !== "string") {
		out(
			"MISSING tracker — no `tracker` in the config and no GitHub origin remote, so no feature was probed",
		);
		return;
	}
	probeFeatures({
		root,
		trackerRepo: repo,
		codeRepo: requireKey("codeRepo", { root }),
		dryRun,
		out,
	});
	try {
		run(root, ["git", "config", "--get-regexp", "^credential"], {
			quiet: true,
		});
	} catch {
		out(
			"hint     git has no credential helper — `gh auth setup-git` before the first push",
		);
	}
}

/**
 * Points gh at the tracker, so a repo copied from another does not leave gh
 * defaulting to the one it came from (design-vault#1, #692), and a bare
 * `gh issue` call reaches the issues where the code repo is apart (#1957).
 * @param {{root: string, repo: string|undefined, dryRun: boolean,
 *   out: (line: string) => void}} at
 */
function setGhDefaultRepo({ root, repo, dryRun, out }) {
	if (repo === undefined) {
		out("skipped gh repo set-default — no tracker resolves");
		return;
	}
	if (dryRun) {
		out(`would  gh repo set-default ${repo}`);
		return;
	}
	try {
		run(root, [ghBinary(), "repo", "set-default", repo]);
		out(`gh       default repo set to ${repo}`);
	} catch (err) {
		out(`FAILED gh repo set-default ${repo}: ${reason(err)}`);
	}
}

/**
 * A 403 or 410 means the feature is off for the owner, and the skills fall
 * back to the body convention rather than silently losing an edge; any other
 * failure prints gh's own message (#705). The issue probes read an issue that
 * exists, since a brand-new tracker has no #1. The Actions and pulls probes
 * read the code repo, the issue probes the tracker (#1957).
 * @param {{root: string, trackerRepo: string, codeRepo: string, dryRun: boolean,
 *   out: (line: string) => void}} at
 */
function probeFeatures({ root, trackerRepo, codeRepo, dryRun, out }) {
	const endpoints = [
		`repos/${codeRepo}/actions/runs?per_page=1`,
		`repos/${codeRepo}/pulls?per_page=1`,
	];
	if (dryRun) {
		out("would  probe sub-issues, dependencies on the newest issue");
		for (const probe of endpoints) out(`would  probe ${probe}`);
		return;
	}
	let issue;
	try {
		issue = run(root, [
			ghBinary(),
			"issue",
			"list",
			"--repo",
			trackerRepo,
			"--state",
			"all",
			"--limit",
			"1",
			"--json",
			"number",
			"--jq",
			".[0].number",
		]).trim();
	} catch (err) {
		out(`probe    sub-issues, dependencies: ${reason(err)}`);
	}
	if (issue === "")
		out(
			"probe    sub-issues, dependencies: not probed — the tracker has no issue yet",
		);
	else if (issue !== undefined)
		endpoints.unshift(
			`repos/${trackerRepo}/issues/${issue}/sub_issues`,
			`repos/${trackerRepo}/issues/${issue}/dependencies/blocked_by`,
		);
	for (const probe of endpoints) {
		try {
			run(root, [ghBinary(), "api", probe]);
			out(`probe    ${probe}: reachable`);
		} catch (err) {
			const stderr = String(caught(err).stderr);
			const off = /\(HTTP 4(03|10)\)/.test(stderr);
			out(`probe    ${probe}: ${off ? "off for this owner" : reason(err)}`);
		}
	}
}

/**
 * A JSON file already written, raw, or null where there is none. One that
 * EXISTS and does not parse is refused, not read as empty: rewriting it would
 * drop the adopter's own keys behind the founder's back.
 * @param {string} root
 * @param {string} rel
 * @returns {Record<string, any>|null}
 */
function keptJson(root, rel) {
	let text;
	try {
		text = fs.readFileSync(path.join(root, rel), "utf8");
	} catch (err) {
		if (caught(err).code === "ENOENT") return null;
		throw err;
	}
	try {
		return JSON.parse(text);
	} catch (err) {
		throw new Error(
			`${rel} does not parse — fix or move it, then re-run: ${reason(err)}`,
			{ cause: err },
		);
	}
}

/**
 * The corpus --corpus writes: own tracker, workflow-core, then the extras, so a
 * declared list never drops the own tracker (design-vault#8). Throws the
 * refusal; undefined leaves `corpus` undeclared.
 * @param {string} root
 * @param {string|undefined} extras
 * @param {boolean} bare
 * @returns {string[]|undefined}
 */
function fullCorpus(root, extras, bare) {
	if (bare)
		throw new Error("--corpus wants <owner/name>[,…], the extra trackers");
	if (extras === undefined) return;
	const named = extras.split(",").filter(Boolean);
	const bad = named.filter((t) => !TRACKER_SHAPE.test(t));
	if (bad.length > 0)
		throw new Error(
			`--corpus wants owner/name trackers, got ${bad.join(", ")}`,
		);
	let own;
	try {
		own = resolveKey("tracker", { root });
	} catch {
		own = undefined;
	}
	if (typeof own !== "string" || !TRACKER_SHAPE.test(own))
		throw new Error(
			'--corpus needs the repo\'s own tracker to lead the list, and none resolves — declare "tracker" in the config or give the repo a GitHub origin remote',
		);
	return [...new Set([own, UPSTREAM_TRACKER, ...named])];
}

/**
 * What of the source already declared for `marketplace` a re-run keeps: a url
 * or git source's `ref`, or a directory source's `path` while it is still a
 * directory. Read before the install, whose own rewrite of settings.json drops
 * a `ref`. The url is rebuilt from the core's tracker, as a url source.
 * @param {string} root
 * @param {string} marketplace
 * @returns {{ref: string|null, path: string|null}}
 */
function keptSource(root, marketplace) {
	const source = keptJson(root, SETTINGS)?.extraKnownMarketplaces?.[marketplace]
		?.source;
	const ref =
		(source?.source === "url" || source?.source === "git") &&
		typeof source.ref === "string"
			? source.ref
			: null;
	const dir =
		source?.source === "directory" && typeof source.path === "string"
			? source.path
			: null;
	return {
		ref,
		path:
			dir && fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory()
				? dir
				: null,
	};
}

/** @param {string[]} argv */
function main(argv) {
	let parsed;
	try {
		parsed = parse(argv);
	} catch (err) {
		writeFd(2, `init-adopter: ${reason(err)}\n${USAGE}\n`);
		return 2;
	}
	const { flags } = parsed;
	if (flags.has("help")) {
		writeFd(1, `${USAGE}\n`);
		return 0;
	}
	if (flags.has("config-dir")) {
		writeFd(
			2,
			"init-adopter: --config-dir wants a directory — bare, it would silently fall back to the calling session's own registry, the hazard this flag exists to avoid (#117)\n",
		);
		return 2;
	}
	return adopt(parsed);
}

/**
 * The config already written, or null where none reads.
 * @param {string} root
 */
function readDeclared(root) {
	try {
		return readConfig({ root, quiet: true });
	} catch {
		return null;
	}
}

/**
 * `main` past its usage checks: every argument settled against the repo, then
 * the run itself.
 * @param {ReturnType<typeof parse>} parsed
 * @returns {number}
 */
function adopt({ values, flags, categories, commands }) {
	const root = path.resolve(values.root ?? hostRoot());
	const pluginRoot = path.resolve(
		values["plugin-root"] ??
			process.env.CLAUDE_PLUGIN_ROOT ??
			path.join(__dirname, ".."),
	);
	const declared = readDeclared(root);
	const founder = values.founder ?? declared?.founder;
	if (!founder) {
		writeFd(
			2,
			"init-adopter: --founder is required — it is the config's one required key\n",
		);
		return 2;
	}
	/** @type {Record<string, unknown>|null} */
	let kept;
	/** @type {string[]|undefined} */
	let corpus;
	/** @type {string|undefined} */
	let named;
	try {
		/* Raw rather than through readConfig, whose `modules` WFC_MODULES
		 * replaces: a suite's injection, not the adopter's choice. */
		kept = keptJson(root, CONFIG);
		corpus = fullCorpus(root, values.corpus, flags.has("corpus"));
		named = values.modules ?? (kept ? undefined : inferredModules(root));
	} catch (err) {
		writeFd(2, `init-adopter: ${reason(err)}\n`);
		return 2;
	}
	const { wanted, unknown } = wantedModules(named, kept);
	if (unknown.length > 0) {
		writeFd(
			2,
			`init-adopter: unknown module(s) ${unknown.join(", ")} — one of ${MODULES.join(", ")}\n`,
		);
		return 2;
	}
	/* Sifted through MODULES rather than cast, so the list is typed as the
	 * module union the renderers take. */
	const modules = MODULES.filter((m) => wanted.includes(m));
	/* Validated here, alongside --founder and --modules, rather than inside
	 * init(): it is the same class of bad argument, not a failure of the
	 * materialising step itself (#90). */
	const { marketplace, refusal } = settleMarketplace(
		values.marketplace ?? "workflow-core",
		pluginRoot,
	);
	if (refusal) {
		writeFd(2, refusal);
		return 2;
	}
	if (isCoreCheckout({ root, pluginRoot, marketplace })) {
		writeFd(
			2,
			`init-adopter: ${root} is the ${marketplace} plugin's own checkout — adopting it would rewrite the core's hooks and settings into the adopter form. Pass --root <the repo to adopt>.\n`,
		);
		return 2;
	}
	/* A written config is repo-owned and kept, so inferring past it would
	 * print commands this run never writes. The residual: a test script added
	 * after the first init is never inferred — declare it in the config. */
	let inferred;
	try {
		inferred = kept ? {} : inferCommands(root);
		/* Read now, so a package.json it cannot parse refuses the run before
		 * anything is written; the rules file reads it again at step 4. */
		ciStatusCommand(root);
	} catch (err) {
		writeFd(2, `init-adopter: ${reason(err)}\n`);
		return 2;
	}
	const sourced = commandSources({ commands, kept, declared, inferred });
	const lintStaged = lintStagedRefusal(root, sourced);
	if (lintStaged) {
		writeFd(2, lintStaged);
		return 2;
	}
	try {
		return init(
			initArgs({
				values,
				flags,
				categories,
				root,
				pluginRoot,
				founder,
				modules,
				corpus,
				commands: sourced.commands,
				commandsFrom: sourced.commandsFrom,
				kept,
				declared,
				marketplace,
			}),
		);
	} catch (err) {
		writeFd(2, `init-adopter: ${reason(err)}\n`);
		return 1;
	}
}

/**
 * A first run's modules where --modules names none: each module whose subject
 * the tree already tracks, by the predicate check-gate-switches.js refuses a
 * commit on (#1506). A kept config infers nothing, so a subject landing after
 * the first run is the commit gate's to raise — as is one this could not read
 * the index for, which it warns of rather than refusing the run.
 * @param {string} root
 */
function inferredModules(root) {
	try {
		return subjectModules(root).join(",");
	} catch (err) {
		writeFd(
			1,
			`WARNING modules none inferred — ${reason(err)}; the commit gate names any the tree needs\n`,
		);
		return "";
	}
}

/**
 * The modules --modules names, else the kept config's, and those of them no
 * module is called.
 * @param {string|undefined} named
 * @param {Record<string, unknown>|null} kept
 */
function wantedModules(named, kept) {
	const wanted = (
		named ?? (Array.isArray(kept?.modules) ? kept.modules.join(",") : "")
	)
		.split(",")
		.filter(Boolean);
	const unknown = wanted.filter(
		(m) => !MODULES.includes(/** @type {never} */ (m)),
	);
	return { wanted, unknown };
}

/**
 * The marketplace the install registers under — the manifest's own name where
 * it declares one — or the refusal where --marketplace names another.
 * @param {string} rawMarketplace
 * @param {string} pluginRoot
 * @returns {{marketplace: string, refusal: string|null}}
 */
function settleMarketplace(rawMarketplace, pluginRoot) {
	const manifestRoot = readableRoot(pluginRoot);
	const declaredMarketplaceName = manifestMarketplaceName(manifestRoot);
	if (declaredMarketplaceName && declaredMarketplaceName !== rawMarketplace)
		return {
			marketplace: declaredMarketplaceName,
			refusal:
				`init-adopter: --marketplace "${rawMarketplace}" doesn't match the manifest's declared name "${declaredMarketplaceName}" ` +
				`(${path.join(manifestRoot, ".claude-plugin", "marketplace.json")}) — claude plugin marketplace add registers ` +
				"under the manifest's own name regardless of what was passed, so the install would reference an id nothing " +
				`resolves. Pass --marketplace ${declaredMarketplaceName}, or rename the manifest.\n`,
		};
	return {
		marketplace: declaredMarketplaceName ?? rawMarketplace,
		refusal: null,
	};
}

/**
 * @param {{root: string, pluginRoot: string, marketplace: string}} at
 */
function isCoreCheckout({ root, pluginRoot, marketplace }) {
	/* The core's own checkout carries the manifest a session invoking this
	 * from it resolves as the plugin root, cache copy or not — or the one
	 * shipped beside this script, whatever --marketplace says (#743). */
	const rootName = manifestMarketplaceName(root);
	return (
		sameDir(root, pluginRoot) ||
		(rootName !== null &&
			[
				marketplace,
				manifestMarketplaceName(path.join(__dirname, "..")),
			].includes(rootName))
	);
}

/**
 * The refusal of a `check_staged` this run declares, by --command or
 * inference, that runs lint-staged (#2587). A kept
 * config's is the release note's to migrate.
 * @param {string} root
 * @param {ReturnType<typeof commandSources>} sourced
 * @returns {string|null}
 */
function lintStagedRefusal(root, { commands, commandsFrom }) {
	const command = commands.check_staged;
	if (!command || commandsFrom.check_staged === CONFIG) return null;
	let runs;
	try {
		runs = runsLintStaged(root, command);
	} catch (err) {
		return `init-adopter: ${reason(err)}\n`;
	}
	if (!runs) return null;
	return `init-adopter: check_staged "${command}" (${commandsFrom.check_staged}) runs lint-staged, which hides each partly staged file's unstaged hunks with git restore --worktree for its run, removing a neighbour's uncommitted edits in a shared tree (#2583). Declare instead --command check_staged='${BIOME_STAGED_COMMAND}', or a command of your own that reads the index's bytes, not the worktree's.\n`;
}

/**
 * Where each command came from — --command, the kept config, or inference —
 * and the commands, filled from the latter two.
 * @param {{commands: Record<string, string|null>,
 *   kept: Record<string, unknown>|null,
 *   declared: ReturnType<typeof readDeclared>,
 *   inferred: ReturnType<typeof inferCommands>}} at
 * @returns {{commands: Record<string, string|null>,
 *   commandsFrom: Record<string, string>}}
 */
function commandSources({ commands, kept, declared, inferred }) {
	const filled = { ...commands };
	/** @type {Record<string, string>} */
	const commandsFrom = {};
	for (const c of COMMANDS) {
		if (filled[c]) commandsFrom[c] = "--command";
		else if (kept && declared?.commands[c]) {
			filled[c] = declared.commands[c];
			commandsFrom[c] = CONFIG;
		} else if (c in inferred) {
			const hit = inferred[/** @type {keyof typeof inferred} */ (c)];
			filled[c] = hit?.command ?? null;
			commandsFrom[c] = `inferred from ${hit?.from}`;
		}
	}
	return { commands: filled, commandsFrom };
}

/**
 * `init`'s arguments, the declared marketplace source read first.
 * @param {{values: Record<string, string>, flags: Set<string>,
 *   categories: Record<string, string>, root: string, pluginRoot: string,
 *   founder: string, modules: Module[], corpus: string[]|undefined,
 *   commands: Record<string, string|null>, commandsFrom: Record<string, string>,
 *   kept: Record<string, unknown>|null,
 *   declared: ReturnType<typeof readDeclared>, marketplace: string}} at
 * @returns {Parameters<typeof init>[0]}
 */
function initArgs(at) {
	const { values, flags, categories, root, declared, marketplace } = at;
	const declaredSource = keptSource(root, marketplace);
	return {
		root,
		pluginRoot: at.pluginRoot,
		pluginRootGiven: values["plugin-root"] !== undefined,
		founder: at.founder,
		project: values.project ?? path.basename(root),
		modules: at.modules,
		categories:
			Object.keys(categories).length > 0
				? categories
				: (declared?.categories ?? {}),
		corpus: at.corpus,
		commands: at.commands,
		commandsFrom: at.commandsFrom,
		kept: at.kept,
		marketplace,
		marketplaceRef: values["marketplace-ref"] ?? declaredSource.ref,
		/* The flag alone re-points it: CLAUDE_PLUGIN_ROOT is the cache copy
		 * the rules file's command runs from, the path this keeps out (#731).
		 * A relative declared path is judged against cwd, not --root. */
		marketplacePath: values["plugin-root"] ? null : declaredSource.path,
		tracker: !flags.has("no-tracker"),
		pluginInstall: !flags.has("no-plugin-install"),
		dryRun: flags.has("dry-run"),
		configDir: values["config-dir"]
			? path.resolve(values["config-dir"])
			: undefined,
		out: (line) => writeFd(1, `${line}\n`),
	};
}

/**
 * Every path `init` can write under `modules`, for a caller judging them
 * before they exist: new-repo.js checks a source repo's `.gitignore` against
 * it (#721). new-repo.test.ts fails where `init` writes a path this omits.
 * @param {Module[]} modules
 * @param {import("./lib/core-owned-files.js").Entry[]} [entries]
 */
function initPaths(modules, entries) {
	/* A Set: the rules file and settings.json are both CLASSES keys and
	 * core-owned paths. */
	return [
		...new Set([
			...Object.keys(CLASSES),
			...(modules.includes("roadmap") ? Object.keys(ROADMAP_CLASSES) : []),
			...Object.keys(SIDECARS),
			...coreOwnedPaths(entries),
		]),
	];
}

// new-repo.js reads both (§N7): initPaths's list is built from this file's own constants and core-owned-files.js's entries.
module.exports = { initPaths, manifestMarketplaceName };

if (require.main === module) process.exit(main(process.argv.slice(2)));
