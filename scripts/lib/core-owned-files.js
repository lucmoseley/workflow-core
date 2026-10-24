/*
 * core-owned-files.js — brings each file the core owns in an adopter to the
 * plugin's current form. Init calls it after its one-time, repo-owned writes,
 * and upgrade on every run before it walks the migration notes (#1501, ruled
 * at #1470).
 *
 * A NEW CORE-OWNED FILE IS ONE ENTRY IN `ENTRIES`, and every existing adopter
 * receives it on its next upgrade.
 *
 * EVERY ENTRY IS IDEMPOTENT: over an adopter already current it writes nothing
 * and prints nothing, so init then upgrade at one plugin leaves every file
 * byte-identical. Renderers stay in `adopter-skeleton.js`.
 *
 * AN ENTRY THAT CANNOT READ ITS INPUT SKIPS WITH A LINE, but for one: a
 * `settings.json` that does not parse throws, since the plugin entry it
 * carries is what loads the plugin at all, and rewriting it would drop the
 * adopter's keys.
 */

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { isDeepStrictEqual } = require("node:util");
const {
	renderSessionRules,
	renderReference,
	ciStatusCommand,
	renderPluginRecord,
	renderHookShim,
	isHookShim,
	withIgnoreBlock,
	settingsKeys,
	labelPlan,
	hookRootOf,
	RULES_FILE,
	REFERENCE_FILE,
	CORE_OWNED,
	PROVENANCE_HEADING,
	HOOKS,
	HELPERS,
} = require("./adopter-skeleton.js");
const {
	readConfig,
	resolveKey,
	deriveTracker,
} = require("./workflow-core-config.js");
const { seedCoreCost, COST_TABLE } = require("./core-context-cost.js");
const { ledgerPath } = require("./dispatch-ledger.js");
const { MARKERS_REL } = require("./marker-root.js");
const { SESSION_COST_TABLE } = require("./session-spend.js");
const { gh, ghJson, errLine } = require("./gh.js");
const { caught } = require("./caught.js");
const { isUnder } = require("./is-under.js");
const {
	HOST_REGISTRATIONS,
	HOST_NEEDLES,
	emptyRegistry,
	emptyNeedles,
} = require("./registrations.js");

const SETTINGS = ".claude/settings.json";

/** @typedef {import("./workflow-core-config.js").Module} Module */
/** @typedef {{name: string, color: string, description: string}} Label */

/**
 * The gh calls the labels entry makes, passed in so a dry run or a test makes
 * no live write.
 * @typedef {object} LabelGh
 * @property {(repo: string) => Label[]} list
 * @property {(repo: string, label: Label) => void} create
 */

/**
 * The gh the labels sync through, or why the caller turned them off.
 * @typedef {LabelGh|{off: string}} Labels
 */

/**
 * The config keys the entries render from.
 * @typedef {object} RenderConfig
 * @property {string|undefined} founder
 * @property {Module[]} modules
 * @property {Record<string, string>} categories
 */

/**
 * @typedef {object} Context
 * @property {string} root the adopter's root
 * @property {string} pluginRoot the plugin this run brings files to
 * @property {boolean} dryRun
 * @property {(line: string) => void} out
 * @property {boolean} [fresh] init's run, which writes the rules file where
 *   it is absent; upgrade leaves an absent one absent
 * @property {RenderConfig} [config] the config as the caller holds it; read
 *   off disk where absent. Init passes its own, because `readConfig` lets the
 *   suite's `WFC_MODULES` replace the adopter's modules.
 * @property {import("./plugin-record.js").PluginRecord|null} record the
 *   plugin this run installs; null keeps the provenance block as written
 * @property {{marketplace: string, source: object, plugin: string}|null} pin
 *   the plugin's settings entry; null leaves `settings.json` alone
 * @property {import("./core-context-cost.js").Measurer} [measureCore] absent,
 *   no context-cost row is seeded and no `claude` is called
 * @property {Labels} [labels] absent, no label is read or written
 */

/**
 * Writes `body` at `rel` where it differs, and sets `mode` where given.
 * @param {Context} ctx
 * @param {{rel: string, body: string, mode?: number, lost?: string}} file
 *   `lost` is said where an existing copy is overwritten
 * @returns {string[]} `[rel]` where it wrote, else `[]`
 */
