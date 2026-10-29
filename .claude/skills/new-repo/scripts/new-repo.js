#!/usr/bin/env node
/*
 * new-repo.js — takes a new project from nothing to a pushed, adopted private
 * repo holding its first wayfinder map, in one call (#713, the /new-repo spec;
 * #718 built its empty-repo flow).
 *
 * DATA ARGUMENTS ONLY, and the free text (the idea, the Project one-liner, the
 * map title) arrives as file paths, so the skill's call stays the single plain
 * line workflow-core's one allow rule matches (#699).
 *
 * EVERY CHECK RUNS BEFORE THE FIRST OUTWARD ACT, so a run that will fail
 * creates nothing (#706 Q4); `--dry-run` runs them all, prints each planned
 * step and leaves nothing written — its scratch clones removed after it. After that each step reads the real world and keeps
 * no journal (#706 Q1): what is already there is reported `skipped — already
 * done`. The dry run runs the same steps under a `dry` flag, so each skip
 * rule lives once, in its step (#733, #762).
 * Nothing this creates is ever deleted — repo, issue, branch, remote or file —
 * save a `~/.bashrc` write, undone from its backup when it breaks the file's
 * syntax (#706 Q3).
 *
 * NO HOOK SEES A gh CALL A SCRIPT MAKES, so the first map and the reconcile
 * ticket are filed through file-issue.js, which puts the `takes:` label on
 * each and runs the issue gate itself (#699).
 *
 * EVERY CHILD RUNS WITH CLAUDE_PROJECT_DIR SET TO THE NEW CLONE: the calling
 * session's own points at workflow-core, and hostRoot() would read it first —
 * filing the map, and judging the skeleton commit, against the wrong repo.
 *
 * `--resume <name>` finishes a run that stopped part-way from the inputs saved
 * in `~/<name>/.git/new-repo.json` (#720). Any argument given beside it, or a
 * full re-run over a clone that saved inputs, must match them: a map title or
 * prefix changing half-way is refused, naming the difference. A run that
 * stopped before the clone existed saved nothing, so its re-run is the full
 * form.
 *
 * `--source <owner/name>` makes the new repo a private mirror of a source repo
 * (#721, #694): its default branch as `main` and its tags, never a fork; the
 * source kept as a fetch-only `upstream`; init's files kept trackable past
 * its `.gitignore`; each module whose subject the copy tracks switched on, by
 * the predicate the core's commit gate refuses on (#1506). Until
 * the clone holds the copy, preflight judges the source repo in a scratch
 * clone, removed after. The source repo's
 * `CLAUDE.md` and `AGENTS.md` are set aside where no session loads them, its
 * `pre-commit` kept as the core's local hook, its documents registered in §A,
 * and a ticket under the first map brings back what is worth keeping (#722).
 *
 * `--no-plugin-install` is passed through to init-adopter.js, for a machine
 * with no `claude` on PATH.
 *
 * Joins no §N3 family, and prints its report on stdout, where §N6 puts human
 * text on stderr: its reader is the /new-repo skill, reading one Bash call.
 * Exits 0 finished / 1 stopped, a plain re-run should finish it / 2 refused
 * until the founder acts by hand (#706 Q5).
 */

const { spawnSync } = require("node:child_process");
const { execGit, spawnGitSync } = require("../../../../scripts/lib/git.js");
const fs = require("node:fs");
const { writeFd } = require("../../../../scripts/lib/write-fd.js");
const { GIT_MODE } = require("../../../../scripts/lib/git-mode.js");
const os = require("node:os");
const path = require("node:path");
const {
	HOOKS,
	appendLines,
	renderHookShim,
} = require("../../../../scripts/lib/adopter-skeleton.js");
const {
	skeletonPaths,
} = require("../../../../scripts/lib/core-owned-files.js");
const {
	isCoreRoot,
	selfPluginSetup,
} = require("../../../../scripts/lib/core-hooks.js");
const {
	coverageMatchers,
	inScope,
} = require("../../../../scripts/lib/doc-map.js");
const {
	parseErrLine,
	gh,
	ghApiSlurp,
	ghJson,
} = require("../../../../scripts/lib/gh.js");
const { ISSUE_LIST_LIMIT } = require("../../../../scripts/lib/gh-limits.js");
const {
	initPaths,
	readManifestMarketplaceName,
} = require("../../../../scripts/init-adopter.js");
const { installPathFor } = require("../../../../scripts/lib/plugin-state.js");
const { requiredGroup } = require("../../../../scripts/lib/regex-group.js");
const { inferCommands } = require("../../../../scripts/lib/infer-commands.js");
const {
	readSubjectModules,
} = require("../../../../scripts/lib/gate-subjects.js");
const {
	UNFILLED_DESTINATION,
} = require("../../../../scripts/lib/issue-gate.js");
const { shellQuote } = require("../../../../scripts/lib/sh-quote.js");
const { newestTag } = require("../../../../scripts/lib/release-tags.js");
const {
	TRACKER_SHAPE,
	UPSTREAM_CODE_REPO,
} = require("../../../../scripts/lib/workflow-core-config.js");

const CORE = path.resolve(__dirname, "../../../..");
const SELF = ".claude/skills/new-repo/scripts/new-repo.js";
/** The founder's GitHub account, where every new repo is made (#713). */
const OWNER = "lucmoseley";
const RECORD = "new-repo.json";
const MAP_LABEL = "wayfinder:map";
const MAP_LABELS = [MAP_LABEL, "takes:wayfinder"];
const SKIPPED = "skipped — already done";
/** What init writes; `roadmap`, the one module adding paths, is never on here. */
const INIT_PATHS = initPaths([]);
/**
 * The source repo's files set aside before init writes the core's own under
 * their names (#694 item 6): no session auto-loads a `.source.md` under
 * `docs/`, and the core's `pre-commit` sources `pre-commit.local`.
 */
const ASIDE = [
	{ from: "CLAUDE.md", to: "docs/source/CLAUDE.source.md", instructions: true },
	{ from: "AGENTS.md", to: "docs/source/AGENTS.source.md", instructions: true },
	{
		from: ".husky/pre-commit",
		to: ".husky/pre-commit.local",
		instructions: false,
	},
];
/** A grilling child of the map, for the first session to take (#713 §The first map). */
const RECONCILE_LABEL = "wayfinder:grilling";
const RECONCILE_LABELS = [RECONCILE_LABEL, "takes:wayfinder"];

const VALUE_FLAGS = {
	"--name": "name",
	"--prefix": "prefix",
	"--idea-file": "ideaFile",
	"--one-liner-file": "oneLinerFile",
	"--title-file": "titleFile",
	"--corpus": "corpus",
	"--spec-url": "specUrl",
	"--source": "source",
	"--resume": "resume",
};
const BOOL_FLAGS = {
	"--dry-run": "dryRun",
	"--no-plugin-install": "noInstall",
};
/** The flag each saved input came from, to name a difference by. */
const INPUT_FLAGS = {
	name: "--name",
	prefix: "--prefix",
	idea: "--idea-file",
	oneLiner: "--one-liner-file",
	title: "--title-file",
	corpus: "--corpus",
	specUrl: "--spec-url",
	source: "--source",
};

const USAGE = `usage: node ${SELF} --name <repo> --prefix <p> --idea-file F --one-liner-file F --title-file F [--corpus <owner/name>[,…]] [--spec-url <url>] [--source <owner/name>] [--no-plugin-install] [--dry-run]
       node ${SELF} --resume <repo> [--no-plugin-install] [--dry-run]`;

/** What stops the run: the exit code, the reason, and what the founder does. */
class Stop extends Error {
	/**
	 * `fresh`: no re-run of these inputs can finish, so the founder starts
	 * again from /new-repo. Shaped like Error's own constructor, so Biome's
	 * useErrorCause finds `cause` where it looks.
	 * @param {string} reason
	 * @param {{code: 1|2, manual?: string, output?: string, fresh?: boolean, cause?: unknown}} more
	 */
	constructor(reason, { code, manual, output, fresh = false, cause }) {
		super(reason, { cause });
		this.code = code;
		this.manual = manual;
		this.output = output;
		this.fresh = fresh;
	}
}

/** @param {string} line */
const out = (line) => {
	writeFd(1, `${line}\n`);
};

/**
 * @param {string} step
 * @param {string} status
 * @param {string} [detail]
 */
const report = (step, status, detail) => {
	out(`${step.padEnd(14)} ${status}${detail ? ` — ${detail}` : ""}`);
};

/**
 * @typedef {{name: string, repo: string, prefix: string, idea: string,
 *   oneLiner: string, title: string, corpus: string[], specUrl: string|null,
 *   source: string|null}}
 *   Inputs
 */

/**
 * What every step after preflight works from: the inputs, the clone, the
 * environment its children run under, whether this is a dry run, and whether
 * it installs the plugin.
 * @typedef {{inp: Inputs, clone: string, env: NodeJS.ProcessEnv, dry: boolean,
 *   noInstall: boolean}} Step
 */

const NAME_SHAPE = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;

/**
 * `given` holds every input under the full form; under `--resume`, only those
 * named beside it, each to be checked against the saved one.
 * @param {string[]} argv
 * @returns {{resume: string|null, given: Partial<Inputs>, dryRun: boolean, noInstall: boolean}}
 */
function parse(argv) {
	const { v, b } = readFlags(argv);
	const resume = v.resume ?? null;
	checkRequired(v, resume);
	checkShapes(v, resume);
	return {
		resume,
		given: readGivenInputs(v, resume),
		dryRun: Boolean(b.dryRun),
		noInstall: Boolean(b.noInstall),
	};
}

/**
 * argv's value flags and boolean flags, each keyed by its field name.
 * @param {string[]} argv
 */
function readFlags(argv) {
	/** @type {Record<string, string>} */
	const v = {};
	/** @type {Record<string, boolean>} */
	const b = {};
	const args = argv[Symbol.iterator]();
	for (const flag of args) {
		if (flag in BOOL_FLAGS) {
			b[BOOL_FLAGS[/** @type {keyof typeof BOOL_FLAGS} */ (flag)]] = true;
			continue;
		}
		if (!(flag in VALUE_FLAGS)) throw new Error(`unknown argument "${flag}"`);
		const { value } = args.next();
		if (value === undefined || value.startsWith("--"))
			throw new Error(`${flag} wants a value`);
		v[VALUE_FLAGS[/** @type {keyof typeof VALUE_FLAGS} */ (flag)]] = value;
	}
	return { v, b };
}

/**
 * @param {Record<string, string>} v
 * @param {string|null} resume
 */
function checkRequired(v, resume) {
	if (resume === null)
		for (const flag of [
			"--name",
			"--prefix",
			"--idea-file",
			"--one-liner-file",
			"--title-file",
		]) {
			if (!v[VALUE_FLAGS[/** @type {keyof typeof VALUE_FLAGS} */ (flag)]])
				throw new Error(`${flag} is required`);
		}
}

/**
 * @param {Record<string, string>} v
 * @param {string|null} resume
 */
