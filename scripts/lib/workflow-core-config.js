/*
 * workflow-core-config.js — the reader of the adopter config,
 * `.claude/workflow-core.json` at the host root (mantahostels#3516's contract;
 * #2).
 *
 * EVERY KEY HAS ITS DEFAULT, and `founder` is the only one required. Two are
 * DERIVED when undeclared, lazily and only through resolveKey/requireKey,
 * because each costs a fork: `tracker` from the origin remote at the host root,
 * `login` from the authenticated `gh` user. `corpus` follows `tracker`, and
 * `codeRepo` is the origin remote's, else `tracker`.
 *
 * AN UNKNOWN KEY WARNS, once per process per file, on stderr — a typo is
 * surfaced without breaking a hook. AN UNKNOWN `contract` INTEGER THROWS,
 * naming the migration notes: a stale config fails loudly rather than being
 * half-read. moduleReader alone reads that fault as off, logged: a guard's
 * module gate fails open rather than refusing every call (#2409).
 *
 * The shell half is scripts/lib/wfc-config.sh; change the two together.
 *
 * RUN AS A SCRIPT, `command <name>` is the POSIX-sh route for .husky/pre-commit,
 * where wfc-config.sh's bash cannot be sourced: exit 0 printing the declared
 * command, 1 with the SKIP line on stderr where it is undeclared, 2 on a config
 * that cannot be read. `module`, `manual-render`, `pick-next-ranking` and
 * `retro-count` are skills' routes, `corpus` a hook's, below.
 *
 * The host root is `CLAUDE_PROJECT_DIR`, else the git top level of the working
 * directory, symlinks dereferenced — never this file's own location, which in a
 * plugin install is the plugin cache (mantahostels#3515 F4).
 */

const fs = require("node:fs");
const path = require("node:path");
const { execGit } = require("./git.js");
const { readCommittedFile } = require("./git-objects.js");
/* Re-exported rather than merely used, because callers and this file's own
 * suite already import it from here. */
const { hostRoot } = require("./host-root.js");
const { caught } = require("./caught.js");
const { writeFd } = require("./write-fd.js");

/* POSIX-joined: it is a git path as well as a filesystem one. */
const CONFIG_PATH = path.posix.join(".claude", "workflow-core.json");

/** @param {string} root */
const hasConfig = (root) => fs.existsSync(path.join(root, CONFIG_PATH));

/** The contract integers this core reads. A removed or renamed key bumps it. */
const KNOWN_CONTRACTS = [1];
const CONTRACT = 1;

/** Where a release's migration notes live in the core, named for their tag. */
const MIGRATIONS_DIR = "migrations";

/**
 * The repo-relative path keys, each an adopter file read through pathResolver:
 * `fallback` where undeclared, `what` naming the file in its warning. A new key
 * is one row here plus its resolver and its export below (#467).
 */
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

/** The output style a hook's text points at where `overrides.output_style` is
 *  undeclared (#448). */
const OUTPUT_STYLE_DEFAULT = ".claude/output-styles/core-voice.md";

/** The core's own tracker — the upstream half of the default `corpus`. */
const UPSTREAM_TRACKER = "lucmoseley/workflow-core-tracker";
/** The core's code repo: where the plugin installs from and its tags live.
 *  Apart from UPSTREAM_TRACKER so the code can go public while its issues
 *  stay private (#1957). */
const UPSTREAM_CODE_REPO = "lucmoseley/workflow-core";

/* Guards the `corpus` verb's one-tracker-per-line print against an entry
 * that would split in two (#512) — only that: `../..` passes. */
const TRACKER_SHAPE = /^[\w.-]+\/[\w.-]+$/;
/* The `corpus` verb's stderr line where the default has lost the host's own
 * tracker. */
const OWN_MISSING_LINE = `WARN ${CONFIG_PATH}: no own tracker resolves, so "corpus" is ${UPSTREAM_TRACKER} alone — declare "corpus" or "tracker"`;

/* What a host deploys on a push to `main` (#742): the guard-push-rules core hands
 * the Vercel rule only where this names it. */
