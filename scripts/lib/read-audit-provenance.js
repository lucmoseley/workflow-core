/*
 * read-audit-provenance.js — what a child process the read audit sees
 * spawned is, decided once at the spawn (#5057): a stub a test wrote, a
 * program file of the checkout's own, the git guard, a real git, a Node
 * child keeping its own log, and whether it is a program measured to read
 * no variable or nothing at all, with the variables steering what it runs.
 * lib/read-audit-preload.js asks it for each spawn and logs the verdict on
 * the child's entry; lib/read-audit.js weighs that verdict and derives
 * none of it again.
 *
 * The preload loads it into every audited process, so it requires nothing
 * beside Node's own modules and what the preload loads already. Its root,
 * temporary directory and `realpath` are handed in: the preload's are the
 * ones it does not wrap.
 */

const path = require("node:path");
const { relativeUnder } = require("./is-under.js");
const { isNode, pairValue, repoPath } = require("./read-audit-paths.js");

/* The git guard the suites put on every test's `PATH` (#3161). */
const GUARD = path.join(__dirname, "host-git-guard", "git");

/* Programs that open no file a variable names (#4982): each traced with
 * `strace -f -e trace=%file` from outside the checkout, under `PWD`,
 * `OLDPWD`, `INIT_CWD`, `WFC_RULES_DIR` and `WFC_ALWAYS_LOADED` naming it,
 * to make no file call under the root but for its own file. One invocation
 * each (`tar` list, extract and create). What one runs by name it finds on
 * `PATH`: `tar`'s compressor, through `/bin/sh` on a create. So one passes
 * only where the variables it heeds for that (`STEERED_BY`) are as the
 * setup settled them, and no word asks it to run a command a test names
 * (`RUNS_A_COMMAND`). A pager runs only on a terminal, which a test's
 * process never holds: its output is a socket. Any program not named here
 * is doubted on such a variable. */
const ENV_BLIND = new Set([
	...["tar", "grep", "pgrep", "free", "dmesg"],
	...["systemctl", "curl", "ruff", "biome"],
]);

/* The variables a program of `ENV_BLIND` heeds to find what it runs by
 * name or with what options: `tar` its compressor on `PATH` and its options
 * off `TAR_OPTIONS`; `systemctl` its editor and ssh on `PATH`; `biome` the
 * node its `#!/usr/bin/env node` finds there (#4997). */
const STEERED_BY = new Map([
	["tar", ["PATH", "TAR_OPTIONS"]],
	["systemctl", ["PATH"]],
	["biome", ["PATH"]],
]);

/* Every variable steering which program a child runs by name, or with what
 * options. */
const STEERS = [...new Set([...STEERED_BY.values()].flat())];

/* The long options that have `tar` run a command a test names (tar(1)):
 * tar takes any unique prefix, so a prefix of one counts. Their short
 * spellings are `-I` and `-F`. */
const TAR_RUNS = [
	"--to-command",
	"--use-compress-program",
	"--checkpoint-action",
	"--info-script",
	"--new-volume-script",
	"--rsh-command",
	"--rmt-command",
];

/**
 * Whether a `tar` call's words may have it run a command a test names: a
 * long option above, or `I` or `F` in a cluster of short ones, the first
 * word's dashless cluster included.
 * @param {string[]} args
 */
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

/**
 * Whether systemctl's words ask it to edit, or to reach a host: `-H` in a
 * short-option cluster, its value glued on or not, or `--host` by any
 * prefix getopt takes for it.
 * @param {string[]} args
 */
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

/* The words that have a program of `ENV_BLIND` run a command a test can
 * name, by its manual: `tar`'s above; `systemctl edit`, which runs an
 * editor, and `-H`/`--host`, which runs ssh. */
const RUNS_A_COMMAND = new Map([
	["tar", isTarRunningCommand],
	["systemctl", isSystemctlRunningCommand],
]);

/* Programs that read nothing of the directory they run in, each traced with
 * `strace -e trace=file` to make no file call outside the system directories
 * and its own: under any arguments (null), or under the one argument named
 * (#4932). The traces ran under the suite's own environment, not under
 * each variable.
 * Not weighed: a relative LD_PRELOAD, LD_LIBRARY_PATH or LOCPATH in the
 * child's environment, which makes the loader probe that directory. */
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
 *   a child as spawned: its program's name, the file that name runs as
 *   found then with links followed (empty where none stands), its words
 *   after the program, its environment's pairs, whether it carries this
 *   audit on, and the environment the suite's setup settled
 * @typedef {{[K in (typeof FLAGS)[number]]: boolean}
 *   & {steered: string[]}} Provenance
 *   `stub` a program file under a temporary directory; `ours` one of the
 *   checkout's, outside every `node_modules`; `guard` the git guard's own
 *   file; `guarded` a bare `git` that file answers, carrying the audit, so
 *   it logs what it reads; `auditedNode` a Node child logging its own reads;
 *   `realGit` a git of neither the checkout nor a temporary directory;
 *   `readsNoVariable` one of `ENV_BLIND` as installed, unsteered and asked
 *   to run no command; `readsNothing` one of `BLIND` as installed, on the
 *   words it was measured on; `steered` each of `STEERS` set otherwise than
 *   settled
 */

/**
 * The verdict on a spawned child, for one checkout.
 * @param {{root: string, tmps: string[], realpath: (p: string) => string}} at
 *   the checkout's real path; each temporary directory a test may write a
 *   stub in, real paths: the suite's, and the spawning process's own where
 *   a test moved it; the `realpath` that finds the guard's
 * @returns {(child: Spawned) => Provenance}
 */
function buildVerdictOf({ root, tmps, realpath }) {
	/** @type {string|null} */
	let guardReal = null;
	try {
		guardReal = realpath(GUARD);
	} catch {
		// No guard stands beside this library, so no program is it (#4790).
	}
	const isUnderTmp = (/** @type {string} */ at) =>
		tmps.some((tmp) => relativeUnder(tmp, at) !== null);
	const isUnderRoot = (/** @type {string} */ at) =>
		relativeUnder(root, at) !== null;
	const isInRootModules = (/** @type {string} */ at) =>
		isUnderRoot(at) && repoPath(root, at) === null;

	/* "Is this the installed program?" has two answers, on purpose (#4790).
	 * A test can write any file
	 * under the checkout or a temporary directory, so neither holds an
	 * installed program; but a program the checkout's own `node_modules`
	 * holds was installed by its lockfile, and a variable it reads is no
	 * test's to hand it. */
	/** For `readsNoVariable`: none under a temporary directory, and none
	 * under the checkout but in its `node_modules`. */
	const isInstalledForVariables = (/** @type {string[]} */ bin) =>
		bin.length > 0 &&
		!bin.some(
			(at) => isUnderTmp(at) || (isUnderRoot(at) && !isInRootModules(at)),
		);
	/** For `readsNothing`: none under the checkout or a temporary directory,
	 * its `node_modules` included, nor a link to one there. */
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
 * Whether a logged verdict has the shape the judge may weigh.
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