function checkShapes(v, resume) {
	for (const [flag, value] of [
		["--resume", resume],
		["--name", v.name],
	])
		if (value != null && !NAME_SHAPE.test(value))
			throw new Error(`${flag} "${value}" is not a GitHub repo name`);
	if (v.prefix !== undefined && !/^[a-z][a-z0-9]*$/.test(v.prefix))
		throw new Error(
			`--prefix "${v.prefix}" wants lower-case letters and digits, starting with a letter`,
		);
	if (v.corpus !== undefined) {
		const bad = v.corpus.split(",").filter((t) => t && !TRACKER_SHAPE.test(t));
		if (bad.length > 0)
			throw new Error(
				`--corpus wants owner/name trackers, got ${bad.join(", ")}`,
			);
	}
	if (v.source !== undefined && !TRACKER_SHAPE.test(v.source))
		throw new Error(`--source "${v.source}" is not an owner/name repo`);
	if (v.specUrl !== undefined && !/^https?:\/\/\S+$/.test(v.specUrl))
		throw new Error(`--spec-url "${v.specUrl}" is not a URL`);
}

/** @param {string} file */
const readNonEmptyText = (file) => {
	const t = fs.readFileSync(file, "utf8").trim();
	if (!t) throw new Error(`${file} is empty`);
	return t;
};

/**
 * @param {Record<string, string>} v
 * @param {string|null} resume
 * @returns {Partial<Inputs>}
 */
function readGivenInputs(v, resume) {
	/** @type {Partial<Inputs>} */
	const given = {};
	/* A clone renamed by hand saved another name: refused as a difference. */
	const name = v.name ?? resume;
	if (name != null) given.name = name;
	if (v.prefix !== undefined) given.prefix = v.prefix;
	if (v.ideaFile !== undefined) given.idea = readNonEmptyText(v.ideaFile);
	if (v.oneLinerFile !== undefined)
		given.oneLiner = readNonEmptyText(v.oneLinerFile).replace(/\.$/, "");
	if (v.titleFile !== undefined) given.title = readNonEmptyText(v.titleFile);
	return { ...given, ...optionalInputs(v, resume) };
}

/**
 * The inputs the full form always sets, defaulted, and `--resume` sets only
 * where named, in this order.
 * @param {Record<string, string>} v
 * @param {string|null} resume
 * @returns {Partial<Inputs>}
 */
function optionalInputs(v, resume) {
	/** @type {Partial<Inputs>} */
	const given = {};
	if (v.corpus !== undefined || resume === null)
		given.corpus = (v.corpus ?? "").split(",").filter(Boolean);
	if (v.specUrl !== undefined || resume === null)
		given.specUrl = v.specUrl ?? null;
	if (v.source !== undefined || resume === null)
		given.source = v.source ?? null;
	if (resume === null) given.repo = `${OWNER}/${v.name}`;
	return given;
}

/** @param {string} clone */
const recordPath = (clone) => path.join(clone, ".git", RECORD);

/**
 * The inputs saved in a clone, or null where there are none to read. An
 * unparseable record reads as none: preflight then refuses the clone as not
 * this script's, and `--resume` refuses it as nothing to resume.
 * @param {string} clone
 * @returns {Partial<Inputs>|null}
 */
function readSavedInputs(clone) {
	try {
		return JSON.parse(fs.readFileSync(recordPath(clone), "utf8"));
	} catch {
		return null;
	}
}

/**
 * The inputs this run works from: the given ones under the full form, the
 * saved ones under `--resume`. Either way a given input differing from a saved
 * one is refused, since the first map and the aliases may already carry it.
 * @param {string|null} resume
 * @param {Partial<Inputs>} given
 * @param {string} name
 * @param {Partial<Inputs>|null} saved
 * @returns {Inputs}
 */
function resolveInputs(resume, given, name, saved) {
	const record = `~/${name}/.git/${RECORD}`;
	if (
		resume !== null &&
		!(saved?.repo && Object.keys(INPUT_FLAGS).every((k) => k in saved))
	)
		throw new Stop(
			`there is nothing to resume: ${record} is missing or incomplete`,
			{
				code: 2,
				manual:
					"a run that stopped before its clone existed saved nothing — start it again with every argument",
				fresh: true,
			},
		);
	const show = (/** @type {unknown} */ x) => {
		if (x === null) return "none";
		if (Array.isArray(x)) return `"${x.join(",")}"`;
		return `"${x}"`;
	};
	const differ = /** @type {(keyof typeof INPUT_FLAGS)[]} */ (
		Object.keys(INPUT_FLAGS)
	)
		.filter(
			(k) =>
				saved &&
				k in given &&
				k in saved &&
				JSON.stringify(given[k]) !== JSON.stringify(saved[k]),
		)
		.map((k) =>
			// The idea runs to paragraphs, too long to quote in a report line.
			k === "idea"
				? `${INPUT_FLAGS[k]}'s text differs from the saved idea`
				: `${k === "name" && resume !== null ? "--resume" : INPUT_FLAGS[k]} gives ${show(given[k])} where ${show(saved?.[k])} was saved`,
		);
	if (differ.length > 0)
		throw new Stop(
			`the arguments differ from those ${record} saved: ${differ.join("; ")}`,
			{
				code: 2,
				manual: `drop the differing arguments — \`--resume ${name}\` alone reuses every saved one`,
			},
		);
	return /** @type {Inputs} */ (resume === null ? given : saved);
}

/**
 * @param {string} cwd
 * @param {string[]} args
 * @param {Buffer} [input]
 */
const git = (cwd, args, input) =>
	execGit(args, {
		cwd,
		encoding: "utf8",
		input,
		stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
	}).trim();

/**
 * The ref's sha, or null where it is absent — an empty origin's `main` — or
 * where `cwd` is no repo yet: a clone not made.
 * @param {string} cwd
 * @param {string} ref
 */
const revParse = (cwd, ref) => {
	try {
		return git(cwd, ["rev-parse", "--verify", "-q", ref]);
	} catch {
		return null;
	}
};

/**
 * @param {string} cwd
 * @param {string} a
 * @param {string} b
 */
const isAncestor = (cwd, a, b) =>
	spawnGitSync(["merge-base", "--is-ancestor", a, b], { cwd }).status === 0;

/**
 * A child whose output is reported rather than thrown.
 * @param {string} cwd
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} env
 * @param {number} [timeout]
 */
const runChild = (cwd, args, env, timeout) => {
	const [command, ...rest] = args;
	if (command === undefined) throw new Error("runChild was given no command");
	return reported(
		spawnSync(command, rest, { cwd, encoding: "utf8", env, timeout }),
	);
};

/**
 * runChild for git, through the seam.
 * @param {string} cwd
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} env
 */
const runGit = (cwd, args, env) =>
	reported(spawnGitSync(args, { cwd, encoding: "utf8", env }));

/** @param {import("node:child_process").SpawnSyncReturns<string>} r */
const reported = (r) => ({
	status: r.status ?? 1,
	output: `${r.stdout ?? ""}${r.stderr ?? ""}${r.error ? String(r.error) : ""}`,
});

/** The newest release tag upstream, the one the core is pinned to. */
function readReleaseTag() {
	let tag;
	try {
		tag = newestTag(
			ghApiSlurp([`repos/${UPSTREAM_CODE_REPO}/tags`]).map((t) => t.name),
		);
	} catch (e) {
		throw new Stop(
			`could not read ${UPSTREAM_CODE_REPO}'s tags (${parseErrLine(e)})`,
			{
				code: 1,
				cause: e,
			},
		);
	}
	/* Never a directory fallback: a directory source cannot upgrade itself
	 * (#693). */
	if (!tag)
		throw new Stop(
			`${UPSTREAM_CODE_REPO} has no vX.Y.Z release tag on GitHub, and the core is only ever pinned to one`,
			{ code: 2, manual: "cut a workflow-core release first" },
		);
	return tag;
}

/**
 * The repo's GitHub view, or null where GitHub has no such repo.
 * @param {Inputs} inp
 */
function repoView(inp) {
	let view = null;
	try {
		view = ghJson([
			"repo",
			"view",
			inp.repo,
			"--json",
			"isEmpty,isPrivate,owner",
		]);
	} catch (e) {
		if (!/Could not resolve to a Repository/.test(parseErrLine(e)))
			throw new Stop(`could not read ${inp.repo} (${parseErrLine(e)})`, {
				code: 1,
				cause: e,
			});
	}
	return view;
}

/** git's global user.name, recorded as the founder; refused where unset. */
function readFounderName() {
	let founder;
	try {
		founder = git(os.homedir(), ["config", "--get", "user.name"]);
	} catch {
		founder = "";
	}
	if (!founder)
		throw new Stop("git has no user.name to record as the founder", {
			code: 2,
			manual: 'run `git config --global user.name "<your name>"`',
		});
	return founder;
}

/**
 * @param {Inputs} inp
 * @param {string} clone
 */
function preflight(inp, clone) {
	try {
		gh(["auth", "status"]);
	} catch (e) {
		throw new Stop(`gh is not logged in (${parseErrLine(e)})`, {
			code: 2,
			cause: e,
			manual: "log gh in: run `gh auth login` in a terminal",
		});
	}
	const tag = readReleaseTag();
	const cloneOurs = readSavedInputs(clone)?.repo === inp.repo;
	if (fs.existsSync(clone) && !cloneOurs)
		throw new Stop(`~/${inp.name} exists and is not this script's clone`, {
			code: 2,
			manual: `move ~/${inp.name} aside, or pick another name`,
		});
	const view = repoView(inp);
	if (!view && cloneOurs)
		throw new Stop(
			`~/${inp.name} holds this script's clone, but ${inp.repo} is gone from GitHub`,
			{
				code: 2,
				manual: `delete ~/${inp.name} too and start fresh`,
				fresh: true,
			},
		);
	const repoOurs =
		view !== null &&
		(cloneOurs ||
			(view.isEmpty && view.isPrivate && view.owner?.login === OWNER));
	if (view && !repoOurs)
		throw new Stop(`${inp.repo} already exists`, {
			code: 2,
			manual:
				"that name belongs to a repo this script did not make — pick another name or delete it on GitHub yourself",
			fresh: true,
		});
	const source = inp.source ? sourcePreflight(inp, clone) : null;
	bashrcPreflight(inp);
	const founder = readFounderName();
	return {
		tag,
		founder,
		repoExists: view !== null,
		cloneExists: cloneOurs,
		source,
		modules: source?.modules ?? [],
	};
}

const LOCAL_SETTINGS = ".claude/settings.local.json";

/** The marked block of `!` negations a copied repo's `.gitignore` gains. */
const KEEP_OPEN =
	"# --- workflow-core: keep the core's files trackable (new-repo.js) ---";
const KEEP_CLOSE = "# --- end workflow-core block ---";

/**
 * Which of `paths` git ignores in `tree`, each with the line hiding it. Paths
 * that do not exist yet get the verdict they will get once written, and a
 * tracked path is never hidden.
 * @param {string} tree
 * @param {string[]} paths
 * @returns {Map<string, string>}
 */