const DEPLOYS = /** @type {const} */ (["vercel"]);
const LANDING_TESTERS = /** @type {const} */ (["local", "actions"]);

const MODULES = /** @type {const} */ ([
	"roadmap",
	"governance",
	"suites",
	"site",
	/* The hold on a surviving mutant on a declared sensitive path (#1906). */
	"mutation",
	/* Sessions push to `landing` and the lander moves `main` (#2261). */
	"landing",
]);
const COMMANDS = /** @type {const} */ ([
	"test",
	"lint",
	"typecheck",
	/* The whole-repo formatter/linter pass, named in the push rule (#2018). */
	"check",
	"check_staged",
	/* Named in the push rule (#814); `defaultCommand` answers for it undeclared. */
	"push_check",
	/* Read only by release-plugin.js's --dry-run-adopter, which runs it against
	 * the rendered tree (#464). */
	"helper_check",
	/* The whole suite, where `test` narrows: read only by the lander's local
	 * tester, which runs `test` where it is undeclared (#2403). */
	"full_test",
]);
/* The base's code kinds a Python path can take; only `program` binds §N5. */
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
	...PATH_KEY_NAMES,
	"manualRender",
	"alwaysLoaded",
	"roadmapMajorPin",
	"ruffExclude",
	"pythonRoutes",
	"sessionMeanMb",
	"sessionSigmaMb",
	"fullTestShards",
	"landingTester",
	"suiteRunners",
	"worktreeLinks",
	/* Read off the raw file by the migration walker (`upgrade.js` and
	 * lib/walk-and-commit.js), never through this reader; listed so it raises
	 * no unknown-key warning. */
	"walkedTo",
	"retro",
	"archScan",
	"sensitivePaths",
	/* Read by the liveness mod itself at its session start, never through
	 * this reader (#944), which only warns on its shape. */
	"mods",
	/* Read and written through scripts/lib/steps-owed.js alone, never through
	 * this reader (#248). Listed here only so an unknown-key warning does not
	 * fire on it. */
	"stepsOwed",
];

/** @returns {Record<Command, string|null>} every command, undeclared */
const unsetCommands = () =>
	/** @type {Record<Command, string|null>} */ (
		Object.fromEntries(COMMANDS.map((c) => [c, null]))
	);

/** The core script under `scripts/` that `push_check` defaults to. */
const PUSH_CHECK_SCRIPT = "push-check.js";

/**
 * The command a rule names where the host declares none, by absolute path,
 * which runs in any host — so the push rule never loses its headline to an
 * undeclared command (#814).
 * @param {string} name
 * @returns {string|null}
 */
const defaultCommand = (name) =>
	name === "push_check"
		? `node ${path.join(__dirname, "..", PUSH_CHECK_SCRIPT)}`
		: null;

/** @typedef {typeof MODULES[number]} Module */
/** @typedef {Module|Module[]} ModuleGate one module, or several all required */
/** @typedef {typeof COMMANDS[number]} Command */
/** @typedef {typeof DEPLOYS[number]} Deploy */
/** @typedef {typeof LANDING_TESTERS[number]} LandingTester */
/** @typedef {typeof PYTHON_KINDS[number]} PythonKind */
/**
 * @typedef {object} ConfigOpts
 * @property {string} [root] the host root; hostRoot() where omitted
 * @property {string} [rev] read the config committed at this revision rather
 *   than the working copy's
 */

/**
 * @typedef {ConfigBase & Partial<Record<PathKey, string>>} Config each path
 * key declared only; its resolver defaults it
 */