function bringFile({ root, dryRun, out }, { rel, body, mode, lost }) {
	const at = path.join(root, rel);
	const existing = readIfPresent(at);
	const bodyChanged = existing !== body;
	const modeWrong =
		mode !== undefined &&
		existing !== null &&
		(fs.statSync(at).mode & 0o777) !== mode;
	if (!bodyChanged && !modeWrong) return [];
	let verb = "repair the exec bit of";
	let said = `repaired ${rel}'s exec bit`;
	if (existing === null) {
		verb = "write";
		said = `wrote   ${rel}`;
	} else if (bodyChanged) {
		verb = "rewrite";
		said = `rewrote ${rel}${lost ? ` — ${lost}` : ""}`;
	}
	if (dryRun) {
		out(`would   ${verb} ${rel}`);
		return [];
	}
	if (bodyChanged) {
		fs.mkdirSync(path.dirname(at), { recursive: true });
		fs.writeFileSync(at, body);
	}
	if (mode !== undefined) fs.chmodSync(at, mode);
	out(said);
	return [rel];
}

/**
 * @param {string} at
 * @returns {string|null} the file's text, or null where it does not exist
 */
function readIfPresent(at) {
	try {
		return fs.readFileSync(at, "utf8");
	} catch (err) {
		if (caught(err).code !== "ENOENT") throw err;
		return null;
	}
}

/**
 * The seven husky hook shims, executable. A hook written before #1839, which
 * names the plugin on a `WFC_PLUGIN_ROOT` line, becomes its shim here. An
 * adopter's own hook under a shipped name, neither shim nor root-line hook, is
 * left alone, with a line saying the core's gate does not run there.
 * @param {Context} ctx
 */
function bringHooks(ctx) {
	return HOOKS.flatMap((hook) => {
		const rel = path.join(".husky", hook);
		const existing = readIfPresent(path.join(ctx.root, rel));
		if (
			existing !== null &&
			!isHookShim(existing) &&
			hookRootOf(existing) === null
		) {
			ctx.out(
				`skipped ${rel} — the adopter's own hook (no shim marker or WFC_PLUGIN_ROOT line), so the core's ${hook} gate does not run there`,
			);
			return [];
		}
		return bringFile(ctx, { rel, body: renderHookShim(hook), mode: 0o755 });
	});
}

/**
 * The helper scripts, copied verbatim: each is self-contained.
 *
 * NOT REGISTERED IN THE CLASS SIDECAR (#133): `scripts` is outside
 * doc-map.js's SCOPE, so a key there would warn UNTRACKED-ENTRY in every
 * adopter for good.
 * @param {Context} ctx
 */
function bringHelpers(ctx) {
	return HELPERS.flatMap((rel) => {
		const body = readIfPresent(path.join(ctx.pluginRoot, rel));
		if (body === null) {
			ctx.out(`MISSING ${rel} — the plugin root carries no copy`);
			return [];
		}
		return bringFile(ctx, {
			rel,
			body,
			mode: 0o755,
			lost: "it differed from the plugin's copy, so any local edit to it is gone",
		});
	});
}

/**
 * `.claude/workflow-core.md` and its never-imported sibling
 * `.claude/workflow-core.reference.md`: written where absent on a fresh run,
 * and re-rendered only where the rules file opens on `CORE_OWNED`. The
 * sibling's provenance block comes from `record`, else from the block it or,
 * before #2035, the rules file already carries.
 * @param {Context} ctx
 */
