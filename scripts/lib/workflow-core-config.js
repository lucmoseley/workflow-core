const fs = require("node:fs");
const path = require("node:path");
const { execGit } = require("./git.js");
const { readCommittedFile } = require("./git-objects.js");
const { isRepoPath, isRepoPathList } = require("./repo-path.js");
const { hostRoot } = require("./host-root.js");
const { caught, orFallback } = require("./caught.js");
const { writeFd } = require("./write-fd.js");
const { ghUnrouted } = require("./gh-binary.js");

const CONFIG_PATH = path.posix.join(".claude", "workflow-core.json");

/** @param {string} root */
const hasConfig = (root) => fs.existsSync(path.join(root, CONFIG_PATH));

const KNOWN_CONTRACTS = [1];
const CONTRACT = 1;

const MIGRATIONS_DIR = "migrations";

const PATH_KEYS = /** @type {const} */ ({
	// #401
	capacityLadderPath: {
		fallback: "docs/capacity-procurement-ladder.md",
		what: "the capacity ladder",
	},
	// #438
	cycleLogPath: { fallback: "docs/cycle-log.md", what: "the cycle log" },
	// #452
	brandSheetPath: { fallback: "docs/brand-sheet.md", what: "the brand sheet" },
	// #447
	userSettingsSnapshotPath: {
		fallback: "docs/claude-user-settings.md",
		what: "the settings snapshot",
	},
	// #455
	pickNextRankingPath: {
		fallback: ".claude/pick-next-ranking.md",
		what: "the pick-next ranking rules",
	},
});
/** @typedef {keyof typeof PATH_KEYS} PathKey */
const PATH_KEY_NAMES = /** @type {PathKey[]} */ (Object.keys(PATH_KEYS));

const OUTPUT_STYLE_DEFAULT = ".claude/output-styles/core-voice.md";

const UPSTREAM_TRACKER = "lucmoseley/workflow-core-tracker";
const UPSTREAM_CODE_REPO = "lucmoseley/workflow-core";

const TRACKER_SHAPE = /^[\w.-]+\/[\w.-]+$/;
const OWN_MISSING_LINE = `WARN ${CONFIG_PATH}: no own tracker resolves, so "corpus" is ${UPSTREAM_TRACKER} alone — declare "corpus" or "tracker"`;

const DEPLOYS = /** @type {const} */ (["vercel"]);
const LANDING_TESTERS = /** @type {const} */ (["auto", "local", "actions"]);
const CI_RUNNERS = /** @type {const} */ (["ubuntu-slim", "ubuntu-24.04-arm"]);
// GitHub ends a single-CPU runner's job at 15 minutes: https://docs.github.com/en/actions/reference/runners/github-hosted-runners
const SLIM_MAX_MINUTES = 15;

const MODULES = /** @type {const} */ ([
	"roadmap",
	"governance",
	"site",
	"mutation",
	"comments",
]);
const COMMANDS = /** @type {const} */ ([
	"test",
	"lint",
	"typecheck",
	"check",
	"check_staged",
	"helper_check",
	"full_test",
]);
const TEST_CANARY = "testCanary";
const PYTHON_KINDS = /** @type {const} */ ([
	"program",
	"test",
	"library",
	"none",
]);
const KNOWN_KEYS = [
	"contract",
	"founder",
	"tracker",
	"codeRepo",
	"login",
	"name",
	"corpus",
	"commands",
	"deploy",
	"modules",
	"categories",
	"disabled",
	"overrides",
	"capacityLadder",
	"admissionGate",
	"refillLoop",
	"refillPanel",
	...PATH_KEY_NAMES,
	"manualRender",
	"alwaysLoaded",
	"roadmapMajorPin",
	"ruffExclude",
	"pythonRoutes",
	"sessionMeanMb",
	"sessionSigmaMb",
	"gateSeatMb",
	"fullTestShards",
	"landingTester",
	"founderNotice",
	"ci",
	"suiteRunners",
	"worktreeLinks",
	"polled",
	"walkedTo",
	"retro",
	"archScan",
	"sensitivePaths",
	"mods",
	"stepsOwed",
];

/** @returns {Record<Command, string|null>} */
const unsetCommands = () =>
	/** @type {Record<Command, string|null>} */ (
		Object.fromEntries(COMMANDS.map((c) => [c, null]))
	);

/** @typedef {typeof MODULES[number]} Module */
/** @typedef {Module|Module[]} ModuleGate */
/** @typedef {typeof COMMANDS[number]} Command */
/** @typedef {typeof DEPLOYS[number]} Deploy */
/** @typedef {typeof LANDING_TESTERS[number]} LandingTester */
/** @typedef {typeof CI_RUNNERS[number]} CiRunner */
/** @typedef {{runner: CiRunner, timeoutMinutes?: number}} Ci */
/** @typedef {typeof PYTHON_KINDS[number]} PythonKind */
/**
 * @typedef {object} ConfigOpts
 * @property {string} [root]
 * @property {string} [rev]
 */

/** @typedef {ConfigBase & Partial<Record<PathKey, string>>} Config */