/**
 * @typedef {object} ConfigBase
 * @property {string} file
 * @property {number} contract
 * @property {string} [founder]
 * @property {string} [tracker] declared only; resolveKey derives it
 * @property {string} [codeRepo] declared only; resolveKey derives it
 * @property {string} [login] declared only; resolveKey derives it
 * @property {string} [name]
 * @property {string[]} [corpus] declared only; resolveKey derives it
 * @property {Record<Command, string|null>} commands
 * @property {Deploy} [deploy]
 * @property {Module[]} modules
 * @property {Record<string, string>} categories
 * @property {string[]} disabled
 * @property {{skills: Record<string, string>, output_style: string|null}} overrides output_style is a repo-relative path (e.g. `.claude/output-styles/mine.md`), never a bare style name
 * @property {boolean} [capacityLadder] absent means no ladder: only `true` declares one (#735, #748); read it through declaresLadder()
 * @property {boolean} [admissionGate] whether check-context-budget.js refuses a pool rule its admission ledger does not admit; absent is off, only `true` switches it on (#2033)
 * @property {boolean} refillLoop whether away mode's refill loop serves this checkout; absent is in, only `false` takes it out (#1969, #2003)
 * @property {{command: string, outputs: string[]}} [manualRender] manual-sync's post-write step, absent by default (#451)
 * @property {number} [roadmapMajorPin]
 * @property {string[]} [ruffExclude] ruff glob patterns the pre-commit Python gate excludes (#122)
 * @property {Record<string, PythonKind>} [pythonRoutes] the host's Python route rows, pathspec glob → code kind, first match winning, ahead of base §0's default map in scripts/check-swallowed-errors.js (#1830)
 * @property {number} [sessionMeanMb] the mean of one of this host's working sessions' memory draw, its tools included (#2139)
 * @property {number} [sessionSigmaMb] that draw's standard deviation (#2139)
 * @property {LandingTester} [landingTester] which tester the lander runs: `local`, the suite in its own worktree (lib/local-tester.js), or `actions`, the suite workflow's push run on `landing` (lib/actions-tester.js); absent is `local` (#2413)
 * @property {number} [fullTestShards] how many `--shard=k/n` runs the lander's local tester splits `full_test` into, each in its own suite slot; absent runs it whole (#2996)
 * @property {string[]} [suiteRunners] scripts the suite guard counts and judges as suites (#330)
 * @property {string[]} [worktreeLinks] gitignored paths the suite reads, linked into each throwaway worktree a suite runs in (#1767)
 * @property {string[]} [alwaysLoaded] declared only; lib/always-loaded-pool.js defaults it
 * @property {{weeklyCount?: number}} [retro] how many sessions retro-sweep's weekly run reviews (#964); unset until the calibration batch sets it
 * @property {{threshold?: number, exclude?: string[]}} [archScan] the architecture-scan counter's threshold override and extra pathspec-glob exclusions (#1362); neither switches the scan on or off
 * @property {SensitivePath[]} [sensitivePaths] the areas a review escalates on (#1617); absent is undeclared, `[]` declared none; lib/sensitive-paths.js matches paths against it
 * @property {string[]} warnings
 * @property {ConfigFault[]} faults the warnings warnReadAsDefault() and
 *   warnUnknownKey() raise, each with its key — not a dropped glob, a nameless
 *   sensitive path, a repeated name or an unknown module, which only warn
 */

/**
 * A warning a reader selects by key and kind, never by its wording (#1744).
 * @typedef {object} ConfigFault
 * @property {string} key the dotted key path, such as `archScan.threshold`
 * @property {"malformed"|"unknown-key"} kind
 * @property {string} text what a refusal says: the warning less buildWarningLine()'s tail
 */

/**
 * @typedef {object} SensitivePath one declared area
 * @property {string} name
 * @property {string} description "" where undeclared or malformed
 * @property {string[]} globs pathspec globs; none means never matched mechanically
 * @property {string} focus
 * @property {string[]} examples
 * @property {boolean} live
 */

class ConfigContractError extends Error {}

/** @type {Set<string>} */
const warned = new Set();

/**
 * @param {string} line
 * @param {(line: string) => void} [say] where the line goes; stderr by default
 */
const warnOnce = (line, say = (l) => process.stderr.write(`${l}\n`)) => {
	if (warned.has(line)) return;
	warned.add(line);
	say(line);
};

/**
 * A non-empty relative path that does not climb out of the repo.
 * @param {unknown} v
 * @returns {v is string}
 */