function readHiddenPaths(tree, paths) {
	const r = spawnGitSync(["check-ignore", "-v", "--stdin"], {
		cwd: tree,
		input: `${paths.join("\n")}\n`,
		encoding: "utf8",
	});
	if (r.status !== 0 && r.status !== 1)
		throw new Error(`git check-ignore failed in ${tree}: ${r.stderr.trim()}`);
	const found = new Map();
	const shape = /^(.*):(\d+):(.*)\t(.*)$/;
	for (const line of r.stdout.split("\n")) {
		const m = shape.exec(line);
		if (!m) continue;
		const pattern = requiredGroup(m, 3, shape);
		// -v reports a negation that matched too, which un-hides its path.
		if (!pattern.startsWith("!"))
			found.set(
				requiredGroup(m, 4, shape),
				`${requiredGroup(m, 1, shape)}:${requiredGroup(m, 2, shape)} ("${pattern}")`,
			);
	}
	return found;
}

/**
 * Keeps init's paths trackable in `tree` (#694 item 4): a marked block
 * negating each hidden path is appended to `.gitignore` — never a second one
 * — and every path re-checked. What stays hidden, as under a parent
 * directory's pattern such as `.claude/`, stops the run, the hiding lines
 * named after `whose`. `dry` appends nothing, so a block it would append goes
 * unchecked.
 * @param {string} tree
 * @param {{whose: string, stop: {manual: string, fresh?: boolean},
 *   aside: string[], dry?: boolean}} opts
 */
function keepTrackable(tree, { whose, stop, aside, dry = false }) {
	const paths = [...INIT_PATHS, ...aside];
	const file = path.join(tree, ".gitignore");
	const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
	const present = text.split("\n").includes(KEEP_OPEN);
	const negated = present ? [] : [...readHiddenPaths(tree, paths).keys()];
	if (negated.length > 0 && dry) return { present, negated };
	if (negated.length > 0)
		fs.writeFileSync(
			file,
			appendLines(text, [
				KEEP_OPEN,
				...negated.map((p) => `!/${p}`),
				KEEP_CLOSE,
			]),
		);
	const stuck = readHiddenPaths(tree, paths);
	if (stuck.size > 0)
		throw new Stop(
			`${whose}${buildHidingClauses(stuck)}, and no negation can undo it`,
			{ code: 2, ...stop },
		);
	return { present, negated };
}

/**
 * `<line> hides <path>, <path>; …`, one clause per hiding line.
 * @param {Map<string, string>} stuck
 */
function buildHidingClauses(stuck) {
	/** @type {Map<string, string[]>} */
	const by = new Map();
	for (const [p, line] of stuck) by.set(line, [...(by.get(line) ?? []), p]);
	return [...by]
		.map(([line, ps]) => `${line} hides ${ps.join(", ")}`)
		.join("; ");
}

/**
 * @typedef {{branch: string, licence: string|null, workflows: string[],
 *   commands: ReturnType<typeof inferCommands>, modules: string[],
 *   copied: boolean, negated: string[], aside: string[]|null}} Source
 */

/**
 * The copy flow's preflight: the source repo reachable, no hook of its own
 * that init would write over, and init's paths trackable past its
 * `.gitignore`, judged in a scratch clone. Once the clone holds the copy
 * (`copied`), the gitignore step judges the clone instead, where a line the
 * founder narrowed by hand is what counts; the hooks were judged before the
 * copy was made, and init may have written its own since. `aside` names the
 * files the source repo has to set aside, known only from the scratch clone.
 * @param {Inputs} inp
 * @param {string} clone
 * @returns {Source}
 */
function sourcePreflight(inp, clone) {
	const src = /** @type {string} */ (inp.source);
	let view;
	try {
		view = ghJson([
			"repo",
			"view",
			src,
			"--json",
			"defaultBranchRef,licenseInfo",
		]);
	} catch (e) {
		if (/Could not resolve to a Repository/.test(parseErrLine(e)))
			throw new Stop(`the source repo ${src} is not reachable`, {
				code: 2,
				cause: e,
				manual: "check its owner/name, and that gh's account can read it",
				fresh: true,
			});
		throw new Stop(
			`could not read the source repo ${src} (${parseErrLine(e)})`,
			{
				code: 1,
				cause: e,
			},
		);
	}
	const branch = view.defaultBranchRef?.name;
	if (!branch)
		throw new Stop(`the source repo ${src} has no commits to copy`, {
			code: 2,
			manual: "pick a source repo that holds commits, or none",
			fresh: true,
		});
	const copied = revParse(clone, "refs/heads/main") !== null;
	const scratch = copied
		? null
		: fs.mkdtempSync(path.join(os.tmpdir(), "new-repo-source-"));
	try {
		const tree = scratch ? path.join(scratch, "source") : clone;
		const { negated, aside } = scratch
			? judgeScratchClone(src, tree)
			: { negated: [], aside: null };
		let commands;
		try {
			commands = inferCommands(tree);
		} catch (e) {
			throw new Stop(parseErrLine(e), {
				code: 2,
				cause: e,
				manual: copied
					? `fix package.json in ~/${inp.name}`
					: "pick another source repo: its package.json does not parse",
				fresh: !copied,
			});
		}
		const modules = readCopiedModules(tree, commands);
		const flows = path.join(tree, ".github/workflows");
		const workflows = fs.existsSync(flows)
			? fs
					.readdirSync(flows)
					.filter((f) => /\.ya?ml$/.test(f))
					.sort()
					.map((f) => `.github/workflows/${f}`)
			: [];
		return {
			branch,
			licence: view.licenseInfo?.name ?? null,
			workflows,
			commands,
			modules,
			copied,
			negated,
			aside,
		};
	} finally {
		if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
	}
}

/**
 * Each module whose subject the copy tracks (#1506), and `suites` wherever a
 * test command was inferred, as #704 ruled.
 * @param {string} tree
 * @param {ReturnType<typeof inferCommands>} commands
 * @returns {string[]}
 */
function readCopiedModules(tree, commands) {
	let modules;
	try {
		modules = readSubjectModules(tree);
	} catch (e) {
		throw new Stop(parseErrLine(e), { code: 1, cause: e });
	}
	if (commands.test && !modules.includes("suites")) modules.unshift("suites");
	return modules;
}

/**
 * Clones the source into the scratch `tree` and judges it: refused on a hook
 * clash, else the gitignore negations it needs and the files it sets aside.
 * @param {string} src
 * @param {string} tree
 * @returns {{negated: string[], aside: string[]|null}}
 */
function judgeScratchClone(src, tree) {
	gh(["repo", "clone", src, tree, "--", "-q", "--depth", "1"]);
	const tracked = new Set(
		git(tree, ["ls-files", "-z"]).split("\0").filter(Boolean),
	);
	const clash = HOOKS.filter(
		(h) => h !== "pre-commit" && tracked.has(`.husky/${h}`),
	);
	if (clash.length > 0)
		throw new Stop(
			`the source repo has ${clash.map((h) => `.husky/${h}`).join(", ")}, which the core's hook of the same name would overwrite`,
			{
				code: 2,
				manual:
					"pick another source repo: only a source pre-commit can be kept, as .husky/pre-commit.local",
				fresh: true,
			},
		);
	const moving = ASIDE.filter((m) => tracked.has(m.from));
	const aside = moving.map((m) => m.from);
	const { negated } = keepTrackable(tree, {
		whose: "the source repo's ",
		stop: {
			manual:
				"pick another source repo: the core's files cannot be kept trackable past that line",
			fresh: true,
		},
		aside: moving.map((m) => m.to),
	});
	return { negated, aside };
}

/**
 * What the founder takes on with the source repo (#694 item 8): reported,
 * never refused on.
 * @param {Inputs} inp
 * @param {Source} src
 */
function sourceFacts(inp, src) {
	out(`  licence: ${src.licence ?? "none declared on GitHub"}`);
	out(
		src.workflows.length > 0
			? `  workflows: ${src.workflows.join(", ")} — GitHub Actions runs them in ${inp.repo} on their own triggers`
			: "  workflows: none",
	);
}

/**
 * The copy (#694 items 1–3): the source repo's default branch pushed to
 * origin as `main`, with its tags. A re-run fetches and pushes again; what
 * origin already holds is sent nowhere. A dry run fetches nothing, so it
 * reads the clone as it stands.
 * @param {Step} step
 * @param {Source} src
 * @returns {string|null} the source commit main is built on; null in a dry
 *   run before the copy
 */
function copySource({ inp, clone, env, dry }, src) {
	const base = dry ? readCopiedBase(clone, src) : fetchSource(inp, clone, src);
	const unsent = base === null ? null : copyUnsent(clone, base, dry);
	if (unsent && !unsent.branch && unsent.tags.length === 0)
		report("source repo", SKIPPED, `${inp.source}'s ${src.branch} is main`);
	else if (dry)
		report(
			"source repo",
			"would",
			`push ${inp.source}'s ${src.branch} to ${inp.repo} as main, with its tags; upstream fetch-only`,
		);
	else {
		const { branch, tags } = /** @type {{branch: boolean, tags: string[]}} */ (
			unsent
		);
		const r = runGit(
			clone,
			[
				"push",
				"-q",
				"origin",
				...(branch ? [`${base}:refs/heads/main`] : []),
				...tags,
			],
			env,
		);
		if (r.status !== 0)
			throw new Stop("the push of the source repo's copy was rejected", {
				code: 2,
				output: r.output,
				manual: `read the rejection above and settle it in ~/${inp.name}`,
			});
		report(
			"source repo",
			"done",
			[
				...(branch ? [`${inp.source}'s ${src.branch} pushed as main`] : []),
				...(tags.length > 0 ? [`${tags.length} tags pushed`] : []),
				"upstream fetch-only",
			].join(", "),
		);
	}
	sourceFacts(inp, src);
	return base;
}

/**
 * The source repo fetched into the clone as a fetch-only `upstream`, and
 * `main` made from its default branch where the clone has none.
 * @param {Inputs} inp
 * @param {string} clone
 * @param {Source} src
 * @returns {string} the source commit main is built on, which stays put when
 *   the source repo moves on after the copy
 */
function fetchSource(inp, clone, src) {
	const url = `https://github.com/${inp.source}.git`;
	/* `git config --get` exits 1 on an unset key, and only then. */
	const read = spawnGitSync(["config", "--get", "remote.upstream.url"], {
		cwd: clone,
		encoding: "utf8",
	});
	if (read.status === 1) git(clone, ["remote", "add", "upstream", url]);
	else if (read.status !== 0)
		throw new Error(`git config failed in ${clone}: ${read.stderr.trim()}`);
	const upstream = read.status === 0 ? read.stdout.trim() : null;
	if (upstream !== null && upstream !== url)
		throw new Stop(
			`~/${inp.name}'s upstream remote is ${upstream}, not the source repo`,
			{
				code: 2,
				manual: `point it back: git -C ~/${inp.name} remote set-url upstream ${url}`,
			},
		);
	git(clone, ["remote", "set-url", "--push", "upstream", "no-push"]);
	const tracking = `refs/remotes/upstream/${src.branch}`;
	git(clone, [
		"fetch",
		"-q",
		"--no-tags",
		"upstream",
		`+refs/heads/${src.branch}:${tracking}`,
	]);
	git(clone, ["fetch", "-q", "upstream", "+refs/tags/*:refs/tags/*"]);
	const tip = git(clone, ["rev-parse", tracking]);
	if (revParse(clone, "refs/heads/main") === null)
		git(clone, ["checkout", "-q", "-B", "main", tip]);

	git(clone, ["fetch", "-q", "origin"]);
	const remote = revParse(clone, "refs/remotes/origin/main");
	if (remote && !isAncestor(clone, remote, "refs/heads/main"))
		throw new Stop(
			`${inp.repo}'s main is not an ancestor of ~/${inp.name}'s main: the two have diverged`,
			{
				code: 2,
				manual: `settle ~/${inp.name}'s main against origin/main by hand`,
			},
		);
	const merge = spawnGitSync(["merge-base", "refs/heads/main", tip], {
		cwd: clone,
		encoding: "utf8",
	});
	// Exit 1 with no output is git's "no common ancestor"; anything else failed.
	if (merge.status === 1 && !merge.stderr.trim())
		throw new Stop(
			`~/${inp.name}'s main shares no history with the source repo's ${src.branch}`,
			{
				code: 2,
				manual: `settle ~/${inp.name}'s main against the source repo by hand`,
			},
		);
	if (merge.status !== 0)
		throw new Error(
			`git merge-base failed in ${clone}: ${merge.stderr.trim()}`,
		);
	return merge.stdout.trim();
}

