const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { isDeepStrictEqual } = require("node:util");
const {
	renderSessionRules,
	renderReference,
	renderPluginRecord,
	renderHookShim,
	withIgnoreBlock,
	withStatusScript,
	STATUS_SCRIPT,
	settingsKeys,
	labelPlan,
	hookRootOf,
	RULES_FILE,
	REFERENCE_FILE,
	CORE_OWNED,
	PROVENANCE_HEADING,
	HOOKS,
	LOCAL_HOOKS,
	HELPERS,
	COPIES_IF_HELD,
} = require("./adopter-skeleton.js");
const { isHookShim } = require("./hook-shim.js");
const {
	readConfig,
	resolveKey,
	deriveTracker,
} = require("./workflow-core-config.js");
const { seedCoreCost, COST_TABLE } = require("./core-context-cost.js");
const { ledgerPath } = require("./dispatch-ledger.js");
const { MARKERS_REL } = require("./marker-root.js");
const { CORE_DOCS } = require("./core-docs.js");
const {
	CI_WORKFLOW,
	renderCiWorkflow,
	isCoreWorkflow,
} = require("./adopter-ci.js");
const {
	LANDER_NAMED_WORKFLOW,
	LANDER_SUITE_WORKFLOW,
	LANDER_CONFIG_KEYS,
	renderLanderWorkflows,
} = require("./lander-workflows.js");
const { SESSION_COST_TABLE, readCostTableIn } = require("./session-spend.js");
const { gh, ghJson, parseErrLine } = require("./gh.js");
const { caught } = require("./caught.js");
const { readText, dataOrThrow } = require("./file-read.js");
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
 * @typedef {object} LabelGh
 * @property {(repo: string) => Label[]} list
 * @property {(repo: string, label: Label) => void} create
 */

/** @typedef {LabelGh|{off: string}} Labels */

/**
 * @typedef {object} RenderConfig
 * @property {string|undefined} founder
 * @property {Module[]} modules
 * @property {Record<string, string>} categories
 */

/**
 * @typedef {object} Context
 * @property {string} root
 * @property {string} pluginRoot
 * @property {boolean} dryRun
 * @property {(line: string) => void} out
 * @property {boolean} [fresh]
 * @property {RenderConfig} [config]
 * @property {import("./plugin-record.js").PluginRecord|null} record
 * @property {{marketplace: string, source: object, plugin: string}|null} pin
 * @property {import("./core-context-cost.js").Measurer} [measureCore]
 * @property {Labels} [labels]
 */

/**
 * @param {Context} ctx
 * @param {{rel: string, body: string, mode?: number, lost?: string, ifHeld?: boolean}} file
 * @returns {string[]}
 */