const isRepoPath = (v) =>
	typeof v === "string" &&
	v !== "" &&
	!path.isAbsolute(v) &&
	!v.split(/[\\/]/).includes("..");

/** @param {unknown} v @returns {v is number} */
const isPositiveInt = (v) =>
	typeof v === "number" && Number.isInteger(v) && v > 0;

/** @param {unknown} v */
const isPlainObject = (v) =>
	typeof v === "object" && v !== null && !Array.isArray(v);

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
 * The adopter config's top-level object and the warnings and faults its key
 * readers collect. Each reader appends in readConfig's call order.
 * @typedef {object} RawConfig
 * @property {Record<string, unknown>} raw
 * @property {string[]} warnings
 * @property {ConfigFault[]} faults
 */

/**
 * @param {RawConfig} cfg accumulator: the warning is pushed onto `warnings`, its fault onto `faults`
 * @param {string} key
 * @param {string} want
 */
function warnReadAsDefault(cfg, key, want) {
	addFault(cfg, { key, kind: "malformed", text: `"${key}" is not ${want}` });
}

/**
 * @param {RawConfig} cfg accumulator: the warning is pushed onto `warnings`, its fault onto `faults`
 * @param {string} key
 */
function warnUnknownKey(cfg, key) {
	addFault(cfg, { key, kind: "unknown-key", text: `unknown key "${key}"` });
}

/**
 * @param {RawConfig} cfg accumulator: the fault's buildWarningLine() is pushed onto `warnings`, the fault onto `faults`
 * @param {ConfigFault} fault
 */
function addFault(cfg, fault) {
	cfg.warnings.push(buildWarningLine(fault));
	cfg.faults.push(fault);
}

/**
 * A fault as its warning reads: a malformed value's tail says a reader that
 * does not refuse goes on without it.
 * @param {ConfigFault} fault
 */
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
 * The config text's top-level object. Throws where it does not parse to one.
 * @param {string} text
 * @param {string} file the label a throw names
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
 * The config file's top-level object; empty where the file is absent.
 * Throws where the file exists but does not parse to an object.
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
 * The config's top-level object as committed at `rev` in `root`'s repository;
 * empty where that commit holds no config. Throws where `rev` names no commit
 * (an unborn HEAD included), where git cannot read the path or it holds no
 * file, or where the blob does not parse to an object.
 * @param {string} root
 * @param {string} rev
 * @param {string} file the label a throw names
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
 * A top-level key's declared value where it passes `isValid`; undefined where
 * the key is absent, and undefined with a warning where it fails.
 * @template T
 * @param {RawConfig} cfg accumulator: a malformed value's warning is pushed onto `warnings`, its fault onto `faults`; `raw` is read
 * @param {string} key
 * @param {(v: unknown) => v is T} isValid
 * @param {string} want what the warning says the value should be
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
 * @param {RawConfig} cfg accumulator: each warning is pushed onto `warnings`, a key fault onto `faults` too; `raw` is read
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
 * @param {RawConfig} cfg accumulator: each warning is pushed onto `warnings`, a key fault onto `faults` too; `raw` is read
 * @returns {Module[]}
 */