/**
 * @typedef {object} ConfigBase
 * @property {string} file
 * @property {number} contract
 * @property {string} [founder]
 * @property {string} [tracker]
 * @property {string} [codeRepo]
 * @property {string} [login]
 * @property {string} [name]
 * @property {string[]} [corpus]
 * @property {Record<Command, string|null>} commands
 * @property {string|null} testCanary
 * @property {Deploy} [deploy]
 * @property {Module[]} modules
 * @property {Record<string, string>} categories
 * @property {string[]} disabled
 * @property {{skills: Record<string, string>, output_style: string|null}} overrides
 * @property {boolean} [capacityLadder]
 * @property {boolean} [admissionGate]
 * @property {boolean} refillLoop
 * @property {boolean} refillPanel
 * @property {{command: string, outputs: string[]}} [manualRender]
 * @property {number} [roadmapMajorPin]
 * @property {string[]} [ruffExclude]
 * @property {Record<string, PythonKind>} [pythonRoutes]
 * @property {number} [sessionMeanMb]
 * @property {number} [sessionSigmaMb]
 * @property {number} [gateSeatMb]
 * @property {LandingTester} landingTester
 * @property {number} [fullTestShards]
 * @property {Ci} [ci]
 * @property {FounderNotice} [founderNotice]
 * @property {string[]} [suiteRunners]
 * @property {string[]} [worktreeLinks]
 * @property {string[]} polled
 * @property {string[]} [alwaysLoaded]
 * @property {{weeklyCount?: number}} [retro]
 * @property {{threshold?: number, exclude?: string[]}} [archScan]
 * @property {SensitivePath[]} [sensitivePaths]
 * @property {string[]} warnings
 * @property {ConfigFault[]} faults
 */

/**
 * @typedef {object} ConfigFault
 * @property {string} key
 * @property {"malformed"|"unknown-key"} kind
 * @property {string} text
 */

/**
 * @typedef {object} SensitivePath
 * @property {string} name
 * @property {string} description
 * @property {string[]} globs
 * @property {string} focus
 * @property {string[]} examples
 * @property {boolean} live
 */

class ConfigContractError extends Error {}

/** @type {Set<string>} */
const warned = new Set();

/**
 * @param {string} line
 * @param {(line: string) => void} [say]
 */
const warnOnce = (line, say = (l) => writeFd(2, `${l}\n`)) => {
	if (warned.has(line)) return;
	warned.add(line);
	say(line);
};

/** @param {unknown} v @returns {v is number} */
const isPositiveInt = (v) =>
	typeof v === "number" && Number.isInteger(v) && v > 0;

/** @param {unknown} v */
const isPlainObject = (v) =>
	typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * @typedef {{workflow: string, repo: string, mention: string}} FounderNotice
 */

/** @param {unknown} v @returns {v is FounderNotice} */
function isFounderNotice(v) {
	if (!isPlainObject(v)) return false;
	const { workflow, repo, mention } = /** @type {Record<string, unknown>} */ (
		v
	);
	return (
		[workflow, repo, mention].every((x) => typeof x === "string" && x !== "") &&
		String(repo).includes("/") &&
		!String(mention).startsWith("@")
	);
}

/** @param {unknown} v @returns {v is string} */
const isString = (v) => typeof v === "string";

/** @param {unknown} v @returns {v is string[]} */
const isStringArray = (v) =>
	Array.isArray(v) && v.every((x) => typeof x === "string");

/** @param {unknown} v @returns {v is boolean} */
const isBoolean = (v) => typeof v === "boolean";

/** @param {unknown} v @returns {v is number} */
const isNumber = (v) => typeof v === "number";

/** @param {unknown} v @returns {v is Deploy} */
const isDeploy = (v) => DEPLOYS.includes(/** @type {Deploy} */ (v));
/** @param {unknown} v @returns {v is LandingTester} */
const isLandingTester = (v) =>
	LANDING_TESTERS.includes(/** @type {LandingTester} */ (v));

/** @param {unknown} v @returns {v is Ci} */
function isCi(v) {
	if (!isPlainObject(v)) return false;
	const o = /** @type {Record<string, unknown>} */ (v);
	return (
		Object.keys(o).every((k) => k === "runner" || k === "timeoutMinutes") &&
		CI_RUNNERS.includes(/** @type {CiRunner} */ (o.runner)) &&
		(o.timeoutMinutes === undefined ||
			(isPositiveInt(o.timeoutMinutes) &&
				(o.runner !== "ubuntu-slim" ||
					Number(o.timeoutMinutes) <= SLIM_MAX_MINUTES)))
	);
}

/** @param {unknown} v @returns {v is Record<string, PythonKind>} */
const isPythonRoutes = (v) =>
	isPlainObject(v) &&
	Object.entries(/** @type {object} */ (v)).every(
		([g, k]) => g !== "" && PYTHON_KINDS.includes(k),
	);

/** @param {unknown} v @returns {v is Record<string, string>} */
const isStringRecord = (v) =>
	isPlainObject(v) &&
	Object.values(/** @type {object} */ (v)).every((x) => typeof x === "string");

/**
 * @param {Record<string, unknown>} raw
 * @param {string} file
 */
function contractOf(raw, file) {
	if (!("contract" in raw)) return CONTRACT;
	const n = raw.contract;
	if (typeof n === "number" && KNOWN_CONTRACTS.includes(n)) return n;
	throw new ConfigContractError(
		`${file} declares contract ${JSON.stringify(n)}, which this workflow-core does not read ` +
			`(it reads ${KNOWN_CONTRACTS.join(", ")}). Read the migration note in ${MIGRATIONS_DIR}/ of the ` +
			"workflow-core release that set it — its *Residue* section names the contract — then pin " +
			"that release or run its upgrade.",
	);
}

/**
 * @typedef {object} RawConfig
 * @property {Record<string, unknown>} raw
 * @property {string[]} warnings
 * @property {ConfigFault[]} faults
 */

/**
 * @param {RawConfig} cfg
 * @param {string} key
 * @param {string} want
 */
function warnReadAsDefault(cfg, key, want) {
	addFault(cfg, { key, kind: "malformed", text: `"${key}" is not ${want}` });
}

/**
 * @param {RawConfig} cfg
 * @param {string} key
 */
function warnUnknownKey(cfg, key) {
	addFault(cfg, { key, kind: "unknown-key", text: `unknown key "${key}"` });
}