/**
 * fetchSource's base read without fetching, for the dry run: null before the
 * copy.
 * @param {string} clone
 * @param {Source} src
 */
function readCopiedBase(clone, src) {
	if (!src.copied) return null;
	const r = spawnGitSync(
		["merge-base", "refs/heads/main", `refs/remotes/upstream/${src.branch}`],
		{ cwd: clone, encoding: "utf8" },
	);
	return r.status === 0 ? r.stdout.trim() : null;
}

/**
 * The refs `remote` holds, by name, each with its sha.
 * @param {string} clone
 * @param {string} remote
 */
const readRemoteRefs = (clone, remote) =>
	new Map(
		git(clone, ["ls-remote", "--refs", remote])
			.split("\n")
			.filter(Boolean)
			.map((l) => /** @type {[string, string]} */ (l.split("\t").reverse())),
	);

/**
 * What of the copy origin lacks: `branch` where its main does not hold
 * `base`, and each tag it lacks — the clone's, and under `dry`, which fetched
 * nothing, upstream's too. A tag the source repo moved after the copy keeps
 * origin's sha, being on origin by name.
 * @param {string} clone
 * @param {string} base
 * @param {boolean} dry
 */
function copyUnsent(clone, base, dry) {
	const origin = readRemoteRefs(clone, "origin");
	const mainSha = origin.get("refs/heads/main");
	const tags = new Set([
		...git(clone, ["for-each-ref", "--format=%(refname)", "refs/tags"]).split(
			"\n",
		),
		...(dry ? readRemoteRefs(clone, "upstream").keys() : []),
	]);
	return {
		branch: mainSha === undefined || !isAncestor(clone, base, mainSha),
		tags: [...tags].filter(
			(ref) => ref.startsWith("refs/tags/") && !origin.has(ref),
		),
	};
}

/**
 * The ASIDE entries the source commit has, by path, with their mode and blob.
 * @param {string} clone
 * @param {string} base
 * @returns {Map<string, {mode: string, blob: string}>}
 */
function readSourceEntries(clone, base) {
	const entries = new Map();
	for (const entry of git(clone, [
		"ls-tree",
		"-z",
		base,
		"--",
		...ASIDE.map((m) => m.from),
	]).split("\0")) {
		const [meta, p] = entry.split("\t");
		if (p) {
			if (meta === undefined)
				throw new Error(`ls-tree entry has no mode field: ${entry}`);
			const [mode, , blob] = meta.split(" ");
			entries.set(p, { mode, blob });
		}
	}
	return entries;
}

/** Whether `file` exists, a dangling link included. */
const present = (/** @type {string} */ file) => {
	try {
		fs.lstatSync(file);
		return true;
	} catch {
		return false;
	}
};

/**
 * The source repo's instructions and hook set aside (#694 item 6). A file moves only while it still
 * holds the source commit's own text: once init has written the core's, or
 * where the source repo never had it, there is nothing to move. A link to the
 * instructions is removed, its target holding the text; a linked hook moves
 * within `.husky/`, where its target still resolves. A set-aside copy already
 * beside the source's own file finishes the move where the two match, and
 * stops the run where they differ, since one of them holds edits — before
 * anything moves. A dry run before the copy reads the scratch clone's list.
 * @param {Step} step
 * @param {string|null} base the source commit main is built on
 * @param {Source} src
 * @returns {string[]} the set-aside copies it made, or would
 */
function setAside({ inp, clone, dry }, base, src) {
	if (base === null) {
		report("set aside", "would", asidePlan(src));
		return [];
	}
	const source = readSourceEntries(clone, base);
	/** @type {AsideMoves} */
	const moves = { done: [], changed: [], repairs: [], acts: [], made: [] };
	for (const entry of ASIDE)
		planAsideMove({ inp, clone, source }, entry, moves);
	applyAside(dry, moves, source.size);
	for (const from of moves.changed)
		out(
			`  warning: ${from} differs from the source repo's and was left where it is`,
		);
	return moves.made;
}

/**
 * What setAside collects over ASIDE: `repairs` is a copy already made, each
 * finishing its move.
 * @typedef {{done: string[], changed: string[], repairs: string[],
 *   acts: (() => void)[], made: string[]}} AsideMoves
 */

/**
 * The dry-run plan before the copy, from the scratch clone's list.
 * @param {Source} src
 * @returns {string}
 */
function asidePlan(src) {
	if (src.aside === null)
		return `move aside whichever of ${ASIDE.map((m) => m.from).join(", ")} still holds the source repo's text`;
	if (src.aside.length > 0)
		return ASIDE.filter((m) => src.aside?.includes(m.from))
			.map((m) => `move ${m.from} to ${m.to}`)
			.join(", ");
	return `nothing: the source repo has none of ${ASIDE.map((m) => m.from).join(", ")}`;
}

/**
 * What the set-aside hook gains where it names no shell, as husky v9 writes
 * hooks with no shebang: shellcheck reads `pre-commit.local` by name since
 * #1828, and refuses a file naming none (SC2148). `sh` is the shell husky
 * runs a hook with (#1870).
 */
const SHELL_DIRECTIVE = "# shellcheck shell=sh\n";

/**
 * Whether `bytes` name their shell: a shebang, or a shell directive among the
 * leading comments, the only place shellcheck reads one for the whole file.
 * @param {Buffer} bytes
 */