function readModules(cfg) {
	/** @type {Module[]} */
	const modules = [];
	/* WFC_MODULES, comma-separated, REPLACES the declared list — the suite's
	 * injection point (vitest.setup.ts). */
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
 * @param {Record<string, unknown>} obj the declared `overrides` object
 * @returns {string|null}
 */
function readOutputStyle(cfg, obj) {
	/* A path separator distinguishes a repo-relative path from a bare
	 * style name (#69). */
	if (typeof obj.output_style === "string") {
		if (/[\\/]/.test(obj.output_style) && isRepoPath(obj.output_style))
			return obj.output_style;
		warnReadAsDefault(cfg, "overrides.output_style", "a repo-relative path");
	} else if ("output_style" in obj && obj.output_style !== null)
		warnReadAsDefault(cfg, "overrides.output_style", "a string");
	return null;
}

/**
 * @param {RawConfig} cfg accumulator: each warning is pushed onto `warnings`, a key fault onto `faults` too; `raw` is read
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
 * Both halves or neither: a command whose outputs are unnamed cannot be
 * committed by pathspec, and outputs with no command are never written.
 * No newline in either, since the `manual-render` verb prints one per line.
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
	/* WFC_ALWAYS_LOADED, comma-separated, REPLACES the declared list — the
	 * suite's injection point, as WFC_MODULES is. */
	const injectedPool = process.env.WFC_ALWAYS_LOADED;
	const alwaysLoaded =
		injectedPool === undefined
			? readKey(cfg, "alwaysLoaded", isStringArray, "an array of strings")
			: injectedPool.split(",").filter(Boolean);
	/* Repo-relative, or the pool's `git cat-file <rev>:<path>` reads nothing and
	 * the cap silently under-counts. */
	if (alwaysLoaded?.some((p) => !isRepoPath(p))) {
		warnReadAsDefault(cfg, "alwaysLoaded", "an array of repo-relative paths");
		return;
	}
	return alwaysLoaded;
}

/**
 * An object key's declared sub-keys that pass their check; undefined where
 * the key is absent or not an object. A failing sub-key is read as unset
 * and warns, as does one `checks` does not name.
 * @param {RawConfig} cfg accumulator: each warning is pushed onto `warnings`, a key fault onto `faults` too; `raw` is read
 * @param {string} key
 * @param {Record<string, [(v: unknown) => boolean, string]>} checks
 *   each sub-key's test and what the warning says it should be
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

/**
 * Each mod `mods` may switch off. The liveness mod reads the key itself, in
 * its `isOnInConfig`, which this table must keep agreeing with.
 * @type {Record<string, [(v: unknown) => boolean, string]>}
 */
const MOD_SWITCHES = { "wfc-liveness": [isBoolean, "a boolean"] };

/** The review focus of an area that declares none (spec #1612). */
const DEFAULT_FOCUS = "access control and money logic";

/** @param {unknown} v @returns {v is string} */
const isNonEmptyString = (v) => typeof v === "string" && v !== "";

/**
 * The declared sensitive paths (#1617). An entry is dropped only where it has
 * no name to report it by; every other fault reads that field as its default
 * and keeps the entry, and a bad glob drops that glob alone — a typo costs
 * the warning, never the escalation the entry's other globs earn.
 * @param {RawConfig} cfg accumulator: each warning is pushed onto `warnings`, a key fault onto `faults` too; `raw` is read
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
 * One `sensitivePaths` entry read, or null where it has no name to report it by.
 * @param {RawConfig} cfg accumulator: each warning is pushed onto `warnings`, a key fault onto `faults` too
 * @param {Record<string, unknown>} entry unvalidated: any array element
 * @param {string} at the entry's key path, for warnings
 * @param {Set<unknown>} names accumulator: the names read so far, this one added
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
 * An entry's globs that are non-empty strings, warning on each one dropped.
 * @param {RawConfig} cfg accumulator: each warning is pushed onto `warnings`
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
 * @param {RawConfig} cfg accumulator: a malformed value's warning is pushed onto `warnings`, its fault onto `faults`; `raw` is read
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

/**
 * Warns on each unknown key.
 * @param {RawConfig} cfg
 */
function checkKeyNames(cfg) {
	for (const key of Object.keys(cfg.raw))
		if (!KNOWN_KEYS.includes(key)) warnUnknownKey(cfg, key);
}