/**
 * @param {RawConfig} cfg
 * @param {ConfigFault} fault
 */
function addFault(cfg, fault) {
	cfg.warnings.push(buildWarningLine(fault));
	cfg.faults.push(fault);
}

/** @param {ConfigFault} fault */
const buildWarningLine = (fault) =>
	fault.kind === "malformed"
		? `${fault.text} — read as its default`
		: fault.text;

/**
 * @param {string} file
 * @param {string} what
 * @param {unknown} err
 */
const configError = (file, what, err) =>
	new Error(`${file} ${what}: ${caught(err).message}`, { cause: err });

/**
 * @param {string} text
 * @param {string} file
 * @returns {Record<string, unknown>}
 */
function parseConfigText(text, file) {
	try {
		const parsed = JSON.parse(text);
		if (!isPlainObject(parsed)) throw new Error("not a JSON object");
		return parsed;
	} catch (err) {
		throw configError(file, "does not parse", err);
	}
}

/**
 * @param {string} file
 * @returns {Record<string, unknown>}
 */
function parseConfigFile(file) {
	let text;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch (err) {
		if (caught(err).code === "ENOENT") return {};
		throw configError(file, "does not parse", err);
	}
	return parseConfigText(text, file);
}

/**
 * @param {string} root
 * @param {string} rev
 * @param {string} file
 * @returns {Record<string, unknown>}
 */
function parseConfigBlob(root, rev, file) {
	let text;
	try {
		text = readCommittedFile(rev, CONFIG_PATH, { cwd: root });
	} catch (err) {
		throw configError(file, "cannot be read", err);
	}
	return text === null ? {} : parseConfigText(text, file);
}

/**
 * @template T
 * @param {RawConfig} cfg
 * @param {string} key
 * @param {(v: unknown) => v is T} isValid
 * @param {string} want
 * @returns {T|undefined}
 */
function readKey(cfg, key, isValid, want) {
	if (!(key in cfg.raw)) return;
	const v = cfg.raw[key];
	if (!isValid(v)) {
		warnReadAsDefault(cfg, key, want);
		return;
	}
	return v;
}

/**
 * @param {Pick<Config, "commands" | "fullTestShards">} config
 * @returns {number}
 */
const wholeRunShardCount = ({ commands, fullTestShards }) =>
	(commands.full_test ?? commands.test) ? (fullTestShards ?? 1) : 1;

/**
 * @param {RawConfig} cfg
 * @returns {LandingTester}
 */
const readLandingTester = (cfg) =>
	readKey(
		cfg,
		"landingTester",
		isLandingTester,
		`one of ${LANDING_TESTERS.join(", ")}`,
	) ?? "auto";

/**
 * @param {RawConfig} cfg
 * @returns {Record<Command, string|null>}
 */
function readCommands(cfg) {
	const commands = unsetCommands();
	if (!("commands" in cfg.raw)) return commands;
	if (!isPlainObject(cfg.raw.commands)) {
		warnReadAsDefault(cfg, "commands", "an object");
		return commands;
	}
	for (const [k, v] of Object.entries(
		/** @type {Record<string, unknown>} */ (cfg.raw.commands),
	)) {
		if (k === TEST_CANARY) continue;
		if (!COMMANDS.includes(/** @type {Command} */ (k)))
			warnUnknownKey(cfg, `commands.${k}`);
		else if (typeof v === "string" && v.trim())
			commands[/** @type {Command} */ (k)] = v;
		else if (v !== null)
			warnReadAsDefault(cfg, `commands.${k}`, "a command string or null");
	}
	return commands;
}

/**
 * @param {RawConfig} cfg
 * @returns {string|null}
 */
function readTestCanary(cfg) {
	if (!isPlainObject(cfg.raw.commands)) return null;
	const commands = /** @type {Record<string, unknown>} */ (cfg.raw.commands);
	if (!(TEST_CANARY in commands)) return null;
	const v = commands[TEST_CANARY];
	if (isRepoPath(v)) return v;
	if (v !== null)
		warnReadAsDefault(
			cfg,
			`commands.${TEST_CANARY}`,
			"a repo-relative path or null",
		);
	return null;
}

/**
 * @param {RawConfig} cfg
 * @returns {Module[]}
 */
function readModules(cfg) {
	/** @type {Module[]} */
	const modules = [];
	const injected = process.env.WFC_MODULES;
	if (injected !== undefined) {
		for (const m of injected.split(",").filter(Boolean)) {
			if (MODULES.includes(/** @type {Module} */ (m)))
				modules.push(/** @type {Module} */ (m));
			else cfg.warnings.push(`unknown module "${m}" in WFC_MODULES`);
		}
		return modules;
	}
	if (!("modules" in cfg.raw)) return modules;
	if (!Array.isArray(cfg.raw.modules)) {
		warnReadAsDefault(cfg, "modules", "an array");
		return modules;
	}
	for (const m of cfg.raw.modules) {
		if (MODULES.includes(m)) modules.push(m);
		else cfg.warnings.push(`unknown module ${JSON.stringify(m)}`);
	}
	return modules;
}

/**
 * @param {RawConfig} cfg
 * @param {Record<string, unknown>} obj
 * @returns {string|null}
 */
function readOutputStyle(cfg, obj) {
	if (typeof obj.output_style === "string") {
		if (/[\\/]/.test(obj.output_style) && isRepoPath(obj.output_style))
			return obj.output_style;
		warnReadAsDefault(cfg, "overrides.output_style", "a repo-relative path");
	} else if ("output_style" in obj && obj.output_style !== null)
		warnReadAsDefault(cfg, "overrides.output_style", "a string");
	return null;
}