function hasShellName(bytes) {
	const text = bytes.toString("latin1");
	const head = /^(?:[ \t]*(?:#.*)?\n)*/.exec(text)?.[0] ?? "";
	return text.startsWith("#!") || /^#\s*shellcheck\s.*\bshell=/m.test(head);
}

/**
 * Whether `file` holds the source repo's `from`: the same blob — for the hook,
 * with or without SHELL_DIRECTIVE added — or for a link (`target` set), a link
 * to the same target.
 * @param {Held} held
 * @param {string} file
 */
function isSourceCopy({ clone, from, was, target, hook }, file) {
	if (target !== null)
		return (
			fs.lstatSync(file).isSymbolicLink() && fs.readlinkSync(file) === target
		);
	if (git(clone, ["hash-object", `--path=${from}`, "--", file]) === was.blob)
		return true;
	const bytes = fs.readFileSync(file);
	const lead = Buffer.from(SHELL_DIRECTIVE);
	return (
		hook &&
		bytes.subarray(0, lead.length).equals(lead) &&
		git(
			clone,
			["hash-object", `--path=${from}`, "--stdin"],
			bytes.subarray(lead.length),
		) === was.blob
	);
}

/**
 * The source repo's `from` in the clone, with how to read it.
 * @typedef {{clone: string, from: string, was: {mode: string, blob: string},
 *   target: string|null, hook: boolean}} Held
 */

/**
 * Judges one ASIDE entry, adding its acts and report lines to `moves`.
 * @param {{inp: Inputs, clone: string, source: Map<string, {mode: string, blob: string}>}} ctx
 * @param {(typeof ASIDE)[number]} entry
 * @param {AsideMoves} moves accumulator: the entry's acts and report lines are pushed here
 */
function planAsideMove({ inp, clone, source }, entry, moves) {
	const { from, to, instructions } = entry;
	const was = source.get(from);
	if (!was) return;
	const target =
		was.mode === GIT_MODE.symlink
			? git(clone, ["cat-file", "blob", was.blob])
			: null;
	// The one entry that is not instructions; a linked one moves as a link.
	const held = {
		clone,
		from,
		was,
		target,
		hook: !instructions && target === null,
	};
	const at = path.join(clone, from);
	const dest = path.join(clone, to);
	const moved = present(at) && planMove(inp, held, entry, moves);
	if (held.hook) planDirective(held, moved ? at : dest, dest, moves);
}

/**
 * The move of a file still at `from`; refused where the clone holds both the
 * source's file and a different copy.
 * @param {Inputs} inp
 * @param {Held} held
 * @param {(typeof ASIDE)[number]} entry
 * @param {AsideMoves} moves
 * @returns {boolean} whether the source's file moves to `to`
 */
function planMove(inp, held, { from, to, instructions }, moves) {
	const { clone, target } = held;
	const at = path.join(clone, from);
	const dest = path.join(clone, to);
	if (!isSourceCopy(held, at)) {
		if (target === null && !present(dest)) moves.changed.push(from);
	} else if (target !== null && instructions) {
		moves.acts.push(() => fs.rmSync(at));
		moves.done.push(`${from}, a link to ${target}, removed`);
	} else if (!present(dest)) {
		moves.acts.push(() => {
			fs.mkdirSync(path.dirname(dest), { recursive: true });
			fs.renameSync(at, dest);
		});
		moves.done.push(`${from} → ${to}`);
		moves.made.push(to);
		return true;
	} else if (isSourceCopy(held, dest)) {
		moves.acts.push(() => fs.rmSync(at));
		moves.repairs.push(`remove ${from}, already set aside as ${to}`);
	} else
		throw new Stop(
			`~/${inp.name} holds both the source repo's ${from} and a different ${to}`,
			{
				code: 2,
				manual: `keep the text you mean in ~/${inp.name}/${to}, then delete ~/${inp.name}/${from}`,
			},
		);
	return false;
}

/**
 * SHELL_DIRECTIVE put first in the set-aside hook `dest` where it holds the
 * source's text byte for byte, naming no shell — read from `file`, which is
 * the hook still at `from` where planMove moves it. Also finishes a run that
 * moved the hook before adding it. Written in `.git/` and renamed over `dest`,
 * so a stop part-way leaves `dest` whole. It keeps its own aside-and-rename
 * rather than lib/atomic-write.js's, for that aside (#2085): one beside `dest`
 * would sit untracked in the work tree a resumed run reads as dirty, and the
 * fixed name lets the next run clear it.
 * @param {Held} held
 * @param {string} file
 * @param {string} dest
 * @param {AsideMoves} moves
 */
function planDirective({ clone, from, was }, file, dest, moves) {
	if (!present(file)) return;
	const raw =
		git(clone, ["hash-object", `--path=${from}`, "--", file]) === was.blob;
	if (!raw || hasShellName(fs.readFileSync(file))) return;
	const tmp = path.join(clone, ".git", "new-repo-hook.tmp");
	moves.acts.push(() => {
		fs.rmSync(tmp, { force: true });
		fs.writeFileSync(
			tmp,
			Buffer.concat([Buffer.from(SHELL_DIRECTIVE), fs.readFileSync(dest)]),
			{ mode: fs.statSync(dest).mode },
		);
		fs.renameSync(tmp, dest);
	});
	const line = `${SHELL_DIRECTIVE.trim()} added to ${path.relative(clone, dest)}`;
	(file === dest ? moves.repairs : moves.done).push(line);
}

/**
 * Runs the planned acts, or reports them under a dry run, then the step's line.
 * @param {boolean} dry
 * @param {AsideMoves} moves
 * @param {number} sourceSize how many ASIDE entries the source commit has
 */
function applyAside(dry, { done, repairs, acts }, sourceSize) {
	if (dry && acts.length > 0)
		report("set aside", "would", [...done, ...repairs].join(", "));
	else {
		for (const act of acts) act();
		if (done.length > 0) report("set aside", "done", done.join(", "));
		else if (repairs.length > 0) report("set aside", "repaired");
	}
	if (acts.length === 0)
		report(
			"set aside",
			sourceSize > 0 ? SKIPPED : "skipped — the source repo has none of them",
		);
}

/** The set-aside copies in `clone`. */
const asideIn = (/** @type {string} */ clone) =>
	ASIDE.map((m) => m.to).filter((p) => fs.existsSync(path.join(clone, p)));

/**
 * The gitignore step: init's paths, now written, kept trackable in the clone.
 * A dry run before the copy reads the scratch clone's verdict.
 * @param {Step} step
 * @param {Source} src
 * @param {string[]} aside the set-aside copies, which a dry run has yet to
 *   make
 */
function gitignore({ inp, clone, dry }, src, aside) {
	const before = dry && !src.copied;
	const { present: keepBlockPresent, negated } = before
		? { present: false, negated: src.negated }
		: keepTrackable(clone, {
				whose: "",
				stop: {
					manual: `narrow or remove that line in ~/${inp.name} — a pattern hiding a parent directory, such as \`.claude/\`, defeats any negation`,
				},
				aside,
				dry,
			});
	const list = negated.join(", ");
	if (negated.length > 0)
		return dry
			? report(
					"gitignore",
					"would",
					`append negations to .gitignore for ${list}`,
				)
			: report(
					"gitignore",
					"done",
					`negations appended to .gitignore for ${list}`,
				);
	if (before)
		return report(
			"gitignore",
			"would",
			"leave .gitignore as it is: it hides none of init's paths",
		);
	report("gitignore", keepBlockPresent ? SKIPPED : "skipped — nothing hidden");
}

/** @param {Inputs} inp */
const sourceSection = (inp) => `Source repo docs (${inp.source})`;

/**
 * The source repo's documents registered (#694 item 5), so the doc-map gate
 * passes the first commit: each tracked file in the gate's scope that init's
 * register lacks, the set-aside copies included, in a §A section of their
 * own, through register-doc.js, then §A rendered again. A re-run's init
 * renders §A from the sidecar too, so a stop between the two heals itself.
 *
 * `source-of-truth` with a cherry-pick route is design-vault's shape for its
 * source repo's docs, ruled at #694 item 5; the set-aside instructions are an
 * agent's to read, every other doc anyone's.
 * @param {Inputs} inp
 * @param {string} clone
 * @param {NodeJS.ProcessEnv} env
 * @param {boolean} [dry]
 */
function sourceDocs(inp, clone, env, dry = false) {
	const data = path.join(clone, "docs/doc-map-classes.json");
	const section = sourceSection(inp);
	const would = () =>
		report(
			"source docs",
			"would",
			`register the source repo's docs in docs/doc-map.md §A under "${section}", class source-of-truth`,
		);
	if (dry && !fs.existsSync(data)) return would();
	/** @type {Record<string, {section: string}>} */
	const classes = JSON.parse(fs.readFileSync(data, "utf8"));
	/* Whatever the doc-map gate already counts as registered, init's seeded
	 * registries among it, owes no "Source repo docs" row (#1626). */
	const covered = coverageMatchers(Object.keys(classes));
	const unregistered = [
		...new Set(
			inScope([
				...git(clone, ["ls-files", "-z"]).split("\0"),
				...asideIn(clone),
			]),
		),
	]
		.filter(
			(p) =>
				!covered.some((test) => test(p)) && fs.existsSync(path.join(clone, p)),
		)
		.sort();
	if (unregistered.length === 0)
		return report(
			"source docs",
			Object.values(classes).some((e) => e.section === section)
				? SKIPPED
				: "skipped — none in scope",
		);
	if (dry) return would();
	/**
	 * @param {string} script
	 * @param {string[]} args
	 */
	const child = (script, args) => {
		const r = runChild(clone, [process.execPath, script, ...args], env);
		if (r.status !== 0)
			throw new Stop(`${path.basename(script)} failed`, {
				code: 1,
				output: r.output,
			});
	};
	for (const p of unregistered) {
		const from = ASIDE.find((m) => m.to === p)?.from;
		child(path.join(CORE, "scripts/register-doc.js"), [
			p,
			"--class",
			"source-of-truth",
			"--section",
			section,
			"--new-section",
			"--role",
			from
				? `The source repo's ${from}, set aside where no session loads it`
				: `From the source repo ${inp.source}, kept as copied`,
			"--route",
			"Path-scoped cherry-pick from `upstream` only",
			...(/\.(md|html)$/.test(p) ? ["--reader", from ? "agent" : "both"] : []),
			"--no-claim",
			"--data-file",
			data,
		]);
	}
	child(path.join(CORE, "scripts/generate-doc-map-section-a.js"), [
		"--no-claim",
		"--map",
		path.join(clone, "docs/doc-map.md"),
		"--data-file",
		data,
	]);
	report(
		"source docs",
		"done",
		`${unregistered.length} registered in docs/doc-map.md §A under "${section}"`,
	);
}

/** @param {number} map */
const buildFirstPrompt = (map) =>
	`/wayfinder Chart the map on #${map}. It holds my idea and no destination yet: fill that issue as the map rather than creating a new one.`;

/**
 * The first map's body (#695): the destination left for the first session,
 * the idea verbatim in Notes. `map` null leaves out the prompt, whose number
 * is only known once filed.
 * @param {Inputs} inp
 * @param {number|null} map
 */
function buildMapBody(inp, map) {
	const notes = [
		"The founder's idea, in their own words:",
		inp.idea,
		...(inp.specUrl
			? [
					`A spec is already written elsewhere — cited, not transferred; the first charting session decides what to bring over: ${inp.specUrl}`,
				]
			: []),
		...(map === null
			? []
			: [
					"The first-session prompt:",
					`\`\`\`\n${buildFirstPrompt(map)}\n\`\`\``,
				]),
	];
	return `## Destination\n\n${UNFILLED_DESTINATION}\n\n## Notes\n\n${notes.join("\n\n")}\n\n## Decisions so far\n\n## Not yet specified\n\n## Out of scope\n`;
}

/**
 * One issue filed through file-issue.js, which labels and places it and runs
 * the issue gate itself; its number, or a stop naming what refused it. Filed
 * under no session id: the script files the map, not the session that ran
 * it, so the map stays unassigned for /wayfinder and the filing is no act in
 * that session's ledger (#2460).
 * @param {string} clone
 * @param {NodeJS.ProcessEnv} env
 * @param {{slug: string, noun: string, title: string, labels: string[],
 *   place: string[], body: string, manual: string}} issue `place` is
 *   file-issue.js's `--parent` or `--standalone` pair
 * @returns {number}
 */
function fileIssue(
	clone,
	env,
	{ slug, noun, title, labels, place, body, manual },
) {
	const bodyFile = path.join(clone, ".git", `new-repo-${slug}.md`);
	fs.writeFileSync(bodyFile, body);
	const { CLAUDE_CODE_SESSION_ID: _, ...filerEnv } = env;
	const filed = runChild(
		clone,
		[
			process.execPath,
			path.join(CORE, "scripts/file-issue.js"),
			"--title",
			title,
			...labels.flatMap((l) => ["--label", l]),
			...place,
			"--body-file",
			bodyFile,
		],
		filerEnv,
	);
	const n = filed.output.match(/^Filed #(\d+)/m);
	if (filed.status !== 0 || !n)
		throw new Stop(`file-issue.js did not file ${noun}`, {
			code: filed.status === 2 ? 2 : 1,
			output: filed.output,
			manual,
		});
	return Number(n[1]);
}

/**
 * The duplicate rule (#706 Q7): every open issue in `dups` closed as a
 * duplicate of `kept`.
 * @param {Inputs} inp
 * @param {number} kept
 * @param {number[]} dups
 */
function closeDuplicates(inp, kept, dups) {
	for (const dup of dups)
		gh([
			"issue",
			"close",
			String(dup),
			"--repo",
			inp.repo,
			"--comment",
			`duplicate of #${kept}, filed by a failed new-repo run`,
		]);
}

/**
 * @param {Inputs} inp
 * @param {number} map
 * @returns {string}
 */
const readMapBody = (inp, map) =>
	String(
		ghJson(["issue", "view", String(map), "--repo", inp.repo, "--json", "body"])
			.body,
	);

/**
 * The first map GitHub holds — the lowest-numbered, with the open issues the
 * duplicate rule closes and its body — or null where none is filed.
 * @param {Inputs} inp
 * @returns {{map: number, dups: number[], body: string}|null}
 */
function readMapState(inp) {
	/** @type {{number: number, state: string}[]} */
	const maps = ghJson([
		"issue",
		"list",
		"--repo",
		inp.repo,
		"--label",
		MAP_LABEL,
		"--state",
		"all",
		"--json",
		"number,state",
		"--limit",
		String(ISSUE_LIST_LIMIT),
	]).sort(
		(/** @type {{number: number}} */ a, /** @type {{number: number}} */ b) =>
			a.number - b.number,
	);
	const [first] = maps;
	if (first === undefined) return null;
	const map = first.number;
	return {
		map,
		dups: maps
			.slice(1)
			.filter((m) => m.state === "OPEN")
			.map((m) => m.number),
		body: readMapBody(inp, map),
	};
}

/**
 * @param {Step} step
 * @param {boolean} repoExists as preflight found it; the run has made it
 * @returns {number|null} the map; null in a dry run before it is filed
 */
function firstMap({ inp, clone, env, dry }, repoExists) {
	const found = repoExists || !dry ? readMapState(inp) : null;
	if (!found && dry) {
		report(
			"first map",
			"would",
			`"${inp.title}", labelled ${MAP_LABELS.join(" + ")}, unassigned`,
		);
		return null;
	}
	const map =
		found?.map ??
		fileIssue(clone, env, {
			slug: "map",
			noun: "the map",
			title: inp.title,
			labels: MAP_LABELS,
			place: ["--standalone", "the new repo's first map, filed by new-repo.js"],
			body: buildMapBody(inp, null),
			manual:
				"file-issue.js refused the map as above — fix the idea or title file it names",
		});
	const dups = found?.dups ?? [];
	const body = found?.body ?? readMapBody(inp, map);
	/* The prompt names the map's own number, so it goes in once that is known. */
	const prompted = body.includes(buildFirstPrompt(map));
	const fixes = [
		...dups.map((n) => `close #${n} as a duplicate`),
		...(prompted ? [] : ["put the first-session prompt in its body"]),
	];
	if (dry) {
		if (fixes.length > 0)
			report("first map", "would", `#${map}: ${fixes.join(", ")}`);
		else report("first map", SKIPPED, `#${map}`);
		return map;
	}
	closeDuplicates(inp, map, dups);
	if (!prompted) writeMapPrompt({ inp, clone, map }, body);
	let outcome = SKIPPED;
	if (!found) outcome = "done";
	else if (fixes.length > 0) outcome = "repaired";
	report("first map", outcome, `#${map}`);
	return map;
}

/**
 * Rewrites the map's body to carry the first-session prompt.
 * @param {{inp: Inputs, clone: string, map: number}} at
 * @param {string} body the map's body as GitHub holds it
 */
function writeMapPrompt({ inp, clone, map }, body) {
	const bodyFile = path.join(clone, ".git", "new-repo-map.md");
	// file-issue.js's `Standalone:` line is carried over.
	const standalone = body.match(/^Standalone: .*$/m)?.[0];
	fs.writeFileSync(
		bodyFile,
		`${buildMapBody(inp, map)}${standalone ? `\n${standalone}\n` : ""}`,
	);
	gh([
		"issue",
		"edit",
		String(map),
		"--repo",
		inp.repo,
		"--body-file",
		bodyFile,
	]);
}

/** @param {Inputs} inp */
const buildReconcileTitle = (inp) =>
	`Reconcile ${inp.source}'s agent instructions with the core's`;

/**
 * The reconcile ticket filed so far, found by title under the map or by its
 * label — the lowest-numbered, with the open issues the duplicate rule closes
 * and whether it is linked under the map — or null where none is filed.
 * @param {Inputs} inp
 * @param {number} map
 * @returns {{kept: number, dups: number[], linked: boolean}|null}
 */
function reconcileState(inp, map) {
	const title = buildReconcileTitle(inp);
	/** @type {{number: number, title: string, state: string}[]} */
	const children = ghApiSlurp([`repos/${inp.repo}/issues/${map}/sub_issues`]);
	/** @type {Map<number, string>} number → state, upper-cased as `issue list` gives it */
	const found = new Map();
	for (const i of [
		...children,
		...ghJson([
			"issue",
			"list",
			"--repo",
			inp.repo,
			"--label",
			RECONCILE_LABEL,
			"--state",
			"all",
			"--json",
			"number,title,state",
			"--limit",
			String(ISSUE_LIST_LIMIT),
		]),
	])
		if (i.title === title) found.set(i.number, i.state.toUpperCase());
	const [kept] = [...found.keys()].sort((a, b) => a - b);
	if (kept === undefined) return null;
	return {
		kept,
		dups: [...found]
			.filter(([k, st]) => k !== kept && st === "OPEN")
			.map(([k]) => k),
		linked: children.some((c) => c.number === kept),
	};
}
/**
 * The reconcile ticket (#694 item 6), where the source commit has a
 * `CLAUDE.md` or `AGENTS.md`, deciding what of that text comes back. An issue
 * filed but never linked is linked, not filed twice. Last, as #713 orders it:
 * a stop here leaves only this ticket to file, which a re-run files. A dry run
 * before the copy reads the scratch clone's list.
 * @param {Step} step
 * @param {number|null} map null in a dry run before it is filed
 * @param {string|null} base the source commit main is built on
 * @param {Source} src
 */
function reconcile(step, map, base, src) {
	const { inp, clone, env, dry } = step;
	const instructions = ASIDE.filter((m) => m.instructions);
	const source = base ? readSourceEntries(clone, base) : null;
	const had = instructionsHad(instructions, source, src);
	if (had?.length === 0)
		return report("reconcile", "skipped — the source repo has no instructions");
	const found = map !== null && base ? reconcileState(inp, map) : null;
	if (!found)
		return fileReconcile(step, map, {
			instructions,
			source,
			had,
		});
	const { kept, dups, linked } = found;
	const fixes = [
		...dups.map((n) => `close #${n} as a duplicate`),
		...(linked ? [] : [`link it under #${map}`]),
	];
	if (dry)
		return fixes.length > 0
			? report("reconcile", "would", `#${kept}: ${fixes.join(", ")}`)
			: report("reconcile", SKIPPED, `#${kept} under #${map}`);
	closeDuplicates(inp, kept, dups);
	if (!linked) linkUnderMap({ inp, clone, env }, map, kept);
	report(
		"reconcile",
		fixes.length > 0 ? "repaired" : SKIPPED,
		`#${kept} under #${map}`,
	);
}

/**
 * The instruction files the source commit has; null in a dry run before the
 * copy whose scratch clone listed nothing.
 * @param {typeof ASIDE} instructions
 * @param {Map<string, {mode: string, blob: string}>|null} source
 * @param {Source} src
 * @returns {typeof ASIDE|null}
 */
function instructionsHad(instructions, source, src) {
	if (source) return instructions.filter((m) => source.has(m.from));
	if (src.aside !== null)
		return instructions.filter((m) => src.aside?.includes(m.from));
	return null;
}

/**
 * Files the reconcile ticket under the map, or says it would in a dry run.
 * @param {Step} step
 * @param {number|null} map
 * @param {{instructions: typeof ASIDE, source: Map<string, {mode: string, blob: string}>|null, had: typeof ASIDE|null}} listing
 */
function fileReconcile(
	{ inp, clone, env, dry },
	map,
	{ instructions, source, had },
) {
	if (dry)
		return report(
			"reconcile",
			"would",
			`"${buildReconcileTitle(inp)}" under the first map, labelled ${RECONCILE_LABELS.join(" + ")}, unassigned${had ? "" : `, where ${instructions.map((m) => m.from).join(" or ")} was set aside`}`,
		);
	const n = fileIssue(clone, env, {
		slug: "reconcile",
		noun: "the reconcile ticket",
		title: buildReconcileTitle(inp),
		labels: RECONCILE_LABELS,
		place: ["--parent", String(map)],
		body: [
			`new-repo.js set the source repo's agent instructions aside, where no session loads them: they bind every session, and a source repo's often carry rules this repo's core contradicts — pull requests, feature branches, Conventional Commits.`,
			/** @type {typeof ASIDE} */ (had)
				.map(({ from, to }) => {
					const was = source?.get(from);
					return was?.mode === GIT_MODE.symlink
						? `- the source repo's \`${from}\` was a link to \`${git(clone, ["cat-file", "blob", was.blob])}\``
						: `- \`${to}\` — the source repo's \`${from}\``;
				})
				.join("\n"),
			"Decide which of that text comes back into this repo's `CLAUDE.md` or `AGENTS.md`, and bring back only that, deliberately. What stays behind stays registered in `docs/doc-map.md` §A as the source repo's.",
		].join("\n\n"),
		manual: `settle what file-issue.js names above on ${inp.repo}`,
	});
	return report("reconcile", "done", `#${n} under #${map}`);
}

/**
 * Links the kept reconcile ticket under the map; stops the run where that fails.
 * @param {{inp: Inputs, clone: string, env: NodeJS.ProcessEnv}} step
 * @param {number|null} map
 * @param {number} kept
 */
function linkUnderMap({ inp, clone, env }, map, kept) {
	const r = runChild(
		clone,
		[
			"bash",
			path.join(CORE, "scripts/link-sub-issue.sh"),
			String(map),
			String(kept),
		],
		{ ...env, WFC_LINK_REPO: inp.repo },
	);
	if (r.status !== 0)
		throw new Stop(`#${kept} could not be linked under #${map}`, {
			code: 1,
			output: r.output,
		});
}

/* scripts/templates/adopter/CLAUDE.md's Project lines, verbatim: a template
 * edit turns every fill into a kept-with-warning, and the clean-run test fails. */
const ONE_LINER_SLOT = "<one line: what it is and who it is for>";
const STATE_SLOT = "State: <pre-launch / live / …>.";

/**
 * @param {Inputs} inp
 * @param {number} map
 */
const buildStateLine = (inp, map) =>
	`State: pre-launch — the way is being charted on #${map} (${inp.title}).`;

/**
 * The Project section (#695): filled where the template's placeholder
 * remains, kept with a warning where it holds something else. A dry run
 * before the map is filed reads nothing: CLAUDE.md may still be the source
 * repo's, which set-aside and init replace.
 * @param {Inputs} inp
 * @param {string} clone
 * @param {number|null} map null in a dry run before it is filed
 * @param {boolean} [dry]
 */
function projectSection(inp, clone, map, dry = false) {
	const file = path.join(clone, "CLAUDE.md");
	const text =
		dry && (map === null || !fs.existsSync(file))
			? null
			: fs.readFileSync(file, "utf8");
	const unfilled =
		text === null || text.includes(ONE_LINER_SLOT) || text.includes(STATE_SLOT);
	if (dry && unfilled)
		return report(
			"project",
			"would",
			`fill CLAUDE.md's Project section: "${inp.oneLiner}"`,
		);
	// Read, so the map is filed.
	const found = /** @type {string} */ (text);
	const state = buildStateLine(inp, /** @type {number} */ (map));
	if (unfilled) {
		fs.writeFileSync(
			file,
			found
				.replace(ONE_LINER_SLOT, () => inp.oneLiner)
				.replace(STATE_SLOT, () => state),
		);
		return report("project", "done", "CLAUDE.md's Project section filled");
	}
	if (found.includes(inp.oneLiner) && found.includes(state))
		return report("project", SKIPPED);
	report("project", "skipped — kept as found");
	out(
		`  warning: CLAUDE.md's Project section differs from what this run would write, and is kept — "${inp.oneLiner}" / "${state}"`,
	);
}

/**
 * The three plugin-cache Read rules (#711), one per plan's config dir, so a
 * subagent in the new repo reads installed plugins' references unprompted.
 * @param {string} clone
 * @param {boolean} [dry]
 */
function pluginReads(clone, dry = false) {
	const file = path.join(clone, LOCAL_SETTINGS);
	/** @type {{permissions?: {allow?: string[]}}} */
	let settings = {};
	if (fs.existsSync(file)) {
		try {
			settings = JSON.parse(fs.readFileSync(file, "utf8"));
		} catch (e) {
			throw new Stop(`${LOCAL_SETTINGS} does not parse (${String(e)})`, {
				code: 2,
				cause: e,
				manual: `fix or move ~/${path.basename(clone)}/${LOCAL_SETTINGS}`,
			});
		}
	}
	const home = os.homedir();
	// `//` opens an absolute path in a permission rule; a single `/` is the project's.
	const rules = [".claude", ".claude2", ".claude3"].map(
		(dir) => `Read(/${home}/${dir}/plugins/cache/**)`,
	);
	const allow = settings.permissions?.allow ?? [];
	const missing = rules.filter((r) => !allow.includes(r));
	if (missing.length === 0) return report("plugin reads", SKIPPED);
	if (dry)
		return report(
			"plugin reads",
			"would",
			`add ${missing.length} Read rules to ${LOCAL_SETTINGS}`,
		);
	settings.permissions = {
		...settings.permissions,
		allow: [...allow, ...missing],
	};
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
	report(
		"plugin reads",
		"done",
		`${missing.length} Read rules in ${LOCAL_SETTINGS}`,
	);
}

/**
 * The skeleton paths to commit, and what of them differs from HEAD.
 * settings.local.json is this machine's, so it is left out of the commit —
 * by an exclude only where no gitignore already hides it, since `git add`
 * refuses an exclude naming an ignored path (#725).
 * @param {string} clone
 */
function readSkeletonState(clone) {
	const spec = [
		...skeletonPaths((h) => fs.existsSync(path.join(clone, h))),
		...(readHiddenPaths(clone, [LOCAL_SETTINGS]).size > 0
			? []
			: [`:(exclude)${LOCAL_SETTINGS}`]),
	];
	// No optional locks: a dry run must not refresh the index's stat data.
	const dirty = git(clone, [
		"--no-optional-locks",
		"status",
		"--porcelain",
		"--untracked-files=all",
		"--",
		...spec,
	]);
	return { spec, dirty };
}

/**
 * Whether the skeleton commit has anything to commit: a skeleton path that,
 * once init has run, differs from HEAD. The dry run renders init into a scratch clone of HEAD, since
 * init rewrites its core-owned files from this checkout, which may have moved
 * on since the skeleton commit (#762) — unless the clone already differs, or
 * HEAD's pre-commit is not this core's shim (#1839).
 * @param {Inputs} inp
 * @param {Preflight} pre
 * @param {string} clone
 * @param {boolean} dry
 */
function commitPending(inp, pre, clone, dry) {
	if (!dry) return Boolean(readSkeletonState(clone).dirty);
	let hook;
	try {
		hook = git(clone, ["show", "HEAD:.husky/pre-commit"]);
	} catch {
		/* No clone, no HEAD or no hook committed: nothing is committed at this
		 * pin. Any other git failure reads the same, and costs only a `would`. */
		return true;
	}
	return (
		// trimEnd: git() trims what it reads.
		hook !== renderHookShim("pre-commit").trimEnd() ||
		Boolean(readSkeletonState(clone).dirty) ||
		initChangesHead(inp, pre, clone)
	);
}

/**
 * Whether init, run over a scratch clone of HEAD as the run runs it over the
 * clone, leaves a skeleton path differing from HEAD. Its tracker half is left
 * out: it writes no tracked file, and reaches GitHub. So is the plugin
 * install, which a dry run never makes: where HEAD lacks the core's
 * context-cost row, a run that installs adds it and commits, and this says
 * the commit is skipped.
 * @param {Inputs} inp
 * @param {Preflight} pre
 * @param {string} clone
 */
function initChangesHead(inp, pre, clone) {
	const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "new-repo-render-"));
	try {
		const tree = path.join(scratch, inp.name);
		git(scratch, ["clone", "-q", "--shared", clone, tree]);
		// Raw, not `remote get-url`, which would expand an insteadOf.
		git(tree, [
			"remote",
			"set-url",
			"origin",
			git(clone, ["config", "--get", "remote.origin.url"]),
		]);
		const r = runChild(
			tree,
			[
				process.execPath,
				path.join(CORE, "scripts/init-adopter.js"),
				...initArgs(inp, pre, tree, true),
				"--no-tracker",
			],
			{ ...process.env, CLAUDE_PROJECT_DIR: tree },
		);
		// An init that fails stops the run before its commit: `would` costs nothing.
		return r.status !== 0 || Boolean(readSkeletonState(tree).dirty);
	} finally {
		fs.rmSync(scratch, { recursive: true, force: true });
	}
}

/**
 * @param {Step} step
 * @param {Preflight} pre
 * @param {number|null} map null in a dry run before it is filed
 * @param {string} resumeCmd
 * @returns {boolean} whether there was a commit to make
 */
function skeletonCommit(
	{ inp, clone, env, dry, noInstall },
	pre,
	map,
	resumeCmd,
) {
	if (!commitPending(inp, pre, clone, dry)) {
		report("commit", SKIPPED);
		return false;
	}
	if (dry) {
		report(
			"commit",
			"would",
			"commit the skeleton through the new repo's hooks",
		);
		return true;
	}
	const { spec } = readSkeletonState(clone);
	const manual = `open a new tab, run \`${inp.prefix}1\`, fix it in that session, then re-run from workflow-core: ${resumeCmd}`;
	const add = runGit(clone, ["add", "-N", "--", ...spec], env);
	if (add.status !== 0)
		throw new Stop("git add refused the skeleton paths", {
			code: 2,
			output: add.output,
			manual,
		});
	const r = runGit(
		clone,
		[
			"commit",
			"-q",
			"-m",
			`Start ${inp.name} on the workflow core`,
			"-m",
			`Its first session charts #${map} under the core's rules. The adopted skeleton, pinned to workflow-core ${pre.tag}, written by new-repo.js.`,
			"--",
			...spec,
		],
		// With no install recorded, the hook shims resolve no core but this one (#1839).
		noInstall ? { ...env, WORKFLOW_CORE_DIR: CORE } : env,
	);
	if (r.status !== 0)
		throw new Stop("a hook refused the skeleton commit", {
			code: 2,
			output: r.output,
			manual,
		});
	report("commit", "done", git(clone, ["rev-parse", "--short", "HEAD"]));
	return true;
}

/**
 * origin's main: fetched in the run, asked over the wire in the dry run.
 * @param {string} clone
 * @param {boolean} dry
 */
function readOriginMain(clone, dry) {
	if (dry)
		return (
			git(clone, ["ls-remote", "origin", "refs/heads/main"]).split("\t")[0] ||
			null
		);
	git(clone, ["fetch", "-q", "origin"]);
	return revParse(clone, "refs/remotes/origin/main");
}

/**
 * @param {Step} step
 * @param {boolean} committing whether the commit step had a commit to make:
 *   in a dry run, still to make, so the push would carry it
 */
function push({ inp, clone, env, dry }, committing) {
	const head = dry && committing ? null : revParse(clone, "HEAD");
	if (head !== null && readOriginMain(clone, dry) === head)
		return report("push", SKIPPED);
	if (dry) return report("push", "would", `push main to ${inp.repo}`);
	const r = runGit(clone, ["push", "-q", "-u", "origin", "main"], env);
	if (r.status !== 0)
		throw new Stop("the push was rejected", {
			code: 2,
			output: r.output,
			manual: `read the rejection above and settle it in ~/${inp.name}`,
		});
	report("push", "done", "main");
}

/** Each plan's config-dir suffix, in alias order: `<prefix>1` is `~/.claude`. */
const PLANS = ["", "2", "3"];

const bashrcPath = () => path.join(os.homedir(), ".bashrc");

/**
 * A repo's block markers, in the shape every existing block uses (#697).
 * @param {string} name
 */
const markers = (name) => ({
	open: `# --- ${name}, one alias per plan ---`,
	close: `# --- end ${name} block ---`,
});

/**
 * The launch block (#697): one alias per plan, agents view only, in the
 * existing blocks' shape.
 * @param {Inputs} inp
 */
function buildLaunchBlock(inp) {
	const aliases = PLANS.map(
		(d, i) =>
			`alias ${inp.prefix}${i + 1}='(cd ~/${inp.name} && CLAUDE_CONFIG_DIR=$HOME/.claude${d} claude agents)'`,
	);
	const { open, close } = markers(inp.name);
	return [open, ...aliases, close].join("\n");
}

/**
 * The repo's block already in ~/.bashrc, with its 1-based line range; null
 * where there is none. Trailing whitespace is dropped, so it alone never
 * reads as a difference.
 * @param {string} text
 * @param {string} name
 */
function findBlock(text, name) {
	const lines = text.split("\n").map((l) => l.trimEnd());
	const { open, close } = markers(name);
	const start = lines.indexOf(open);
	if (start < 0) return null;
	const end = lines.indexOf(close, start + 1);
	if (end < 0)
		throw new Stop(
			`${bashrcPath()} opens the ${name} block at line ${start + 1} and never closes it`,
			{
				code: 2,
				manual: `add \`${close}\` below that block's last alias, or delete its opening line`,
			},
		);
	return {
		start: start + 1,
		end: end + 1,
		text: lines.slice(start, end + 1).join("\n"),
	};
}

const readBashrc = () =>
	fs.existsSync(bashrcPath()) ? fs.readFileSync(bashrcPath(), "utf8") : "";

/** `bash -n` over ~/.bashrc; null where it passes or there is none. */
function bashrcSyntax() {
	if (!fs.existsSync(bashrcPath())) return null;
	const r = runChild(os.homedir(), ["bash", "-n", bashrcPath()], process.env);
	return r.status === 0 ? null : r.output;
}

/**
 * ~/.bashrc parses, and `<prefix>1`–`3` are free as an interactive shell sees
 * them — aliases, functions, builtins and PATH files alike. The bare prefix is
 * not checked: `wc` is /usr/bin/wc, `wc1` is free (#697). Where the repo's
 * block is already there, its aliases are its own and nothing will be written.
 * The cost of asking an interactive shell: whatever ~/.bashrc runs, runs here —
 * under `--dry-run` too.
 * @param {Inputs} inp
 */
function bashrcPreflight(inp) {
	const broken = bashrcSyntax();
	if (broken)
		throw new Stop(`${bashrcPath()} fails \`bash -n\``, {
			code: 2,
			output: broken,
			manual: `fix ${bashrcPath()} until \`bash -n ~/.bashrc\` passes`,
		});
	if (findBlock(readBashrc(), inp.name)) return;
	const names = PLANS.map((_, i) => `${inp.prefix}${i + 1}`);
	const r = runChild(
		os.homedir(),
		[
			"bash",
			"-i",
			"-c",
			`for n in ${names.join(" ")}; do printf 'new-repo-type %s %s\\n' "$n" "$(type -t "$n")"; done`,
		],
		process.env,
		// A guess: this machine's ~/.bashrc loads in well under a second.
		30_000,
	);
	const seen = [...r.output.matchAll(/^new-repo-type (\S+) ?(\S*)$/gm)];
	if (seen.length !== names.length)
		throw new Stop(
			`could not ask an interactive bash whether ${names.join(", ")} are free`,
			{ code: 1, output: r.output },
		);
	const taken = seen
		.filter((m) => m[2])
		.map((m) => `${m[1]} is taken (${m[2]})`);
	if (taken.length > 0)
		throw new Stop(`the prefix "${inp.prefix}" clashes: ${taken.join(", ")}`, {
			code: 2,
			manual: "pick another prefix",
		});
}

const showBlock = (/** @type {string} */ b) => {
	for (const line of b.split("\n")) out(`  ${line}`);
};

/**
 * Reports a block ~/.bashrc already holds, kept as found, warning where it
 * differs from `block`.
 * @param {{inp: Inputs, file: string, found: {text: string, start: number, end: number}, block: string}} at
 * @returns {string} the block as found
 */
function keepFoundBlock({ inp, file, found, block }) {
	const same = found.text === block;
	report(
		"bashrc",
		same ? SKIPPED : "skipped — kept as found",
		`${file} lines ${found.start}-${found.end}`,
	);
	showBlock(found.text);
	if (!same) {
		out(
			`  warning: the ${inp.name} block in ${file} differs from what this run would write, and is kept. This run would write:`,
		);
		showBlock(block);
	}
	return found.text;
}

/**
 * The newlines an appended block needs to sit one blank line below `text`.
 * @param {string} text
 */
function blockLead(text) {
	if (text === "" || text.endsWith("\n\n")) return "";
	if (text.endsWith("\n")) return "\n";
	return "\n\n";
}

/**
 * The launch block (#713 step 5), before init and the commit so a refused
 * commit can be fixed from the new repo's own session. Every outcome prints
 * the path, line range and full block, which the skill repeats to the founder.
 * @param {Inputs} inp
 * @param {boolean} dryRun
 * @returns {string} the block ~/.bashrc holds, or will
 */
function launchAliases(inp, dryRun) {
	const file = bashrcPath();
	const text = readBashrc();
	const block = buildLaunchBlock(inp);
	const found = findBlock(text, inp.name);
	if (found) return keepFoundBlock({ inp, file, found, block });
	const lead = blockLead(text);
	const start = `${text}${lead}`.split("\n").length;
	const range = `${file} lines ${start}-${start + block.split("\n").length - 1}`;
	if (dryRun) {
		report("bashrc", "would", `append to ${range}, backing it up first`);
		showBlock(block);
		return block;
	}
	const existed = fs.existsSync(file);
	const backup = `${file}.bak-new-repo-${new Date().toISOString().replace(/[-:]|\.\d+/g, "")}`;
	if (existed) fs.copyFileSync(file, backup);
	fs.appendFileSync(file, `${lead}${block}\n`);
	const broken = bashrcSyntax();
	if (broken) {
		if (existed) fs.copyFileSync(backup, file);
		else fs.rmSync(file);
		throw new Stop(
			`the block broke ${file}'s syntax, so ${existed ? `${file} is restored from ${backup}` : "the new file is removed"}`,
			{
				code: 2,
				output: broken,
				manual: `read \`bash -n\`'s complaint above and settle ${file} by hand`,
			},
		);
	}
	report(
		"bashrc",
		"done",
		`${range}, ${existed ? `backed up to ${backup}` : "a new file"}`,
	);
	showBlock(block);
	return block;
}

/** The digit of this session's plan, by its config dir: the alias's last character. */
function planDigit() {
	const dir = path.basename(process.env.CLAUDE_CONFIG_DIR ?? ".claude");
	return /^\.claude([23])$/.exec(dir)?.[1] ?? "1";
}

/**
 * @typedef {{tag: string, founder: string, repoExists: boolean,
 *   cloneExists: boolean, source: Source|null, modules: string[]}} Preflight
 */

/**
 * Where init's install lands the pin, so the hooks and rules file run it
 * rather than this checkout (#736).
 * @param {string} tag
 */
const pluginRoot = (tag) =>
	installPathFor(
		undefined,
		readManifestMarketplaceName(CORE) ?? "workflow-core",
		"workflow-core",
		tag,
	);

/**
 * init-adopter.js's arguments (#713 step 7), for the run and the dry run alike.
 * @param {Inputs} inp
 * @param {Preflight} pre
 * @param {string} clone
 * @param {boolean} noInstall
 */
const initArgs = (inp, pre, clone, noInstall) => [
	"--root",
	clone,
	"--founder",
	pre.founder,
	"--project",
	inp.name,
	"--modules",
	pre.modules.join(","),
	...(inp.corpus.length > 0 ? ["--corpus", inp.corpus.join(",")] : []),
	"--marketplace-ref",
	pre.tag,
	"--plugin-root",
	pluginRoot(pre.tag),
	...(noInstall ? ["--no-plugin-install"] : []),
];

/** @param {Preflight} pre */
const buildModulesLine = (pre) => pre.modules.join(", ") || "none";

/**
 * init-adopter.js (#713 step 7), every run: it is idempotent for its own
 * files. Its probe lines read the new tracker's features, true on one with no
 * issue yet (#705, #716), so the founder sees them (#734); a dry run shows the
 * modules and commands instead, for the confirmation line.
 * @param {Step} step
 * @param {Preflight} pre
 */
function initAdopter({ inp, clone, env, dry, noInstall }, pre) {
	const args = initArgs(inp, pre, clone, noInstall);
	if (dry) {
		report("init-adopter", "would", args.map(shellQuote).join(" "));
		report("modules", buildModulesLine(pre));
		const found = Object.entries(pre.source?.commands ?? {}).map(
			([c, hit]) => `${c}: ${hit?.command} (${hit?.from})`,
		);
		if (found.length > 0) out(`  commands: ${found.join("; ")}`);
		return;
	}
	const init = runChild(
		clone,
		[process.execPath, path.join(CORE, "scripts/init-adopter.js"), ...args],
		env,
	);
	/* init-adopter's 2 is a refusal of its input, which no re-run cures. */
	if (init.status !== 0)
		throw new Stop(`init-adopter.js exited ${init.status}`, {
			code: init.status === 2 ? 2 : 1,
			output: init.output,
			manual: `settle what init-adopter.js names above in ~/${inp.name}`,
		});
	report(
		"init-adopter",
		"done",
		`pinned to ${pre.tag}, modules ${buildModulesLine(pre)}`,
	);
	for (const line of init.output.split("\n"))
		if (/^(probe|WARNING|MISSING|FAILED)/.test(line)) out(`  ${line}`);
}

/**
 * Every step after preflight, in #713's order.
 * @param {Inputs} inp
 * @param {Preflight} pre
 * @param {string} clone
 * @param {{env: NodeJS.ProcessEnv, noInstall: boolean, resumeCmd: string,
 *   dry: boolean, at: {step: string}}} run accumulator: `at.step` is advanced
 *   to the step running, for a stop's report line; the rest is read
 * @returns {{map: number|null, aliases: string}} the first map, null in a dry
 *   run before it is filed, and the block ~/.bashrc holds, or will
 */
function steps(inp, pre, clone, { env, noInstall, resumeCmd, dry, at }) {
	at.step = "github repo";
	if (pre.repoExists) report(at.step, SKIPPED, inp.repo);
	else if (dry)
		report(at.step, "would", `gh repo create ${inp.repo} --private`);
	else {
		gh(["repo", "create", inp.repo, "--private"]);
		report(at.step, "done", `${inp.repo}, private`);
	}

	at.step = "clone";
	if (pre.cloneExists) report(at.step, SKIPPED, `~/${inp.name}`);
	else if (dry)
		report(
			at.step,
			"would",
			`gh repo clone ${inp.repo} ${clone}, saving the inputs to .git/${RECORD}`,
		);
	else {
		gh(["repo", "clone", inp.repo, clone]);
		report(at.step, "done", `~/${inp.name}`);
	}
	if (!dry) {
		if (!fs.existsSync(recordPath(clone)))
			fs.writeFileSync(recordPath(clone), `${JSON.stringify(inp, null, 2)}\n`);
		/* An empty repo's clone has an unborn HEAD whose name git guessed. */
		if (revParse(clone, "HEAD") === null)
			git(clone, ["symbolic-ref", "HEAD", "refs/heads/main"]);
	}

	/** @type {Step} */
	const step = { inp, clone, env, dry, noInstall };
	const src = pre.source;
	let base = null;
	if (src) {
		at.step = "source repo";
		base = copySource(step, src);
	}

	at.step = "bashrc";
	const aliases = launchAliases(inp, dry);

	/** @type {string[]} */
	let making = [];
	if (src) {
		at.step = "set aside";
		making = setAside(step, base, src);
	}

	at.step = "init-adopter";
	initAdopter(step, pre);

	if (src) {
		at.step = "gitignore";
		gitignore(step, src, [...new Set([...asideIn(clone), ...making])]);
		at.step = "source docs";
		sourceDocs(inp, clone, env, dry);
	}

	at.step = "first map";
	const map = firstMap(step, pre.repoExists);

	at.step = "project";
	projectSection(inp, clone, map, dry);

	at.step = "plugin reads";
	pluginReads(clone, dry);

	at.step = "commit";
	const committing = skeletonCommit(step, pre, map, resumeCmd);

	at.step = "push";
	push(step, committing);

	if (src) {
		at.step = "reconcile";
		reconcile(step, map, base, src);
	}
	return { map, aliases };
}

/** @param {string[]} argv */
function main(argv) {
	let parsed;
	try {
		parsed = parse(argv);
	} catch (e) {
		writeFd(
			2,
			`new-repo: ${e instanceof Error ? e.message : String(e)}\n${USAGE}\n`,
		);
		return 2;
	}
	const { resume, given, noInstall } = parsed;
	const name = resume ?? /** @type {string} */ (given.name);
	const clone = path.join(os.homedir(), name);
	const resumeCmd = `node ${SELF} --resume ${name}${noInstall ? " --no-plugin-install" : ""}`;
	const rerunCommand = () =>
		fs.existsSync(recordPath(clone))
			? resumeCmd
			: `node ${SELF} ${argv
					.filter((a) => a !== "--dry-run")
					.map(shellQuote)
					.join(" ")}`;
	/** @type {NodeJS.ProcessEnv} */
	const env = { ...process.env, CLAUDE_PROJECT_DIR: clone };
	const at = { step: "preflight" };
	try {
		const inp = resolveInputs(resume, given, name, readSavedInputs(clone));
		const pre = preflight(inp, clone);
		report("preflight", "done", `core ${pre.tag}`);
		const dry = parsed.dryRun;
		const { map, aliases } = steps(inp, pre, clone, {
			env,
			noInstall,
			resumeCmd,
			dry,
			at,
		});
		if (dry) return 0;

		printFirstSession(inp, clone, map, aliases);
		return 0;
	} catch (e) {
		return reportStop(at.step, e, rerunCommand);
	}
}

/**
 * How the founder opens the new repo's first session. A core checkout first
 * needs its self-plugin set up, or its canary refuses that session (#2440).
 * @param {Inputs} inp
 * @param {string} clone
 * @param {number|null} map
 * @param {string} aliases the block ~/.bashrc holds
 */
function printFirstSession(inp, clone, map, aliases) {
	out("");
	if (isCoreRoot(clone)) {
		out("This is a workflow-core checkout. Once per machine, first run:");
		out(selfPluginSetup(clone));
		out("");
	}
	const alias = `${inp.prefix}${planDigit()}`;
	/* A block kept as found may not define the alias this run would name. */
	out(
		aliases.split("\n").some((l) => l.startsWith(`alias ${alias}=`))
			? `Open a new terminal tab and run: ${alias}`
			: `Open a new terminal tab and start a session in ~/${inp.name}: the kept ~/.bashrc block defines no ${alias}`,
	);
	out("Then paste this as the first prompt:");
	out("");
	out(buildFirstPrompt(/** @type {number} */ (map)));
}

/**
 * Reports the step a run stopped at, and how to carry on.
 * @param {string} step
 * @param {unknown} e
 * @param {() => string} rerunCommand
 * @returns {number} the exit code
 */
function reportStop(step, e, rerunCommand) {
	const stop =
		e instanceof Stop
			? e
			: new Stop(e instanceof Error ? parseErrLine(e) : String(e), {
					code: 1,
					cause: e,
				});
	report(step, "STOPPED", stop.message);
	if (stop.output) out(stop.output.trimEnd());
	out("");
	if (stop.code === 2 && stop.manual) out(`Manual step: ${stop.manual}`);
	out(
		stop.fresh
			? "Then start again: /new-repo"
			: `${stop.code === 2 ? "Then re-run" : "Re-run"}: ${rerunCommand()}`,
	);
	return stop.code;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
