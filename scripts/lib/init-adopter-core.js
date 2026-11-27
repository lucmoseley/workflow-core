// cli-args-exempt: workflow-core#941

const fs = require("node:fs");
const { scriptPath } = require("./script-path.js");
const path = require("node:path");
const { readPluginRecord } = require("./plugin-record.js");
const { claudeBin: resolveClaudeBin } = require("./claude-bin.js");
const {
	run,
	installFailure: reason,
	materialisePlugin,
	fixByHand,
} = require("./materialise-plugin.js");
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
	CONFIG_PATH,
} = require("./workflow-core-config.js");
const {
	inferCommands,
	isLintStagedCommand,
	classifyCheckStaged,
} = require("./infer-commands.js");
const { BIOME_STAGED_COMMAND } = require("./biome-allowlist.js");
const { readSubjectModules } = require("./gate-subjects.js");
const {
	findInstallRecord,
	resolveConfigDir,
	isTagRef,
	sameRelease,
} = require("./plugin-state.js");
const { COST_TABLE, measurerFor } = require("./core-context-cost.js");
const { ghBinary } = require("./gh.js");
const { worktreeRoot } = require("./host-root.js");
const { realKey } = require("./deref.js");
const {
	describePluginRecord,
	renderConfig,
	renderClaudeMd,
	renderAgentsMd,
	renderDocMap,
	renderCodeStandards,
	renderCalledCards,
	renderRoadmap,
	RULES_FILE: RULES,
	TOOLS,
} = require("./adopter-skeleton.js");
const {
	bringCoreFiles,
	coreOwnedPaths,
	skeletonPaths,
	ghLabels,
} = require("./core-owned-files.js");
const { RUFF_INSTALL } = require("./formatters.js");
const { caught } = require("./caught.js");
const { execGit, gitOrNull, GIT_TIMEOUT_MS } = require("./git.js");

/** @typedef {import("./workflow-core-config.js").Module} Module */
/** @typedef {import("./workflow-core-config.js").Command} Command */
/** @typedef {import("./infer-commands.js").MappedCommand} MappedCommand */
/**
 * @typedef {{command: null} | (MappedCommand & {
 *   kind: "explicit"|"kept"|"inferred", from: string})} SourcedCommand
 */

/** @typedef {Record<Command, SourcedCommand>} Sourced */

const EXPLICIT = "--command";
const SETTINGS = ".claude/settings.json";
const { ANCHORS, IMPLICIT_MANIFEST } = require("./registry-anchors-file.js");

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
	[CONFIG_PATH]: {
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
	[IMPLICIT_MANIFEST]: {
		section: "Skills & settings",
		class: "source-of-truth",
		role: "Each script this repo wires beside the core's shims: what it does to a session unasked, why, and its escape, checked both ways against the wiring by the guard registry",
	},
	[ANCHORS]: {
		section: "Skills & settings",
		class: "generated-only",
		route:
			"`node " +
			scriptPath("check-guard-registry.js") +
			" --review`, which re-anchors a guard whose annotation has been read",
	},
	"docs/doc-map.md": {
		section: "Governance & process docs",
		class: "source-of-truth",
		reader: "agent",
	},
	"docs/code-standards.md": {
		section: "Governance & process docs",
		class: "source-of-truth",
		role: "The local standards file, read beside the plugin's standards base: its changes to the base, route rows, local rules and primitives table",
		reader: "agent",
	},
	"docs/doc-map-classes.json": {
		section: "Governance & process docs",
		class: "source-of-truth",
		route:
			"`node " +
			scriptPath("register-doc.js") +
			" <path> --class <token> --section <name>` for a new key",
	},
};

for (const s of Object.keys(SIDECARS)) {
	CLASSES[s] = {
		section: "Governance & process docs",
		class: "source-of-truth",
	};
}

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

const USAGE = `usage: node ${scriptPath("init-adopter.js")} --founder "<name>" [--root <dir>]
  [--project <name>] [--modules roadmap,governance] [--category tech="Tech & Stack"]
  [--command test="npm test"] [--corpus <owner/name>[,…]] [--plugin-root <dir>]
  [--marketplace <name>] [--marketplace-ref <tag>] [--no-tracker]
  [--no-plugin-install] [--dry-run] [--config-dir <dir>] [--help]`;

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
 * @param {string} arg
 * @param {{argv: string[], i: number}} at
 * @param {{values: Record<string, string>, flags: Set<string>, categories: Record<string, string>, commands: Record<string, string|null>}} parsed
 * @returns {number}
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
 * @param {string} arg
 * @param {string|undefined} next
 * @returns {{name: string, value?: string}}
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