/**
 * The config with every key at its declared value or its default: the
 * working copy's, or with `rev` the one committed at that revision of
 * `root`'s repository (#3132).
 * Throws where the file does not parse or declares an unknown contract.
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

	/** @type {Partial<Record<PathKey, string>>} */
	const paths = {};
	for (const key of PATH_KEY_NAMES)
		paths[key] = readKey(cfg, key, isRepoPath, "a repo-relative path");

	const manualRender = readManualRender(cfg);

	/* validate.js's own resolveExpectedMajor() reads and warns on this same
	 * key independently (#54) rather than calling readConfig() — readConfig
	 * throws on an unrelated contract/shape problem elsewhere in this file,
	 * which would take the roadmap validator down over a config fault that has
	 * nothing to do with the pin it is trying to read. */
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
	const fullTestShards = readKey(
		cfg,
		"fullTestShards",
		isPositiveInt,
		"a positive integer",
	);
	const landingTester = readKey(
		cfg,
		"landingTester",
		isLandingTester,
		`one of ${LANDING_TESTERS.join(", ")}`,
	);

	/* WFC_OUTPUT_STYLE REPLACES the declared value, the suite's injection point
	 * for `overrides.output_style` as WFC_ALWAYS_LOADED is for `alwaysLoaded`.
	 * Empty string is a declared-null override rather than "unset": a fixture
	 * asserting the undeclared case still needs a way to say so without leaving
	 * a sibling test's value in place. */
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
	/* A hold switched on that no commit can ever fire (#1911). The declared
	 * list, not `modules`: the suite injects its own through WFC_MODULES
	 * (vitest.setup.ts). */
	if (
		Array.isArray(raw.modules) &&
		raw.modules.includes("mutation") &&
		!(sensitivePaths ?? []).some((entry) => entry.globs.length > 0)
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
		(v) => Array.isArray(v) && v.every(isRepoPath),
		"an array of repo-relative paths",
	);
	readSubObject(cfg, "mods", MOD_SWITCHES);

	/* Last: a key read after this line warns into `warnings` but never reaches
	 * stderr (#1530). */
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
		deploy,
		modules,
		categories,
		disabled,
		overrides,
		capacityLadder,
		admissionGate,
		refillLoop,
		...paths,
		manualRender,
		roadmapMajorPin,
		ruffExclude,
		pythonRoutes,
		sessionMeanMb,
		sessionSigmaMb,
		fullTestShards,
		landingTester,
		suiteRunners,
		worktreeLinks,
		alwaysLoaded,
		retro,
		archScan,
		sensitivePaths,
		warnings,
		faults,
	};
}

/**
 * `owner/name` off a GitHub remote URL — https, scp-like SSH or ssh:// — or
 * undefined for anything else.
 * @param {string} url
 */
function parseGithubRemote(url) {
	const m = url
		.trim()
		.match(
			/^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/,
		);
	return m ? `${m[1]}/${m[2]}` : undefined;
}

/**
 * wfc_repo_slug: a repo as gh reads one — `owner/name`, `HOST/owner/name`, an
 * https or scp-like URL — lowercased to `owner/name`, a host other than
 * github.com kept as a prefix, so no caller mistakes it for a github.com repo.
 * @param {string} spec
 */
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

/**
 * The origin remote's `owner/name`; init-adopter.js points gh's default at it.
 * @param {string} root
 */
function deriveTracker(root) {
	let url = "";
	try {
		url = execGit(["-C", root, "config", "--get", "remote.origin.url"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		});
	} catch {
		// No origin remote: nothing to derive.
	}
	return parseGithubRemote(url);
}

function deriveLogin() {
	let login = "";
	try {
		// biome-ignore lint/suspicious/noImportCycles: required here, not at the top, as lib/gh.js requires this file.
		const { gh } = require("./gh.js");
		login = gh(["api", "user", "--jq", ".login"], {
			// A guess, never measured: one API round trip with room to spare.
			timeout: 15_000,
		}).trim();
	} catch {
		// gh missing, unauthenticated or offline: nothing to derive.
	}
	return login || undefined;
}

/**
 * A key's declared value, else its derived one, else undefined.
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

/**
 * The git URL the host's code clones from: its `codeRepo`, else the core's.
 * @param {{root?: string}} [opts]
 */
const codeRepoUrl = ({ root } = {}) =>
	`https://github.com/${resolveKey("codeRepo", { root }) ?? UPSTREAM_CODE_REPO}.git`;