/**
 * @param {RawConfig} cfg
 * @returns {ConfigBase["overrides"]}
 */
function readOverrides(cfg) {
	const overrides = {
		skills: /** @type {Record<string, string>} */ ({}),
		output_style: /** @type {string|null} */ (null),
	};
	if (!("overrides" in cfg.raw)) return overrides;
	const o = cfg.raw.overrides;
	if (!isPlainObject(o)) {
		warnReadAsDefault(cfg, "overrides", "an object");
		return overrides;
	}
	const obj = /** @type {Record<string, unknown>} */ (o);
	for (const k of Object.keys(obj)) {
		if (k !== "skills" && k !== "output_style")
			warnUnknownKey(cfg, `overrides.${k}`);
	}
	if (isPlainObject(obj.skills))
		overrides.skills = /** @type {Record<string, string>} */ (obj.skills);
	else if ("skills" in obj)
		warnReadAsDefault(cfg, "overrides.skills", "an object");
	overrides.output_style = readOutputStyle(cfg, obj);
	return overrides;
}

/**
 * @param {RawConfig} cfg
 * @returns {ConfigBase["manualRender"]}
 */
function readManualRender(cfg) {
	if (!("manualRender" in cfg.raw)) return;
	const m = cfg.raw.manualRender;
	const obj = isPlainObject(m)
		? /** @type {Record<string, unknown>} */ (m)
		: {};
	const { command, outputs } = obj;
	const isValid =
		typeof command === "string" &&
		command.trim() &&
		!/[\r\n]/.test(command) &&
		Array.isArray(outputs) &&
		outputs.length > 0 &&
		outputs.every((p) => isRepoPath(p) && !/[\r\n]/.test(p));
	if (!isValid) {
		warnReadAsDefault(
			cfg,
			"manualRender",
			"{command: a one-line command string, outputs: a non-empty array of one-line repo-relative paths}",
		);
		return;
	}
	return { command, outputs };
}

/**
 * @param {RawConfig} cfg
 * @returns {string[]|undefined}
 */
function readAlwaysLoaded(cfg) {
	const injectedPool = process.env.WFC_ALWAYS_LOADED;
	const alwaysLoaded =
		injectedPool === undefined
			? readKey(cfg, "alwaysLoaded", isStringArray, "an array of strings")
			: injectedPool.split(",").filter(Boolean);
	if (alwaysLoaded?.some((p) => !isRepoPath(p))) {
		warnReadAsDefault(cfg, "alwaysLoaded", "an array of repo-relative paths");
		return;
	}
	return alwaysLoaded;
}

/**
 * @param {RawConfig} cfg
 * @param {string} key
 * @param {Record<string, [(v: unknown) => boolean, string]>} checks
 * @returns {Record<string, unknown> | undefined}
 */
function readSubObject(cfg, key, checks) {
	if (!(key in cfg.raw)) return;
	if (!isPlainObject(cfg.raw[key])) {
		warnReadAsDefault(cfg, key, "an object");
		return;
	}
	const declared = /** @type {Record<string, unknown>} */ (cfg.raw[key]);
	/** @type {Record<string, unknown>} */
	const read = {};
	for (const [k, v] of Object.entries(declared)) {
		const check = checks[k];
		if (check === undefined) warnUnknownKey(cfg, `${key}.${k}`);
		else if (check[0](v)) read[k] = v;
		else warnReadAsDefault(cfg, `${key}.${k}`, check[1]);
	}
	return read;
}

/** @type {Record<string, [(v: unknown) => boolean, string]>} */
const MOD_SWITCHES = { "wfc-liveness": [isBoolean, "a boolean"] };

const DEFAULT_FOCUS = "access control and money logic";

/** @param {unknown} v @returns {v is string} */
const isNonEmptyString = (v) => typeof v === "string" && v !== "";

/**
 * @param {RawConfig} cfg
 * @returns {SensitivePath[]|undefined}
 */
function readSensitivePaths(cfg) {
	const declared = readKey(cfg, "sensitivePaths", Array.isArray, "an array");
	if (!declared) return;
	/** @type {SensitivePath[]} */
	const read = [];
	const names = new Set();
	declared.forEach((entry, i) => {
		const one = readSensitivePath(cfg, entry, `sensitivePaths[${i}]`, names);
		if (one) read.push(one);
	});
	return read;
}

/**
 * @param {RawConfig} cfg
 * @param {Record<string, unknown>} entry
 * @param {string} at
 * @param {Set<unknown>} names
 * @returns {SensitivePath|null}
 */
function readSensitivePath(cfg, entry, at, names) {
	if (!isPlainObject(entry) || !isNonEmptyString(entry.name)) {
		cfg.warnings.push(
			`"${at}" has no "name" string — entry dropped, so nothing matches it`,
		);
		return null;
	}
	const { name, description, globs, focus, examples, live, ...rest } = entry;
	for (const k of Object.keys(rest)) warnUnknownKey(cfg, `${at}.${k}`);
	if (names.has(name))
		cfg.warnings.push(`"${at}.name" repeats ${JSON.stringify(name)}`);
	names.add(name);
	const checkField = (
		/** @type {string} */ key,
		/** @type {(v: unknown) => boolean} */ isValid,
		/** @type {string} */ want,
		required = false,
	) => {
		const v = entry[key];
		if (isValid(v)) return true;
		if (required || v !== undefined)
			warnReadAsDefault(cfg, `${at}.${key}`, want);
		return false;
	};
	const kept = checkField("globs", Array.isArray, "an array")
		? keptGlobs(cfg, at, /** @type {unknown[]} */ (globs))
		: [];
	const nonEmpty = "a non-empty string";
	return {
		name: /** @type {string} */ (name),
		description: checkField("description", isNonEmptyString, nonEmpty, true)
			? /** @type {string} */ (description)
			: "",
		globs: kept,
		focus: checkField("focus", isNonEmptyString, nonEmpty)
			? /** @type {string} */ (focus)
			: DEFAULT_FOCUS,
		examples: checkField("examples", isStringArray, "an array of strings")
			? /** @type {string[]} */ (examples)
			: [],
		live: checkField("live", isBoolean, "a boolean") && live === true,
	};
}