function stamp() {
	const now = new Date();
	// workflow-core#5
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
 * @param {string} pluginRoot
 * @returns {string|null}
 */
function readManifestVersion(pluginRoot) {
	const version = readManifest(pluginRoot, "plugin.json")?.version;
	return typeof version === "string" ? version : null;
}

/**
 * @param {string} pluginRoot
 * @param {string|null} [ref]
 */
function readCoreVersion(pluginRoot, ref) {
	const full =
		readManifestVersion(pluginRoot) ||
		(ref && isTagRef(ref) ? ref.replace(/^v/, "") : "1.0.0");
	const [major, minor = "0"] = full.split(".");
	return `${major}.${minor}`;
}

/**
 * @param {string} dir
 * @param {string} ref
 * @returns {string|null}
 */
function offPin(dir, ref) {
	if (fs.existsSync(path.join(dir, ".git"))) {
		let tags;
		try {
			tags = execGit(["tag", "--points-at", "HEAD"], {
				cwd: dir,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
				timeout: GIT_TIMEOUT_MS,
			}).split("\n");
		} catch (err) {
			return `a checkout whose tags git could not read (${reason(err)})`;
		}
		return tags.includes(ref) ? null : `a checkout whose HEAD is not ${ref}`;
	}
	const version = readManifestVersion(dir);
	return sameRelease(version, ref)
		? null
		: `version ${version ?? "unknown"}, not ${ref}`;
}

/** @param {string} pluginRoot */
const readableRoot = (pluginRoot) =>
	readManifestVersion(pluginRoot) ? pluginRoot : path.join(__dirname, "../..");

/**
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
			? realKey(row.installPath)
			: fallback;
	const off = offPin(chosen, ref);
	if (off)
		out(
			`WARNING the hooks and rules file run from ${chosen}, ${off}${chosen === fallback ? ", since no install row names this repo" : ""} — re-run with --plugin-root <the installed ${ref} copy>`,
		);
	return chosen;
}

/**
 * @param {string} pluginRoot
 * @returns {string|null}
 */
function readManifestMarketplaceName(pluginRoot) {
	const name = readManifest(pluginRoot, "marketplace.json")?.name;
	return typeof name === "string" ? name : null;
}

/** @typedef {import("./plugin-record.js").PluginSource} PluginSource */

/**
 * @typedef {{
 *   out: (text: string) => void,
 *   err: (text: string) => void,
 *   runNode: (root: string, script: string, args: string[],
 *     opts?: {quiet?: boolean}) => string,
 * }} Ports
 */

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
	 * @param {{once?: boolean, mode?: number}} [opts]
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
 * @param {{sourced: Sourced,
 *   kept: Record<string, unknown>|null,
 *   out: (line: string) => void}} at
 */
function reportCommands({ sourced, kept, out }) {
	const found = COMMANDS.flatMap((c) => {
		const s = sourced[c];
		if (s.command === null) return [];
		return [`${c}: ${s.command} (${s.from}${s.note ? ` — ${s.note}` : ""})`];
	});
	if (found.length > 0) out(`commands ${found.join("; ")}`);
	else if (kept) out(`commands none declared in ${CONFIG_PATH}`);
	else
		out(
			"commands none — no package.json script, pytest config or node --test .js test file names one",
		);
}

/**
 * @param {{corpus?: string[], kept: Record<string, unknown>|null,
 *   out: (line: string) => void}} at
 */
function reportCorpus({ corpus, kept, out }) {
	if (corpus && !kept) out(`corpus   ${corpus.join(", ")}`);
	else if (corpus && JSON.stringify(kept?.corpus) !== JSON.stringify(corpus))
		out(
			`corpus   NOT written — ${CONFIG_PATH} is kept, so declare it there by hand: ${JSON.stringify(corpus)}`,
		);
}

/**
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
 *   sourced: Sourced,
 *   kept: Record<string, unknown>|null,
 *   marketplace: string,
 *   marketplaceRef: string|null, marketplacePath: string|null, tracker: boolean, pluginInstall: boolean,
 *   dryRun: boolean, configDir?: string, out: (line: string) => void,
 *   ports: Ports}} at
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
		sourced,
		kept,
		dryRun,
		out,
		ports,
	} = at;
	const commands = Object.fromEntries(
		COMMANDS.map((c) => [c, sourced[c].command]),
	);
	const w = new Writer({ root, dryRun, out });
	reportCommands({ sourced, kept, out });
	reportCorpus({ corpus, kept, out });
	const when = stamp();
	const version = readCoreVersion(givenRoot, at.marketplaceRef);
	const roadmap = modules.includes("roadmap");

	const source = installSource(at);

	const bootstrapVersion = readManifestVersion(givenRoot);

	w.write(
		CONFIG_PATH,
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

	w.write("CLAUDE.md", renderClaudeMd({ founder, project, commands }), {
		once: true,
	});
	w.write("AGENTS.md", renderAgentsMd(), { once: true });
	w.write(IMPLICIT_MANIFEST, "{}\n", { once: true });

	// lucmoseley/mantahostels#3515
	const claudeBin = resolveClaudeBin();
	const pluginId = `workflow-core@${at.marketplace}`;
	const result = materialiseStep({ at, source, claudeBin, pluginId });

	const record = readPluginRecord(source, {
		root,
		pluginName: "workflow-core",
		marketplace: at.marketplace,
		configDir: at.configDir,
	});
	out(`record   ${describePluginRecord(record)}`);

	const pluginRoot = resolvePluginRoot({ at, source });
	if (result) reportInstall({ result, pluginId, record, out });

	if (dryRun) out(`would   add the ${pluginId} row to ${COST_TABLE}`);
	/** @type {import("./core-owned-files.js").Labels} */
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
	if (!dryRun)
		execGit(["config", "core.hooksPath", ".husky"], {
			cwd: root,
			stdio: ["ignore", "pipe", "pipe"],
			timeout: GIT_TIMEOUT_MS,
		});
	out("set     core.hooksPath to .husky");

	const anchored = anchorHooks({ root, pluginRoot, dryRun, out, ports });

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
			ports,
		});
	else {
		out(`skipped the roadmap triple — module "roadmap" is off`);
	}

	w.write("docs/doc-map.md", renderDocMap({ project, date: when.date }), {
		once: true,
	});
	for (const [sidecar, seed] of Object.entries(SIDECARS))
		w.write(sidecar, seed, { once: true });
	w.write("docs/code-standards.md", renderCodeStandards({ project }), {
		once: true,
	});
	writeClassSidecar({ w, root, sidecar: classRows({ roadmap, anchored }) });
	renderSectionA({ root, pluginRoot, dryRun, out, ports });

	if (at.tracker) tracker({ root, dryRun, out });
	else out("skipped the tracker — --no-tracker");

	reportTools(out);

	out("");
	out(
		"Next: commit the skeleton through the full hook stack — that commit IS the test.",
	);
	const isHeld = (/** @type {string} */ rel) =>
		fs.existsSync(path.join(root, rel));
	const paths = skeletonPaths((rel) => dryRun || isHeld(rel), {
		isHeld,
	}).join(" ");
	out(`  git add -N ${paths}`);
	out(`  git commit -m "<why this repo exists>" -- ${paths}`);
	return 0;
}