function bringRules(ctx) {
	const { root, pluginRoot, out } = ctx;
	const existing = readIfPresent(path.join(root, RULES_FILE));
	if (existing === null && !ctx.fresh) return [];
	if (existing !== null && !existing.startsWith(CORE_OWNED)) {
		out(
			`skipped ${RULES_FILE} — it does not open on the CORE-OWNED marker, so the core did not write it`,
		);
		return [];
	}
	let config;
	let ciCheck;
	try {
		config = renderConfig(ctx);
		ciCheck = ciStatusCommand(root);
	} catch (err) {
		out(`skipped ${RULES_FILE}: ${caught(err).message}`);
		return [];
	}
	if (!config.founder) {
		out(
			`skipped ${RULES_FILE}: .claude/workflow-core.json declares no founder`,
		);
		return [];
	}
	const reference = readIfPresent(path.join(root, REFERENCE_FILE));
	const foreign = reference !== null && !reference.startsWith(CORE_OWNED);
	/* With nowhere else to go, the block stays on the rules file. */
	const rules = bringFile(ctx, {
		rel: RULES_FILE,
		body:
			renderSessionRules({
				modules: config.modules,
				founder: config.founder,
				pluginRoot,
				ciCheck,
			}) + (foreign ? provenance(ctx.record, existing) : ""),
	});
	if (foreign) {
		out(
			`skipped ${REFERENCE_FILE} — it does not open on the CORE-OWNED marker, so the core did not write it`,
		);
		return rules;
	}
	return [
		...rules,
		...bringFile(ctx, {
			rel: REFERENCE_FILE,
			body:
				renderReference(pluginRoot) +
				provenance(ctx.record, reference ?? existing),
		}),
	];
}

/**
 * @param {import("./plugin-record.js").PluginRecord|null} record
 * @param {string|null} existing the file carrying the block as it stands
 */
function provenance(record, existing) {
	if (record) return renderPluginRecord(record);
	const at = existing?.indexOf(`\n${PROVENANCE_HEADING}\n`) ?? -1;
	return existing === null || at === -1 ? "" : existing.slice(at);
}

/**
 * @param {Context} ctx
 * @returns {RenderConfig}
 */
function renderConfig({ config, root }) {
	if (config) return config;
	const read = readConfig({ root, quiet: true });
	return {
		founder: read.founder,
		modules: read.modules,
		categories: read.categories,
	};
}

/**
 * The core's `.claude/settings.json` keys, merged onto the adopter's own and
 * written 2-space (#1484).
 * @param {Context} ctx
 */
function bringSettings(ctx) {
	if (!ctx.pin) return [];
	const text = readIfPresent(path.join(ctx.root, SETTINGS));
	/** @type {Record<string, unknown>} */
	let existing = {};
	try {
		existing = text === null ? {} : JSON.parse(text);
	} catch (err) {
		throw new Error(
			`${SETTINGS} does not parse — fix or move it, then re-run: ${caught(err).message}`,
			{ cause: err },
		);
	}
	const merged = settingsKeys({ ...ctx.pin, outputStyle: null }, existing);
	/* A file whose keys are current keeps its own layout (#1484). */
	if (text !== null && isDeepStrictEqual(merged, existing)) return [];
	return bringFile(ctx, {
		rel: SETTINGS,
		body: `${JSON.stringify(merged, null, 2)}\n`,
	});
}

/** @param {Context} ctx */
function bringIgnoreBlock(ctx) {
	const text = readIfPresent(path.join(ctx.root, ".gitignore")) ?? "";
	const next = withIgnoreBlock(text);
	return next === null ? [] : bringFile(ctx, { rel: ".gitignore", body: next });
}

/** @param {Context} ctx */
function bringCoreCost({ root, pin, measureCore, dryRun, out }) {
	if (!measureCore || !pin) return [];
	const before = readIfPresent(path.join(root, COST_TABLE));
	seedCoreCost({
		root,
		pluginId: `${pin.plugin}@${pin.marketplace}`,
		measure: measureCore,
		dryRun,
		out,
	});
	return readIfPresent(path.join(root, COST_TABLE)) === before
		? []
		: [COST_TABLE];
}

