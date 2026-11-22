const path = require("node:path");
const { relativeUnder } = require("./is-under.js");
const { isNode, pairValue, repoPath } = require("./read-audit-paths.js");
const { orFallback } = require("./caught.js");

const GUARD = path.join(__dirname, "host-git-guard", "git");

const ENV_BLIND = new Set([
	...["tar", "grep", "pgrep", "free", "dmesg"],
	...["systemctl", "curl", "ruff", "biome"],
]);

const STEERED_BY = new Map([
	["tar", ["PATH", "TAR_OPTIONS"]],
	["systemctl", ["PATH"]],
	["biome", ["PATH"]],
]);

const STEERS = [...new Set([...STEERED_BY.values()].flat())];

const TAR_RUNS = [
	"--to-command",
	"--use-compress-program",
	"--checkpoint-action",
	"--info-script",
	"--new-volume-script",
	"--rsh-command",
	"--rmt-command",
];

/** @param {string[]} args */
function isTarRunningCommand(args) {
	return args.some((word, at) => {
		if (word.startsWith("--")) {
			const name = word.split("=")[0] ?? "";
			return name.length > 2 && TAR_RUNS.some((o) => o.startsWith(name));
		}
		const cluster = word.startsWith("-") || at === 0 ? word : "";
		return /[IF]/.test(cluster);
	});
}

/** @param {string[]} args */
function isSystemctlRunningCommand(args) {
	return args.some((a) => {
		if (a === "edit") return true;
		if (a.startsWith("--")) {
			const name = a.split("=")[0] ?? "";
			return name.length > 3 && "--host".startsWith(name);
		}
		return /^-[^-]*H/.test(a);
	});
}

const RUNS_A_COMMAND = new Map([
	["tar", isTarRunningCommand],
	["systemctl", isSystemctlRunningCommand],
]);

const BLIND = new Map([
	["sleep", null],
	["ps", null],
	["bash", "--version"],
	["gitleaks", "version"],
]);

const FLAGS = /** @type {const} */ ([
	"audited",
	"stub",
	"ours",
	"guard",
	"guarded",
	"auditedNode",
	"realGit",
	"readsNoVariable",
	"readsNothing",
]);

/**
 * @typedef {{file: string, bin: string[], args: string[], envPairs: unknown,
 *   audited: boolean, standing: Record<string, string|undefined>}} Spawned
 * @typedef {{[K in (typeof FLAGS)[number]]: boolean}
 *   & {steered: string[]}} Provenance
 */

/**
 * @param {{root: string, tmps: string[], realpath: (p: string) => string}} at
 * @returns {(child: Spawned) => Provenance}
 */
function buildVerdictOf({ root, tmps, realpath }) {
	/** @type {string|null} */
	const guardReal = orFallback(() => realpath(GUARD), null);
	const isUnderTmp = (/** @type {string} */ at) =>
		tmps.some((tmp) => relativeUnder(tmp, at) !== null);
	const isUnderRoot = (/** @type {string} */ at) =>
		relativeUnder(root, at) !== null;
	const isInRootModules = (/** @type {string} */ at) =>
		isUnderRoot(at) && repoPath(root, at) === null;

	const isInstalledForVariables = (/** @type {string[]} */ bin) =>
		bin.length > 0 &&
		!bin.some(
			(at) => isUnderTmp(at) || (isUnderRoot(at) && !isInRootModules(at)),
		);
	const isInstalledForNothing = (/** @type {string[]} */ bin) =>
		bin.length > 0 && !bin.some((at) => isUnderTmp(at) || isUnderRoot(at));

	return ({ file, bin, args, envPairs, audited, standing }) => {
		const name = path.basename(file);
		const stub = bin.some(isUnderTmp);
		const guard = bin[1] !== undefined && bin[1] === guardReal;
		const steered = STEERS.filter(
			(v) => pairValue(envPairs, v) !== standing[v],
		);
		const heeds = STEERED_BY.get(name) ?? [];
		return {
			audited,
			stub,
			ours: bin.some((at) => repoPath(root, at) !== null),
			guard,
			guarded: file === "git" && guard && audited,
			auditedNode: isNode(file) && audited,
			realGit:
				name === "git" && bin.length > 0 && !bin.some(isUnderRoot) && !stub,
			readsNoVariable:
				ENV_BLIND.has(name) &&
				isInstalledForVariables(bin) &&
				!steered.some((v) => heeds.includes(v)) &&
				!RUNS_A_COMMAND.get(name)?.(args),
			readsNothing:
				BLIND.has(name) &&
				isInstalledForNothing(bin) &&
				(BLIND.get(name) === null ||
					(args.length === 1 && args[0] === BLIND.get(name))),
			steered,
		};
	};
}

/**
 * @param {unknown} value
 * @returns {value is Provenance}
 */
function isProvenance(value) {
	if (value === null || typeof value !== "object") return false;
	const v = /** @type {Record<string, unknown>} */ (value);
	if (!FLAGS.every((f) => typeof v[f] === "boolean")) return false;
	const { steered } = v;
	return Array.isArray(steered) && steered.every((s) => typeof s === "string");
}

module.exports = { buildVerdictOf, GUARD, isProvenance };