/** @typedef {(line: string) => void} Out */

/** @typedef {{w: Writer, pluginRoot: string, out: Out}} CopyStep */

/**
 * @typedef {{root: string, pluginRoot: string, dryRun: boolean, out: Out,
 *   ports: Ports}} RunStep
 */

/**
 * @param {{at: {root: string, marketplace: string, pluginInstall: boolean,
 *   dryRun: boolean, configDir?: string, out: Out, ports: Ports},
 *   source: PluginSource,
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
 * @param {{at: {root: string, pluginRoot: string, pluginRootGiven: boolean,
 *   marketplace: string, dryRun: boolean, configDir?: string, out: Out},
 *   source: PluginSource}} step
 * @returns {string}
 */
function resolvePluginRoot({ at, source }) {
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
 * @param {{result: ReturnType<typeof materialisePlugin>, pluginId: string,
 *   record: ReturnType<typeof readPluginRecord>, out: Out}} at
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
 * @param {{at: {root: string, configDir?: string, ports: Ports},
 *   result: ReturnType<typeof materialisePlugin> | null, claudeBin: string}} step
 */
function costMeasurer({ at, result, claudeBin }) {
	return result?.ok
		? measurerFor({ root: at.root, claudeBin, configDir: at.configDir })
		: () => ({ reason: "the plugin was not materialised this run" });
}

/**
 * @param {RunStep} at
 * @returns {boolean}
 */
function anchorHooks({ root, pluginRoot, dryRun, out, ports }) {
	const registry = path.join(pluginRoot, "scripts/check-guard-registry.js");
	if (dryRun) {
		out(`would  anchor the seven hooks in ${ANCHORS}`);
		return true;
	}
	const git = (/** @type {string[]} */ args) =>
		String(
			execGit(args, {
				cwd: root,
				stdio: ["ignore", "pipe", "pipe"],
				timeout: GIT_TIMEOUT_MS,
			}),
		);
	/** @type {string[]} */
	let marked = [];
	try {
		const hooks = git(["ls-files", "-oz", "--exclude-standard", "--", ".husky"])
			.split("\0")
			.filter(Boolean);
		if (hooks.length > 0) git(["add", "-N", "--", ...hooks]);
		marked = hooks;
		ports.runNode(root, registry, ["--review", "--sole-writer"], {
			quiet: true,
		});
		out(`wrote   ${ANCHORS} (the seven hooks anchored)`);
		return true;
	} catch (err) {
		out(
			`FAILED anchoring the hooks: ${reason(err)} — the first commit will report seven unread hook headers; clear them with \`node <plugin>/scripts/check-guard-registry.js --review\``,
		);
		return false;
	} finally {
		if (marked.length > 0) git(["rm", "-q", "--cached", "--", ...marked]);
	}
}

/**
 * @param {CopyStep & RunStep & {project: string, founder: string,
 *   categories: Record<string, string>, version: string, stamp: string}} at
 */
function writeRoadmap(at) {
	const { w, root, pluginRoot, project, founder, dryRun, out, ports } = at;
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
		ports.runNode(root, generator, [
			"docs/reference-roadmap.html",
			"--out",
			"docs/roadmap-digest.md",
		]);
		out("wrote   docs/roadmap-digest.md (rendered from the roadmap HTML)");
	} else out(`MISSING ${generator} — no digest was rendered`);
}