/**
 * @param {RawConfig} cfg
 * @param {string} at
 * @param {unknown[]} globs
 * @returns {string[]}
 */
function keptGlobs(cfg, at, globs) {
	/** @type {string[]} */
	const kept = [];
	globs.forEach((g, j) => {
		if (isNonEmptyString(g)) kept.push(g);
		else
			cfg.warnings.push(
				`"${at}.globs[${j}]" is not a non-empty string — glob dropped`,
			);
	});
	return kept;
}

/**
 * @param {RawConfig} cfg
 * @returns {string[]|undefined}
 */
function readCorpus(cfg) {
	const corpus = readKey(cfg, "corpus", isStringArray, "an array of strings");
	if (corpus?.some((t) => !TRACKER_SHAPE.test(t))) {
		warnReadAsDefault(cfg, "corpus", "an array of owner/name trackers");
		return;
	}
	return corpus;
}

/** @param {RawConfig} cfg */
function checkKeyNames(cfg) {
	for (const key of Object.keys(cfg.raw))
		if (!KNOWN_KEYS.includes(key)) warnUnknownKey(cfg, key);
}

/**
 * @param {readonly string[]} modules
 * @param {SensitivePath[]|undefined} sensitivePaths
 */
function isHoldArmable(modules, sensitivePaths) {
	return (
		modules.includes("mutation") &&
		(sensitivePaths ?? []).some((entry) => entry.globs.length > 0)
	);
}

/**
 * @param {ConfigOpts & {quiet?: boolean}} [opts]
 * @returns {Config}
 */
function readConfig({ root = hostRoot(), rev, quiet = false } = {}) {
	let file = path.join(root, CONFIG_PATH);
	let raw;
	if (rev === undefined) raw = parseConfigFile(file);
	else {
		file = `${file} at ${rev}`;
		raw = parseConfigBlob(root, rev, file);
	}
	const contract = contractOf(raw, file);
	/** @type {RawConfig} */
	const cfg = { raw, warnings: [], faults: [] };
	const { warnings, faults } = cfg;
	checkKeyNames(cfg);

	const str = (/** @type {string} */ key) =>
		readKey(cfg, key, isString, "a string");
	const stringArray = (/** @type {string} */ key) =>
		readKey(cfg, key, isStringArray, "an array of strings");

	const commands = readCommands(cfg);
	const testCanary = readTestCanary(cfg);
	const deploy = readKey(
		cfg,
		"deploy",
		isDeploy,
		`one of ${DEPLOYS.join(", ")}`,
	);
	const modules = readModules(cfg);
	const categories =
		readKey(cfg, "categories", isStringRecord, "an object of strings") ?? {};
	const overrides = readOverrides(cfg);
	const capacityLadder = readKey(cfg, "capacityLadder", isBoolean, "a boolean");
	const admissionGate = readKey(cfg, "admissionGate", isBoolean, "a boolean");
	const refillLoop = readKey(cfg, "refillLoop", isBoolean, "a boolean") ?? true;
	const refillPanel =
		readKey(cfg, "refillPanel", isBoolean, "a boolean") ?? false;

	/** @type {Partial<Record<PathKey, string>>} */
	const paths = {};
	for (const key of PATH_KEY_NAMES)
		paths[key] = readKey(cfg, key, isRepoPath, "a repo-relative path");

	const manualRender = readManualRender(cfg);

	const roadmapMajorPin = readKey(cfg, "roadmapMajorPin", isNumber, "a number");

	const sessionMeanMb = readKey(
		cfg,
		"sessionMeanMb",
		isPositiveInt,
		"a positive integer",
	);
	const sessionSigmaMb = readKey(
		cfg,
		"sessionSigmaMb",
		isPositiveInt,
		"a positive integer",
	);
	const gateSeatMb = readKey(
		cfg,
		"gateSeatMb",
		isPositiveInt,
		"a positive integer",
	);
	const fullTestShards = readKey(
		cfg,
		"fullTestShards",
		isPositiveInt,
		"a positive integer",
	);
	const landingTester = readLandingTester(cfg);
	const ci = readKey(
		cfg,
		"ci",
		isCi,
		`an object of "runner" (one of ${CI_RUNNERS.join(", ")}) and an optional "timeoutMinutes" (a positive integer, at most ${SLIM_MAX_MINUTES} on ubuntu-slim)`,
	);
	const founderNotice = readKey(
		cfg,
		"founderNotice",
		isFounderNotice,
		'an object of "workflow", "repo" (owner/name, holding the holds\' issues) and "mention" (a login, no @)',
	);

	if (process.env.WFC_OUTPUT_STYLE !== undefined)
		overrides.output_style = process.env.WFC_OUTPUT_STYLE || null;

	const alwaysLoaded = readAlwaysLoaded(cfg);

	const retro = /** @type {{weeklyCount?: number}|undefined} */ (
		readSubObject(cfg, "retro", {
			weeklyCount: [isPositiveInt, "a positive integer"],
		})
	);
	const archScan =
		/** @type {{threshold?: number, exclude?: string[]}|undefined} */ (
			readSubObject(cfg, "archScan", {
				threshold: [isPositiveInt, "a positive integer"],
				exclude: [
					(v) =>
						Array.isArray(v) &&
						v.every((p) => typeof p === "string" && p !== ""),
					"an array of non-empty strings",
				],
			})
		);

	const sensitivePaths = readSensitivePaths(cfg);
	if (
		Array.isArray(raw.modules) &&
		raw.modules.includes("mutation") &&
		!isHoldArmable(raw.modules, sensitivePaths)
	)
		warnings.push(
			'module "mutation" is on but no "sensitivePaths" entry has a glob, so the mutation hold never fires',
		);
	const corpus = readCorpus(cfg);
	const founder = str("founder");
	const tracker = str("tracker");
	const codeRepo = str("codeRepo");
	const login = str("login");
	const name = str("name");
	const disabled = stringArray("disabled") ?? [];
	const ruffExclude = stringArray("ruffExclude");
	const pythonRoutes = readKey(
		cfg,
		"pythonRoutes",
		isPythonRoutes,
		`an object of globs to one of ${PYTHON_KINDS.join(", ")}`,
	);
	const suiteRunners = stringArray("suiteRunners");
	const worktreeLinks = readKey(
		cfg,
		"worktreeLinks",
		isRepoPathList,
		"an array of repo-relative paths",
	);
	const polled =
		readKey(cfg, "polled", isRepoPathList, "an array of repo-relative paths") ??
		[];
	readSubObject(cfg, "mods", MOD_SWITCHES);

	// #1530
	if (!quiet) for (const w of warnings) warnOnce(`WARN ${file}: ${w}`);

	return {
		file,
		contract,
		founder,
		tracker,
		codeRepo,
		login,
		name,
		corpus,
		commands,
		testCanary,
		deploy,
		modules,
		categories,
		disabled,
		overrides,
		capacityLadder,
		admissionGate,
		refillLoop,
		refillPanel,
		...paths,
		manualRender,
		roadmapMajorPin,
		ruffExclude,
		pythonRoutes,
		sessionMeanMb,
		sessionSigmaMb,
		gateSeatMb,
		fullTestShards,
		landingTester,
		ci,
		founderNotice,
		suiteRunners,
		worktreeLinks,
		polled,
		alwaysLoaded,
		retro,
		archScan,
		sensitivePaths,
		warnings,
		faults,
	};
}