/**
 * `--repo <codeRepo>` for a `gh run` or `gh workflow` call, where the runs
 * are; empty where no codeRepo resolves, leaving gh its default. gh's default
 * is the tracker (init-adopter.js), which holds no runs once the two differ
 * (#1963).
 * @param {{root?: string}} [opts]
 * @returns {string[]}
 */
function codeRepoArgs({ root } = {}) {
	const repo = resolveKey("codeRepo", { root });
	return typeof repo === "string" && repo ? ["--repo", repo] : [];
}

/**
 * Whether the host keeps its code in a repo apart from its tracker, so the
 * code repo may be public while the tracker is private (#1963).
 * @param {{root?: string}} [opts]
 */
function isCodeApartFromTracker({ root } = {}) {
	const code = resolveKey("codeRepo", { root });
	return Boolean(code) && code !== resolveKey("tracker", { root });
}

/**
 * The corpus, and whether it is the default with the host's own tracker
 * missing — where upstream alone would pass for the whole list (#514).
 * `quiet` keeps the config's warnings off stderr, for a hook reading it.
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
 * One key, declared or derived, or an Error naming the file and the key.
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
 * The resolver for one path key: its declared value, else its fallback — a
 * config that will not read included. A fallback other than an undeclared key
 * warns once per run (#406), to `say` where given (#410).
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

/**
 * Whether the host keeps a capacity ladder — only where it declares
 * `"capacityLadder": true` (#735, #748). What that leaves open: a non-boolean
 * value such as `"true"` reads as no ladder, warned of only where the caller
 * is not `quiet`.
 *
 * @param {{root?: string, quiet?: boolean}} [opts] passed to readConfig
 */
function declaresLadder(opts = {}) {
	try {
		return readConfig(opts).capacityLadder === true;
	} catch {
		/* FAILS OPEN to no ladder, as #735 ruled: an unreadable config declares
		 * nothing. Not silent where the caller also resolves ladderPath(), which
		 * prints that it does not parse (#406). */
		return false;
	}
}

/**
 * The output style's repo-relative path, for a hook's text to point at (#448):
 * the resolution always-loaded-pool.js reads, defaulted where undeclared and,
 * with a WARN, where rejected or unreadable — a hook has no reader to throw to.
 * scripts/lib/wfc-config.sh's `wfc_output_style` is the shell half.
 * @param {{root?: string, say?: (line: string) => void}} [opts]
 */
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

/**
 * The one-line reason a module-gated check skips.
 * @param {Module} module
 */
const buildModuleOffLine = (module) =>
	`module "${module}" is off — ${CONFIG_PATH} does not list it under "modules"`;