function bringFile({ root, dryRun, out }, { rel, body, mode, lost, ifHeld }) {
	const at = path.join(root, rel);
	const existing = readIfPresent(at);
	if (existing === null && ifHeld) return [];
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
 * @returns {string|null}
 */
const readIfPresent = (at) => dataOrThrow(readText(at));

/** @param {Context} ctx */
function bringHooks(ctx) {
	return HOOKS.flatMap((hook) => {
		const rel = path.join(".husky", hook);
		const existing = readIfPresent(path.join(ctx.root, rel));
		if (
			existing !== null &&
			!isHookShim(existing) &&
			hookRootOf(existing) === null
		) {
			const wayOut = LOCAL_HOOKS.includes(hook)
				? `; move its own gates to ${rel}.local and delete it, and the next upgrade writes the shim`
				: "";
			ctx.out(
				`skipped ${rel} — the adopter's own hook (no shim marker or WFC_PLUGIN_ROOT line), so the core's ${hook} gate does not run there${wayOut}`,
			);
			return [];
		}
		return bringFile(ctx, { rel, body: renderHookShim(hook), mode: 0o755 });
	});
}

/**
 * @param {Context} ctx
 * @param {string} rel
 * @param {{mode?: number, ifHeld?: boolean}} [how]
 */
function bringPluginCopy(ctx, rel, { mode, ifHeld } = {}) {
	const body = readIfPresent(path.join(ctx.pluginRoot, rel));
	if (body === null) {
		ctx.out(`MISSING ${rel} — the plugin root carries no copy`);
		return [];
	}
	return bringFile(ctx, {
		rel,
		body,
		mode,
		ifHeld,
		lost: "it differed from the plugin's copy, so any local edit to it is gone",
	});
}

/** @param {Context} ctx */
const bringHelpers = (ctx) =>
	HELPERS.flatMap((rel) => bringPluginCopy(ctx, rel, { mode: 0o755 }));

/** @param {Context} ctx */
const bringHeldCopies = (ctx) =>
	COPIES_IF_HELD.flatMap((rel) => bringPluginCopy(ctx, rel, { ifHeld: true }));

/** @param {Context} ctx */
const bringCoreDocs = (ctx) =>
	CORE_DOCS.flatMap((rel) => bringPluginCopy(ctx, rel));

/**
 * @typedef {object} WorkflowBring
 * @property {string[]} paths
 * @property {string[]} faultKeys
 * @property {(cfg: import("./workflow-core-config.js").Config) => {write: {rel: string, body: string}[]} | {remove: string} | "leave"} want
 */

/**
 * @param {Context} ctx
 * @param {WorkflowBring} bring
 * @returns {string[]}
 */
function bringWorkflows(ctx, { paths, faultKeys, want }) {
	const { root, dryRun, out } = ctx;
	let cfg;
	try {
		cfg = readConfig({ root, quiet: true });
	} catch (err) {
		out(`skipped ${paths.join(", ")}: ${caught(err).message}`);
		return [];
	}
	const fault = cfg.faults.find((f) => faultKeys.includes(f.key));
	if (fault) {
		out(`skipped ${paths.join(", ")}: ${fault.text}`);
		return [];
	}
	const wanted = want(cfg);
	if (wanted === "leave") return [];
	/** @param {string} rel @returns {string|null|false} */
	const coreCopy = (rel) => {
		const existing = readIfPresent(path.join(root, rel));
		if (existing === null || isCoreWorkflow(existing)) return existing;
		out(
			`skipped ${rel} — it does not open on the CORE-OWNED marker, so the core did not write it`,
		);
		return false;
	};
	if ("write" in wanted)
		return wanted.write.flatMap((file) =>
			coreCopy(file.rel) === false ? [] : bringFile(ctx, file),
		);
	return paths.flatMap((rel) => {
		const existing = coreCopy(rel);
		if (existing === false || existing === null) return [];
		if (dryRun) {
			out(`would   remove ${rel}`);
			return [];
		}
		fs.rmSync(path.join(root, rel));
		out(`removed ${rel} — .claude/workflow-core.json ${wanted.remove}`);
		return [rel];
	});
}

/** @param {Context} ctx */
const bringCi = (ctx) =>
	bringWorkflows(ctx, {
		paths: [CI_WORKFLOW],
		faultKeys: ["ci", "ciSetup"],
		want: ({ ci, ciSetup }) =>
			ci
				? { write: [{ rel: CI_WORKFLOW, body: renderCiWorkflow(ci, ciSetup) }] }
				: { remove: 'carries no "ci" key' },
	});

/** @param {Context} ctx */
const bringLanderWorkflows = (ctx) =>
	bringWorkflows(ctx, {
		paths: [LANDER_SUITE_WORKFLOW, LANDER_NAMED_WORKFLOW],
		faultKeys: ["landingTester", ...LANDER_CONFIG_KEYS],
		want: (cfg) => {
			const { landingTester } = cfg;
			if (landingTester === "auto")
				return { write: renderLanderWorkflows(cfg) };
			if (landingTester === "local")
				return { remove: 'pins "landingTester": "local"' };
			return "leave";
		},
	});

/** @param {Context} ctx */
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
	try {
		config = renderConfig(ctx);
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
	const rules = bringFile(ctx, {
		rel: RULES_FILE,
		body:
			renderSessionRules({
				modules: config.modules,
				founder: config.founder,
				pluginRoot,
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
 * @param {string|null} existing
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

/** @param {Context} ctx */
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
function bringStatusScript(ctx) {
	const text = readIfPresent(path.join(ctx.root, "package.json"));
	if (text === null) return [];
	let outcome;
	try {
		outcome = withStatusScript(text);
	} catch (err) {
		ctx.out(`skipped package.json's status script: ${caught(err).message}`);
		return [];
	}
	if (outcome.kept)
		ctx.out(
			`kept    package.json's own status script, which prints no primitives count line — the plugin's is: ${STATUS_SCRIPT}`,
		);
	return outcome.body === null
		? []
		: bringFile(ctx, { rel: "package.json", body: outcome.body });
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

// guess, #5529
const SESSION_COST_TIMEOUT_MS = 5 * 60 * 1000;

/** @param {Context} ctx */
function bringSessionCostTable({ root, pluginRoot, dryRun, out }) {
	if (readCostTableIn(root)) return [];
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
		env: { ...process.env, CLAUDE_PROJECT_DIR: root, WFC_DISPATCH_ROOT: root },
		encoding: "utf8",
		timeout: SESSION_COST_TIMEOUT_MS,
	});
	if (r.status !== 0 || !readCostTableIn(root)) {
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

/** @param {Context} ctx */
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

/** @param {Context} ctx */
function bringLabels(ctx) {
	const { root, labels, dryRun, out } = ctx;
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
		out(`FAILED reading ${repo}'s labels: ${parseErrLine(err)} — none synced`);
		return [];
	}
	const plan = labelPlan({
		modules: config.modules,
		categories: config.categories,
		ciWorkflow: fs.existsSync(path.join(root, CI_WORKFLOW)),
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
			return [`${label.name} (${parseErrLine(err)})`];
		}
	});
	out(
		`labels   ${repo}: ${owed.length - failed.length} of ${plan.length} created or updated` +
			(failed.length > 0 ? `, FAILED ${failed.join(", ")}` : ""),
	);
	return [];
}

/**
 * @param {{root: string, out: (line: string) => void}} ctx
 * @returns {string|undefined}
 */
function trackerOf({ root, out }) {
	let repo;
	try {
		repo = resolveKey("tracker", { root });
	} catch (err) {
		out(
			`labels   ${parseErrLine(err)} — falling back to the origin remote's tracker`,
		);
		repo = deriveTracker(root);
	}
	return typeof repo === "string" ? repo : undefined;
}

/**
 * @param {Label} have
 * @param {Label} want
 */
const isSameLabel = (have, want) =>
	have.name.toLowerCase() === want.name.toLowerCase() &&
	have.color.toLowerCase() === want.color.toLowerCase() &&
	(have.description ?? "") === want.description;

/**
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
 * @property {string[]} paths
 * @property {boolean} [ifHeld]
 */

/** @type {Entry[]} */
const ENTRIES = [
	{ bring: bringHooks, paths: HOOKS.map((hook) => `.husky/${hook}`) },
	{ bring: bringHelpers, paths: HELPERS },
	{ bring: bringHeldCopies, paths: COPIES_IF_HELD, ifHeld: true },
	{ bring: bringRules, paths: [RULES_FILE, REFERENCE_FILE] },
	{ bring: bringCoreDocs, paths: CORE_DOCS },
	{ bring: bringCi, paths: [CI_WORKFLOW] },
	{
		bring: bringLanderWorkflows,
		paths: [LANDER_SUITE_WORKFLOW, LANDER_NAMED_WORKFLOW],
	},
	{ bring: bringSettings, paths: [SETTINGS] },
	{ bring: bringIgnoreBlock, paths: [".gitignore"] },
	{ bring: bringStatusScript, paths: ["package.json"] },
	{ bring: bringCoreCost, paths: [COST_TABLE] },
	{ bring: bringSessionCostTable, paths: [SESSION_COST_TABLE] },
	{ bring: bringRegistries, paths: [HOST_REGISTRATIONS, HOST_NEEDLES] },
	{ bring: bringLabels, paths: [] },
];

/**
 * @param {Context} ctx
 * @param {Entry[]} [entries]
 * @returns {string[]}
 */
function bringCoreFiles(ctx, entries = ENTRIES) {
	return entries.flatMap(({ bring, paths }) => {
		const wrote = bring(ctx);
		const undeclared = wrote.filter((rel) => !paths.includes(rel));
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

const SKELETON_ROOTS = ["CLAUDE.md", "AGENTS.md", ".claude", "docs", ".husky"];

/**
 * @param {(rel: string) => boolean} isPresent
 * @param {Entry[]} [entries]
 * @param {(rel: string) => boolean} [isHeld]
 */
function skeletonPaths(isPresent, entries = ENTRIES, isHeld = isPresent) {
	return [
		...SKELETON_ROOTS,
		...entries
			.flatMap(({ paths, ifHeld }) =>
				paths.filter((rel) => (ifHeld ? isHeld : isPresent)(rel)),
			)
			.filter((rel) => !isUnder(rel, SKELETON_ROOTS)),
	];
}

module.exports = {
	bringCoreFiles,
	coreOwnedPaths,
	skeletonPaths,
	ghLabels,
	readIfPresent,
};