/** @param {string} url */
function parseGithubRemote(url) {
	const m = url
		.trim()
		.match(
			/^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/,
		);
	return m ? `${m[1]}/${m[2]}` : undefined;
}

/** @param {string} spec */
function repoSlug(spec) {
	let r = spec.toLowerCase();
	const scheme = r.indexOf("://");
	if (scheme >= 0) r = r.slice(scheme + 3);
	if (r.startsWith("git@")) r = r.slice(4);
	if (r.startsWith("github.com:")) r = `github.com/${r.slice(11)}`;
	if (r.startsWith("github.com/")) r = r.slice(11);
	if (r.endsWith("/")) r = r.slice(0, -1);
	if (r.endsWith(".git")) r = r.slice(0, -4);
	return r;
}

/** @param {string} root */
function deriveTracker(root) {
	const url = orFallback(
		() =>
			execGit(["-C", root, "config", "--get", "remote.origin.url"], {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
			}),
		"",
	);
	return parseGithubRemote(url);
}

function deriveLogin() {
	const login = orFallback(
		() =>
			ghUnrouted(["api", "user", "--jq", ".login"], {
				timeout: 15_000,
			}).trim(),
		"",
	);
	return login || undefined;
}

/**
 * @param {"founder"|"tracker"|"codeRepo"|"login"|"name"|"corpus"} key
 * @param {ConfigOpts} [opts]
 * @returns {string|string[]|undefined}
 */
function resolveKey(key, { root = hostRoot(), rev } = {}) {
	const config = readConfig({ root, rev });
	switch (key) {
		case "tracker":
			return config.tracker ?? deriveTracker(root);
		case "codeRepo":
			return config.codeRepo ?? deriveTracker(root) ?? config.tracker;
		case "login":
			return config.login ?? deriveLogin();
		case "name":
			return config.name ?? path.basename(root);
		case "corpus":
			return resolveCorpus({ root, rev }).trackers;
		default:
			return config[key];
	}
}

/** @param {{root?: string}} [opts] */
const codeRepoUrl = ({ root } = {}) =>
	`https://github.com/${resolveKey("codeRepo", { root }) ?? UPSTREAM_CODE_REPO}.git`;

/**
 * @param {{root?: string}} [opts]
 * @returns {string[]}
 */
function codeRepoArgs({ root } = {}) {
	const repo = resolveKey("codeRepo", { root });
	return typeof repo === "string" && repo ? ["--repo", repo] : [];
}

/** @param {{root?: string}} [opts] */
function isCodeApartFromTracker({ root } = {}) {
	const code = resolveKey("codeRepo", { root });
	return Boolean(code) && code !== resolveKey("tracker", { root });
}

/**
 * @param {ConfigOpts & {quiet?: boolean}} [opts]
 * @returns {{trackers: string[], ownMissing: boolean}}
 */
function resolveCorpus({ root = hostRoot(), rev, quiet = false } = {}) {
	const config = readConfig({ root, rev, quiet });
	if (config.corpus) return { trackers: config.corpus, ownMissing: false };
	let own = config.tracker ?? deriveTracker(root);
	if (own !== undefined && !TRACKER_SHAPE.test(own)) own = undefined;
	return {
		trackers: [
			...new Set([own, UPSTREAM_TRACKER].filter((t) => t !== undefined)),
		],
		ownMissing: own === undefined,
	};
}