/**
 * The one-line reason a command-gated check skips.
 * @param {Command} name
 */
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
 * Whether a module is on, read once a reader's life; a config fault reads as off,
 * logged (#2409). The `{ moduleOn }` every Node core and lib/rule-gates.js
 * reads.
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

/**
 * The manual half of governance, which is roadmap-coupled and so needs both
 * modules on (#395 Q2).
 * @type {Module[]}
 */
const MANUAL_HALF = ["governance", "roadmap"];

/**
 * The first of `modules` the host does not list, or null where every one is
 * on — so a check needing two modules names the one that is off (#418).
 * @param {ModuleGate} modules
 * @param {{root?: string}} [opts]
 * @returns {Module|null}
 */
function firstModuleOff(modules, opts) {
	return [modules].flat().find((m) => !moduleOn(m, opts)) ?? null;
}

/**
 * Whether the guard file named <basename> is listed under "disabled" (#2). A
 * config that will not read answers false.
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
 * The host `root`'s config makes for a dispatcher core: the cores it disables
 * and the modules it switches on, `lib/guard-cores.js` `runsOn`'s `host`. A
 * config fault reads a module as off, as the dispatcher does; the
 * dispatcher's own entry logs it.
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
 * The host's declared command, else `defaultCommand`'s, else null — for a
 * message that names it (#814). A config that will not read declares nothing.
 * @param {Command} name
 * @param {Parameters<typeof readConfig>[0]} [opts]
 * @returns {string|null}
 */
function readCommandOrDefault(name, opts) {
	try {
		const declared = readCommandFor(name, opts);
		if (declared) return declared;
	} catch {
		/* an unknown name throws too: both fall to the default */
	}
	return defaultCommand(name);
}

/**
 * For a script outside lib/check.js's runCheck: exit 0 with `SKIP: <why>` on
 * stderr — the checker family's SKIP line (mantahostels#155) — when `module` is
 * off — the first that is off, where it needs several; exit 2 naming the
 * fault when the config cannot be read.
 * @param {ModuleGate} modules
 * @param {{root?: string}} [opts]
 * @param {number} [offCode] the exit code for a module that is off
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
 * The faults on `key`, and with `under` on any key beneath it: the one way a
 * reader picks a fault (#1744). Exact by default, since an unknown top-level
 * key may itself hold a dot (`"ruffExclude.x"`).
 * @param {Config} c
 * @param {string} key
 * @param {{ under?: boolean }} [opts]
 */
const faultsOn = (c, key, { under = false } = {}) =>
	c.faults.filter(
		(f) => f.key === key || (under && f.key.startsWith(`${key}.`)),
	);

/**
 * The text of the first fault of a kind in `kinds` on `key` or a key under
 * it; null where none.
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

/**
 * The fault on a malformed or misspelt `retro` key, which readConfig reads as
 * unset — retro-count and report-retro-due.js both refuse on it.
 * @param {Config} c
 */
const retroFault = (c) => faultIn(c, "retro", ["malformed", "unknown-key"]);

/**
 * The fault on a malformed `archScan` value, which readConfig reads as unset
 * — the architecture-scan counter refuses on it. An unknown sub-key only
 * warns (#1362), so it is not selected here.
 * @param {Config} c
 */
const archScanFault = (c) => faultIn(c, "archScan", ["malformed"]);

/**
 * The config for a verb that refuses rather than defaults: BROKEN and exit 2
 * on a config that will not read, or where `fault` returns a fault's text.
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
	/* `module <name>...` is a skill's gate (manual-sync): silent exit 0 where
	 * every module is on, the SKIP line and exit 1 where one is off — 1, not
	 * the family's 0, because a skill branches on the code and 0 reads as go
	 * (#418). */
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
	/* `manual-render` is manual-sync's post-write step (#451): the command on
	 * line 1 and each output on its own line after, exit 0; the SKIP line and
	 * exit 1 where undeclared; BROKEN and exit 2 where it is declared but
	 * malformed, so a typo never passes for "no step". */
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
	/* `pick-next-ranking` is pick-next §4's read (#455): the path on stdout and
	 * exit 0 always — a rejected value or an unreadable config warns on stderr
	 * and prints the default, as the path keys' readers do. So a mistyped value
	 * reads the default file's rules, none where it is absent, seen only in
	 * that warning. */
	if (verb === "pick-next-ranking" && !name) {
		const say = (/** @type {string} */ l) => writeFd(2, `${l}\n`);
		writeFd(1, `${pickNextRankingPath({ say })}\n`);
		process.exit(0);
	}
	/* `corpus` is retro-sweep's tracker list (#512): resolveKey's
	 * trackers one per line, exit 0; the SKIP line and exit 1 where none
	 * resolves, so the caller names the key instead; BROKEN and exit 2 on a
	 * config that will not read. A rejected value warns and reads as the
	 * default. */
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
	/* `retro-count` is retro-sweep's weekly gate (#964): N on stdout, exit 0;
	 * the SKIP line naming calibration and exit 1 where unset; BROKEN and exit
	 * 2 where declared but malformed or misspelt, so a typo never reads as
	 * "not yet calibrated". */
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
	resolveKey,
	resolveCorpus,
	requireKey,
	deriveTracker,
	moduleOn,
	moduleReader,
	firstModuleOff,
	MANUAL_HALF,
	readCommandFor,
	defaultCommand,
	readCommandOrDefault,
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
	/* For workflow-core-config.test.ts's key-list parity test alone (#1534). */
	KNOWN_KEYS,
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