/* A first guess: the script prices every ledger session's transcripts. */
const SESSION_COST_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * The cost table the capped launch sizes a set from, built from the host's own
 * dispatch ledger where it has none (#1734): another repo's table misprices
 * this one's sessions. An existing table is left alone — refreshing it is the
 * script's, by hand.
 * Residual: a build that fails, as where no ledger entry matches a transcript,
 * is re-run on every upgrade and says FAILED each time until one succeeds.
 * @param {Context} ctx
 */
function bringSessionCostTable({ root, pluginRoot, dryRun, out }) {
	if (fs.existsSync(path.join(root, SESSION_COST_TABLE))) return [];
	/* ledgerPath creates the markers directory, which a dry run must not. */
	if (!fs.existsSync(path.join(root, MARKERS_REL))) return [];
	if (!readIfPresent(ledgerPath(root))?.trim()) return [];
	const script = path.join(pluginRoot, "scripts", "measure-session-cost.js");
	const command = `node ${script} --write`;
	if (!fs.existsSync(script)) {
		out(`MISSING ${script} — the plugin root carries no copy`);
		return [];
	}
	if (dryRun) {
		out(`would   build ${SESSION_COST_TABLE} (${command})`);
		return [];
	}
	const r = spawnSync(process.execPath, [script, "--write"], {
		cwd: root,
		/* hostRoot() places the table off the first, ledgerPath() reads the
		 * second before anything else: an inherited value prices another repo. */
		env: { ...process.env, CLAUDE_PROJECT_DIR: root, WFC_DISPATCH_ROOT: root },
		encoding: "utf8",
		timeout: SESSION_COST_TIMEOUT_MS,
	});
	if (r.status !== 0 || !fs.existsSync(path.join(root, SESSION_COST_TABLE))) {
		const said = (r.stderr || r.error?.message || "").trim().split("\n")[0];
		out(
			`FAILED building ${SESSION_COST_TABLE}: ${said || `exit ${r.status}`} — build it by hand: ${command}`,
		);
		return [];
	}
	out(
		`built   ${SESSION_COST_TABLE} (${r.stdout.trim()}) — refresh it with ${command}`,
	);
	return [SESSION_COST_TABLE];
}

/**
 * The host registries guard-registry-atomicity.sh and check-registrations.js
 * judge the repo's own hooks against, written empty where absent and never
 * touched after: the adopter fills them (#1456).
 * @param {Context} ctx
 */
function bringRegistries(ctx) {
	const seeds = {
		[HOST_REGISTRATIONS]: emptyRegistry(),
		[HOST_NEEDLES]: emptyNeedles(),
	};
	return Object.entries(seeds).flatMap(([rel, body]) =>
		readIfPresent(path.join(ctx.root, rel)) === null
			? bringFile(ctx, { rel, body })
			: [],
	);
}

/**
 * The tracker's labels: one `gh label list`, then a create for each label
 * missing or changed (#1484).
 * @param {Context} ctx
 */
function bringLabels(ctx) {
	const { labels, dryRun, out } = ctx;
	if (labels && "off" in labels) {
		out(`skipped the labels — ${labels.off}`);
		return [];
	}
	if (!labels) {
		out("skipped the labels — this run was given no gh to sync them through");
		return [];
	}
	const repo = trackerOf(ctx);
	if (repo === undefined) {
		out(
			"skipped the labels — no `tracker` in .claude/workflow-core.json and no GitHub origin remote to derive one from",
		);
		return [];
	}
	let config;
	let have;
	try {
		config = renderConfig(ctx);
		have = labels.list(repo);
	} catch (err) {
		out(`FAILED reading ${repo}'s labels: ${errLine(err)} — none synced`);
		return [];
	}
	const plan = labelPlan({
		modules: config.modules,
		categories: config.categories,
	});
	const owed = plan.filter((want) => !have.some((h) => isSameLabel(h, want)));
	if (owed.length === 0) return [];
	if (dryRun) {
		for (const label of owed) out(`would   gh label create ${label.name}`);
		return [];
	}
	const failed = owed.flatMap((label) => {
		try {
			labels.create(repo, label);
			return [];
		} catch (err) {
			return [`${label.name} (${errLine(err)})`];
		}
	});
	out(
		`labels   ${repo}: ${owed.length - failed.length} of ${plan.length} created or updated` +
			(failed.length > 0 ? `, FAILED ${failed.join(", ")}` : ""),
	);
	return [];
}

/**
 * The declared tracker, else the origin remote's; a config that will not read
 * falls back to the remote, saying so (#1484).
 * @param {{root: string, out: (line: string) => void}} ctx
 * @returns {string|undefined}
 */
function trackerOf({ root, out }) {
	let repo;
	try {
		repo = resolveKey("tracker", { root });
	} catch (err) {
		out(
			`labels   ${errLine(err)} — falling back to the origin remote's tracker`,
		);
		repo = deriveTracker(root);
	}
	return typeof repo === "string" ? repo : undefined;
}

/**
 * GitHub matches a label's name with case ignored and returns its colour in
 * lower case.
 * @param {Label} have
 * @param {Label} want
 */
const isSameLabel = (have, want) =>
	have.name.toLowerCase() === want.name.toLowerCase() &&
	have.color.toLowerCase() === want.color.toLowerCase() &&
	(have.description ?? "") === want.description;

/**
 * The live gh calls, against `root`'s checkout.
 * @param {string} root
 * @returns {LabelGh}
 */
const ghLabels = (root) => ({
	list: (repo) =>
		ghJson(
			[
				"label",
				"list",
				"--repo",
				repo,
				"--json",
				"name,color,description",
				"--limit",
				"1000",
			],
			{ cwd: root },
		),
	create: (repo, label) => {
		gh(
			[
				"label",
				"create",
				label.name,
				"--repo",
				repo,
				"--color",
				label.color,
				"--description",
				label.description,
				"--force",
			],
			{ cwd: root },
		);
	},
});

/**
 * @typedef {object} Entry
 * @property {(ctx: Context) => string[]} bring
 * @property {string[]} paths every adopter-relative path `bring` may write
 */

/**
 * Every core-owned file, in the order each needs the last: the core-cost row
 * reads the settings entry's declaration.
 * @type {Entry[]}
 */
const ENTRIES = [
	{ bring: bringHooks, paths: HOOKS.map((hook) => `.husky/${hook}`) },
	{ bring: bringHelpers, paths: HELPERS },
	{ bring: bringRules, paths: [RULES_FILE, REFERENCE_FILE] },
	{ bring: bringSettings, paths: [SETTINGS] },
	{ bring: bringIgnoreBlock, paths: [".gitignore"] },
	{ bring: bringCoreCost, paths: [COST_TABLE] },
	{ bring: bringSessionCostTable, paths: [SESSION_COST_TABLE] },
	{ bring: bringRegistries, paths: [HOST_REGISTRATIONS, HOST_NEEDLES] },
	{ bring: bringLabels, paths: [] },
];

/**
 * Brings every entry current.
 * @param {Context} ctx
 * @param {Entry[]} [entries]
 * @returns {string[]} the paths written, adopter-relative
 */
function bringCoreFiles(ctx, entries = ENTRIES) {
	return entries.flatMap(({ bring, paths }) => {
		const wrote = bring(ctx);
		const undeclared = wrote.filter((rel) => !paths.includes(rel));
		/* An undeclared path would miss the skeleton commit (#1540). */
		if (undeclared.length > 0)
			throw new Error(
				`${bring.name} wrote ${undeclared.join(", ")}, which its entry's paths do not declare`,
			);
		return wrote;
	});
}

/** @param {Entry[]} [entries] */
const coreOwnedPaths = (entries = ENTRIES) =>
	entries.flatMap((entry) => entry.paths);

/** The directories and files the skeleton commit takes whole.
 *
 * `scripts` is not one: a bare directory would sweep an adopter's own
 * untracked files there into the skeleton commit (#133). */
const SKELETON_ROOTS = ["CLAUDE.md", "AGENTS.md", ".claude", "docs", ".husky"];

/**
 * The skeleton commit's pathspec, which init prints as its next step and
 * new-repo.js commits: `SKELETON_ROOTS`, then each entry path none of them
 * covers that `isPresent` finds. An entry may write nothing on a run, and a
 * pathspec naming an absent path fails.
 * @param {(rel: string) => boolean} isPresent
 * @param {Entry[]} [entries]
 */
function skeletonPaths(isPresent, entries = ENTRIES) {
	return [
		...SKELETON_ROOTS,
		...coreOwnedPaths(entries).filter(
			(rel) => !isUnder(rel, SKELETON_ROOTS) && isPresent(rel),
		),
	];
}

module.exports = {
	bringCoreFiles,
	coreOwnedPaths,
	skeletonPaths,
	ghLabels,
	readIfPresent,
};