const HOW = {
	founder: "declare it — it is the one required key",
	tracker: "declare it, or give the host repo a GitHub origin remote",
	codeRepo:
		'declare it or "tracker", or give the host repo a GitHub origin remote',
	login: "declare it, or authenticate gh (`gh auth login`)",
	name: "declare it",
};

/**
 * @param {"founder"|"tracker"|"codeRepo"|"login"|"name"} key
 * @param {{root?: string}} [opts]
 * @returns {string}
 */
function requireKey(key, { root = hostRoot() } = {}) {
	const value = resolveKey(key, { root });
	if (typeof value !== "string") {
		throw new Error(
			`${path.join(root, CONFIG_PATH)} declares no "${key}" and none could be derived — ${HOW[key]}.`,
		);
	}
	return value;
}

/**
 * @param {PathKey} key
 * @returns {(opts?: {root?: string, say?: (line: string) => void}) => string}
 */
const pathResolver =
	(key) =>
	({ say, ...opts } = {}) => {
		const { fallback, what } = PATH_KEYS[key];
		try {
			const c = readConfig({ ...opts, quiet: true });
			for (const f of faultsOn(c, key))
				warnOnce(`WARN ${c.file}: ${buildWarningLine(f)}`, say);
			return c[key] ?? fallback;
		} catch (err) {
			warnOnce(
				`WARN ${caught(err).message} — ${what} is read at ${fallback}`,
				say,
			);
			return fallback;
		}
	};

const ladderPath = pathResolver("capacityLadderPath");
const cycleLogPath = pathResolver("cycleLogPath");
const brandSheetPath = pathResolver("brandSheetPath");
const userSettingsSnapshotPath = pathResolver("userSettingsSnapshotPath");
const pickNextRankingPath = pathResolver("pickNextRankingPath");

/** @param {{root?: string, quiet?: boolean}} [opts] */
function declaresLadder(opts = {}) {
	try {
		return readConfig(opts).capacityLadder === true;
	} catch {
		return false;
	}
}

/** @param {{root?: string, say?: (line: string) => void}} [opts] */
function readOutputStylePath({ say, ...opts } = {}) {
	try {
		const c = readConfig({ ...opts, quiet: true });
		for (const f of faultsOn(c, "overrides.output_style"))
			warnOnce(`WARN ${c.file}: ${buildWarningLine(f)}`, say);
		return c.overrides.output_style ?? OUTPUT_STYLE_DEFAULT;
	} catch (err) {
		warnOnce(
			`WARN ${caught(err).message} — the output style is read at ${OUTPUT_STYLE_DEFAULT}`,
			say,
		);
		return OUTPUT_STYLE_DEFAULT;
	}
}

/** @param {Module} module */
const buildModuleOffLine = (module) =>
	`module "${module}" is off — ${CONFIG_PATH} does not list it under "modules"`;

/** @param {Command} name */
const buildCommandUndeclaredLine = (name) =>
	`commands.${name} is undeclared in ${CONFIG_PATH}`;

/**
 * @param {Module} module
 * @param {ConfigOpts} [opts]
 */
function moduleOn(module, opts) {
	if (!MODULES.includes(module)) throw new Error(`no module "${module}"`);
	return readConfig(opts).modules.includes(module);
}

/**
 * @param {string} root
 * @param {(what: string, detail?: string) => void} log
 * @returns {(module: Module) => boolean}
 */
function moduleReader(root, log) {
	/** @type {Map<string, boolean>} */
	const seen = new Map();
	return (module) => {
		let on = seen.get(module);
		if (on === undefined) {
			try {
				on = moduleOn(module, { root });
			} catch (e) {
				on = false;
				log(
					`module ${module} read as off on a config fault`,
					caught(e).message,
				);
			}
			seen.set(module, on);
		}
		return on;
	};
}

/** @type {Module[]} */
const MANUAL_HALF = ["governance", "roadmap"];

/**
 * @param {ModuleGate} modules
 * @param {{root?: string}} [opts]
 * @returns {Module|null}
 */
function firstModuleOff(modules, opts) {
	return [modules].flat().find((m) => !moduleOn(m, opts)) ?? null;
}

/**
 * @param {string} basename
 * @param {{root?: string}} [opts]
 */
function guardDisabled(basename, opts) {
	try {
		return readConfig({ ...opts, quiet: true }).disabled.includes(basename);
	} catch {
		return false;
	}
}

/**
 * @param {string} root
 * @returns {{ disabled: (name: string) => boolean,
 *   moduleOn: (module: Module) => boolean }}
 */
function coreHost(root) {
	return {
		disabled: (name) => guardDisabled(name, { root }),
		moduleOn: moduleReader(root, () => undefined),
	};
}

/**
 * @param {Command} name
 * @param {ConfigOpts} [opts]
 * @returns {string|null}
 */
function readCommandFor(name, opts) {
	if (!COMMANDS.includes(name)) throw new Error(`no command "${name}"`);
	return readConfig(opts).commands[name];
}

/**
 * @param {Command} name
 * @param {Parameters<typeof readConfig>[0]} [opts]
 * @returns {string|null}
 */
function readDeclaredCommand(name, opts) {
	try {
		return readCommandFor(name, opts);
	} catch {
		return null;
	}
}

/**
 * @param {ModuleGate} modules
 * @param {{root?: string}} [opts]
 * @param {number} [offCode]
 */
function exitUnlessModule(modules, opts, offCode = 0) {
	let off;
	try {
		off = firstModuleOff(modules, opts);
	} catch (e) {
		writeFd(2, `BROKEN: ${caught(e).message}\n`);
		process.exit(2);
	}
	if (off) {
		writeFd(2, `SKIP: ${buildModuleOffLine(off)}\n`);
		process.exit(offCode);
	}
}

/**
 * @param {Config} c
 * @param {string} key
 * @param {{ under?: boolean }} [opts]
 */