/**
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

/** @param {{w: Writer, root: string, sidecar: Record<string, object>}} at */
function writeClassSidecar({ w, root, sidecar }) {
	const keptClasses = readKeptJson(root, "docs/doc-map-classes.json");
	const keptKeys = new Set(Object.keys(keptClasses ?? {}));
	const merged = { ...sidecar, ...keptClasses };
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
function renderSectionA({ root, pluginRoot, dryRun, out, ports }) {
	const sectionA = path.join(
		pluginRoot,
		"scripts/generate-doc-map-section-a.js",
	);
	if (dryRun) {
		out("would  render docs/doc-map.md §A from the class sidecar");
		return;
	}
	ports.runNode(root, sectionA, [
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
			`MISSING ruff — the format gate refuses the first commit, which stages scripts/browse.py (workflow-core#1463); install it: ${RUFF_INSTALL}`,
		);
	const silent = missing.filter((tool) => tool !== "ruff");
	if (silent.length > 0)
		out(
			`MISSING tools, each leaving a gate silent or a helper unusable rather than failing: ${silent.join(", ")}`,
		);
}

/** @param {string} tool */
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
 * @param {{root: string, dryRun: boolean, out: Out}} at
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
	if (
		gitOrNull(["config", "--get-regexp", "^credential"], {
			cwd: root,
			timeout: GIT_TIMEOUT_MS,
		}) === null
	)
		out(
			"hint     git has no credential helper — `gh auth setup-git` before the first push",
		);
}

/**
 * @param {{root: string, repo: string|undefined, dryRun: boolean,
 *   out: Out}} at
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
 * @param {{root: string, trackerRepo: string, codeRepo: string, dryRun: boolean,
 *   out: Out}} at
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
 * @param {string} root
 * @param {string} rel
 * @returns {Record<string, any>|null}
 */
function readKeptJson(root, rel) {
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
 * @param {string} root
 * @param {string} marketplace
 * @returns {{ref: string|null, path: string|null}}
 */
function readKeptSource(root, marketplace) {
	const source = readKeptJson(root, SETTINGS)?.extraKnownMarketplaces?.[
		marketplace
	]?.source;
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

/**
 * @param {string[]} argv
 * @param {Ports} ports
 * @returns {number}
 */
function adopt(argv, ports) {
	let parsed;
	try {
		parsed = parse(argv);
	} catch (err) {
		ports.err(`init-adopter: ${reason(err)}\n${USAGE}\n`);
		return 2;
	}
	const { flags } = parsed;
	if (flags.has("help")) {
		ports.out(`${USAGE}\n`);
		return 0;
	}
	if (flags.has("config-dir")) {
		ports.err(
			"init-adopter: --config-dir wants a directory — bare, it would silently fall back to the calling session's own registry, the hazard this flag exists to avoid (workflow-core#117)\n",
		);
		return 2;
	}
	return settle(parsed, ports);
}

/** @param {string} root */
function readDeclared(root) {
	try {
		return readConfig({ root, quiet: true });
	} catch {
		return null;
	}
}

/**
 * @param {ReturnType<typeof parse>} parsed
 * @param {Ports} ports
 * @returns {number}
 */
function settle({ values, flags, categories, commands }, ports) {
	const root = path.resolve(values.root ?? worktreeRoot());
	const pluginRoot = path.resolve(
		values["plugin-root"] ??
			process.env.CLAUDE_PLUGIN_ROOT ??
			path.join(__dirname, "../.."),
	);
	const declared = readDeclared(root);
	const founder = values.founder ?? declared?.founder;
	if (!founder) {
		ports.err(
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
		kept = readKeptJson(root, CONFIG_PATH);
		corpus = fullCorpus(root, values.corpus, flags.has("corpus"));
		named =
			values.modules ??
			(kept ? undefined : readInferredModules(root, ports.out));
	} catch (err) {
		ports.err(`init-adopter: ${reason(err)}\n`);
		return 2;
	}
	const { wanted, unknown } = wantedModules(named, kept);
	if (unknown.length > 0) {
		ports.err(
			`init-adopter: unknown module(s) ${unknown.join(", ")} — one of ${MODULES.join(", ")}\n`,
		);
		return 2;
	}
	const modules = MODULES.filter((m) => wanted.includes(m));
	const { marketplace, refusal } = settleMarketplace(
		values.marketplace ?? "workflow-core",
		pluginRoot,
	);
	if (refusal) {
		ports.err(refusal);
		return 2;
	}
	if (isCoreCheckout({ root, pluginRoot, marketplace })) {
		ports.err(
			`init-adopter: ${root} is the ${marketplace} plugin's own checkout — adopting it would rewrite the core's hooks and settings into the adopter form. Pass --root <the repo to adopt>.\n`,
		);
		return 2;
	}
	let inferred;
	try {
		inferred = kept ? {} : inferCommands(root);
	} catch (err) {
		ports.err(`init-adopter: ${reason(err)}\n`);
		return 2;
	}
	const sourced = commandSources({ commands, kept, declared, inferred });
	const stagedRefusal = checkStagedRefusal(root, sourced.check_staged);
	if (stagedRefusal) {
		ports.err(stagedRefusal);
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
				sourced,
				kept,
				declared,
				marketplace,
				ports,
			}),
		);
	} catch (err) {
		ports.err(`init-adopter: ${reason(err)}\n`);
		return 1;
	}
}

/**
 * @param {string} root
 * @param {Ports["out"]} write
 */
function readInferredModules(root, write) {
	/** @type {string[]} */
	let found = [];
	try {
		found = readSubjectModules(root);
	} catch (err) {
		write(
			`WARNING modules none inferred — ${reason(err)}; the commit gate names any the tree needs\n`,
		);
	}
	return found.join(",");
}

/**
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
 * @param {string} rawMarketplace
 * @param {string} pluginRoot
 * @returns {{marketplace: string, refusal: string|null}}
 */
function settleMarketplace(rawMarketplace, pluginRoot) {
	const manifestRoot = readableRoot(pluginRoot);
	const declaredMarketplaceName = readManifestMarketplaceName(manifestRoot);
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
	const rootName = readManifestMarketplaceName(root);
	return (
		sameDir(root, pluginRoot) ||
		(rootName !== null &&
			[
				marketplace,
				readManifestMarketplaceName(path.join(__dirname, "../..")),
			].includes(rootName))
	);
}

/**
 * @param {string} root
 * @param {SourcedCommand} checkStaged
 * @returns {string|null}
 */
function checkStagedRefusal(root, checkStaged) {
	if (checkStaged.command === null || checkStaged.kind === "kept") return null;
	const { command, kind, from } = checkStaged;
	const named = `init-adopter: check_staged "${command}" (${from})`;
	try {
		if (isLintStagedCommand(root, command))
			return `${named} runs lint-staged, which hides each partly staged file's unstaged hunks with git restore --worktree for its run, taking uncommitted edits off disk while it runs (workflow-core#2583). Declare instead --command check_staged='${BIOME_STAGED_COMMAND}', or a command of your own that reads the index's bytes, not the worktree's.\n`;
		const biome = classifyCheckStaged(root, command, {
			inferred: kind === "inferred",
		});
		if (biome.kind === "refused") return `${named} ${biome.refusal}\n`;
	} catch (err) {
		return `init-adopter: ${reason(err)}\n`;
	}
	return null;
}

/**
 * @param {{commands: Record<string, string|null>,
 *   kept: Record<string, unknown>|null,
 *   declared: ReturnType<typeof readDeclared>,
 *   inferred: ReturnType<typeof inferCommands>}} at
 * @returns {Sourced}
 */
function commandSources({ commands, kept, declared, inferred }) {
	/** @param {Command} c @returns {SourcedCommand} */
	const source = (c) => {
		if (commands[c])
			return { command: commands[c], kind: "explicit", from: EXPLICIT };
		if (kept && declared?.commands[c])
			return { command: declared.commands[c], kind: "kept", from: CONFIG_PATH };
		const hit = inferred[/** @type {keyof typeof inferred} */ (c)];
		if (!hit) return { command: null };
		return { ...hit, kind: "inferred", from: `inferred from ${hit.from}` };
	};
	return /** @type {Sourced} */ (
		Object.fromEntries(COMMANDS.map((c) => [c, source(c)]))
	);
}

/**
 * @param {{values: Record<string, string>, flags: Set<string>,
 *   categories: Record<string, string>, root: string, pluginRoot: string,
 *   founder: string, modules: Module[], corpus: string[]|undefined,
 *   sourced: Sourced, kept: Record<string, unknown>|null,
 *   declared: ReturnType<typeof readDeclared>, marketplace: string,
 *   ports: Ports}} at
 * @returns {Parameters<typeof init>[0]}
 */
function initArgs(at) {
	const { values, flags, categories, root, declared, marketplace, ports } = at;
	const declaredSource = readKeptSource(root, marketplace);
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
		sourced: at.sourced,
		kept: at.kept,
		marketplace,
		marketplaceRef: values["marketplace-ref"] ?? declaredSource.ref,
		marketplacePath: values["plugin-root"] ? null : declaredSource.path,
		tracker: !flags.has("no-tracker"),
		pluginInstall: !flags.has("no-plugin-install"),
		dryRun: flags.has("dry-run"),
		configDir: values["config-dir"]
			? path.resolve(values["config-dir"])
			: undefined,
		out: (line) => ports.out(`${line}\n`),
		ports,
	};
}

/**
 * @param {Module[]} modules
 * @param {import("./core-owned-files.js").Entry[]} [entries]
 */
function initPaths(modules, entries) {
	return [
		...new Set([
			...Object.keys(CLASSES),
			...(modules.includes("roadmap") ? Object.keys(ROADMAP_CLASSES) : []),
			...Object.keys(SIDECARS),
			...coreOwnedPaths(entries),
		]),
	];
}

module.exports = { adopt, initPaths, readManifestMarketplaceName };