const faultsOn = (c, key, { under = false } = {}) =>
	c.faults.filter(
		(f) => f.key === key || (under && f.key.startsWith(`${key}.`)),
	);

/**
 * @param {Config} c
 * @param {string} key
 * @param {ConfigFault["kind"][]} kinds
 */
function faultIn(c, key, kinds) {
	return (
		faultsOn(c, key, { under: true }).find((f) => kinds.includes(f.kind))
			?.text ?? null
	);
}

/** @param {Config} c */
const retroFault = (c) => faultIn(c, "retro", ["malformed", "unknown-key"]);

/** @param {Config} c */
const archScanFault = (c) => faultIn(c, "archScan", ["malformed"]);

/**
 * @param {(c: Config) => string | null} fault
 * @returns {Config}
 */
function readConfigOrBroken(fault) {
	let c;
	try {
		c = readConfig({ quiet: true });
	} catch (e) {
		writeFd(2, `BROKEN: ${caught(e).message}\n`);
		process.exit(2);
	}
	const why = fault(c);
	if (why) {
		writeFd(2, `BROKEN: ${c.file}: ${why}\n`);
		process.exit(2);
	}
	return c;
}

if (require.main === module) {
	const [verb, name, ...more] = process.argv.slice(2);
	if (verb === "module" && name) {
		const wanted = [name, ...more];
		const unknown = wanted.find(
			(m) => !MODULES.includes(/** @type {Module} */ (m)),
		);
		if (unknown) {
			writeFd(2, `BROKEN: no module "${unknown}"\n`);
			process.exit(2);
		}
		exitUnlessModule(/** @type {Module[]} */ (wanted), undefined, 1);
		process.exit(0);
	}
	if (verb === "manual-render" && !name) {
		const c = readConfigOrBroken((cfg) =>
			faultIn(cfg, "manualRender", ["malformed"]),
		);
		if (!c.manualRender) {
			writeFd(2, `SKIP: manualRender is undeclared in ${CONFIG_PATH}\n`);
			process.exit(1);
		}
		writeFd(
			1,
			`${[c.manualRender.command, ...c.manualRender.outputs].join("\n")}\n`,
		);
		process.exit(0);
	}
	if (verb === "pick-next-ranking" && !name) {
		const say = (/** @type {string} */ l) => writeFd(2, `${l}\n`);
		writeFd(1, `${pickNextRankingPath({ say })}\n`);
		process.exit(0);
	}
	if (verb === "corpus" && !name) {
		let trackers;
		try {
			const corpus = resolveCorpus();
			trackers = corpus.trackers;
			if (corpus.ownMissing) writeFd(2, `${OWN_MISSING_LINE}\n`);
		} catch (e) {
			writeFd(2, `BROKEN: ${caught(e).message}\n`);
			process.exit(2);
		}
		if (trackers.length === 0) {
			writeFd(2, `SKIP: "corpus" in ${CONFIG_PATH} resolves no tracker\n`);
			process.exit(1);
		}
		writeFd(1, `${trackers.join("\n")}\n`);
		process.exit(0);
	}
	if (verb === "retro-count" && !name) {
		const c = readConfigOrBroken(retroFault);
		if (!c.retro?.weeklyCount) {
			writeFd(
				2,
				`SKIP: retro.weeklyCount is unset in ${CONFIG_PATH}; run retro-sweep in calibrate mode first, whose result sets it\n`,
			);
			process.exit(1);
		}
		writeFd(1, `${c.retro.weeklyCount}\n`);
		process.exit(0);
	}
	if (verb !== "command" || !COMMANDS.includes(/** @type {Command} */ (name))) {
		writeFd(
			2,
			`usage: node workflow-core-config.js command <${COMMANDS.join("|")}> | module <${MODULES.join("|")}>... | manual-render | pick-next-ranking | corpus | retro-count\n`,
		);
		process.exit(2);
	}
	const command = /** @type {Command} */ (name);
	let declared;
	try {
		declared = readCommandFor(command);
	} catch (e) {
		writeFd(2, `BROKEN: ${caught(e).message}\n`);
		process.exit(2);
	}
	if (declared === null) {
		writeFd(2, `SKIP: ${buildCommandUndeclaredLine(command)}\n`);
		process.exit(1);
	}
	writeFd(1, `${declared}\n`);
}

module.exports = {
	coreHost,
	hostRoot,
	readConfig,
	wholeRunShardCount,
	resolveKey,
	resolveCorpus,
	requireKey,
	deriveTracker,
	moduleOn,
	isHoldArmable,
	moduleReader,
	firstModuleOff,
	MANUAL_HALF,
	readCommandFor,
	readDeclaredCommand,
	guardDisabled,
	ladderPath,
	declaresLadder,
	cycleLogPath,
	brandSheetPath,
	userSettingsSnapshotPath,
	pickNextRankingPath,
	readOutputStylePath,
	buildModuleOffLine,
	buildCommandUndeclaredLine,
	exitUnlessModule,
	CONFIG_PATH,
	hasConfig,
	PYTHON_KINDS,
	retroFault,
	faultsOn,
	archScanFault,
	buildWarningLine,
	CONTRACT,
	MIGRATIONS_DIR,
	MODULES,
	COMMANDS,
	DEPLOYS,
	unsetCommands,
	UPSTREAM_TRACKER,
	UPSTREAM_CODE_REPO,
	codeRepoUrl,
	codeRepoArgs,
	isCodeApartFromTracker,
	parseGithubRemote,
	repoSlug,
	TRACKER_SHAPE,
	USER_SETTINGS_SNAPSHOT_DEFAULT: PATH_KEYS.userSettingsSnapshotPath.fallback,
};
