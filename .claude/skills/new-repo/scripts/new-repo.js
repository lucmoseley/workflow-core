#!/usr/bin/env node

const { spawnSync } = require("node:child_process");
const { findFiledLine } = require("../../../../scripts/lib/filed-line.js");
const {
	buildScriptFilerArgv,
} = require("../../../../scripts/lib/script-filer-argv.js");
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
	ISSUE_LIST_LIMIT,
} = require("../../../../scripts/lib/gh.js");
const {
	initPaths,
	readManifestMarketplaceName,
} = require("../../../../scripts/lib/init-adopter-core.js");
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
const OWNER = "lucmoseley";
const RECORD = "new-repo.json";
const MAP_LABEL = "wayfinder:map";
const MAP_LABELS = [MAP_LABEL, "takes:wayfinder"];
const SKIPPED = "skipped — already done";
const INIT_PATHS = initPaths([]);
const ASIDE = [
	{ from: "CLAUDE.md", to: "docs/source/CLAUDE.source.md", instructions: true },
	{ from: "AGENTS.md", to: "docs/source/AGENTS.source.md", instructions: true },
	{
		from: ".husky/pre-commit",
		to: ".husky/pre-commit.local",
		instructions: false,
	},
];
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
       node ${SELF} --resume <repo> [--no-plugin-install] [--dry-run]
exits 0 finished / 1 stopped, a plain re-run should finish it / 2 refused until the founder acts by hand`;

class Stop extends Error {
	/**
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
 *   source: string|null}} Inputs
 */

/**
 * @typedef {{inp: Inputs, clone: string, env: NodeJS.ProcessEnv, dry: boolean,
 *   noInstall: boolean}} Step
 */

const NAME_SHAPE = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;

/**
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

/** @param {string[]} argv */
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
 * @param {NodeJS.ProcessEnv} [env]
 */
const git = (cwd, args, input, env) =>
	execGit(args, {
		cwd,
		encoding: "utf8",
		input,
		env,
		stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
	}).trim();

/**
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
	if (!tag)
		throw new Stop(
			`${UPSTREAM_CODE_REPO} has no vX.Y.Z release tag on GitHub, and the core is only ever pinned to one`,
			{ code: 2, manual: "cut a workflow-core release first" },
		);
	return tag;
}

/** @param {Inputs} inp */
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

const KEEP_OPEN =
	"# --- workflow-core: keep the core's files trackable (new-repo.js) ---";
const KEEP_CLOSE = "# --- end workflow-core block ---";

/**
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
		if (!pattern.startsWith("!"))
			found.set(
				requiredGroup(m, 4, shape),
				`${requiredGroup(m, 1, shape)}:${requiredGroup(m, 2, shape)} ("${pattern}")`,
			);
	}
	return found;
}

/**
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

/** @param {Map<string, string>} stuck */
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
		const modules = readCopiedModules(tree);
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
 * @param {string} tree
 * @returns {string[]}
 */
function readCopiedModules(tree) {
	try {
		return readSubjectModules(tree);
	} catch (e) {
		throw new Stop(parseErrLine(e), { code: 1, cause: e });
	}
}

/**
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
 * @param {Step} step
 * @param {Source} src
 * @returns {string|null}
 */
function copySource({ inp, clone, env, dry }, src) {
	const base = dry ? readCopiedBase(clone, src) : fetchSource(inp, clone, src);
	const tags = base === null ? null : readUnsentTags(clone, dry);
	if (src.copied && tags?.length === 0)
		report("source repo", SKIPPED, `${inp.source}'s ${src.branch} is main`);
	else if (dry)
		report(
			"source repo",
			"would",
			`make ${inp.source}'s ${src.branch} main, pushed with the skeleton commit; push its tags to ${inp.repo}; upstream fetch-only`,
		);
	else {
		const sent = /** @type {string[]} */ (tags);
		if (sent.length > 0) {
			const r = runGit(clone, ["push", "-q", "origin", ...sent], env);
			if (r.status !== 0)
				throw new Stop("the push of the source repo's tags was rejected", {
					code: 2,
					output: r.output,
					manual: `read the rejection above and settle it in ~/${inp.name}`,
				});
		}
		report(
			"source repo",
			"done",
			[
				`${inp.source}'s ${src.branch} is main`,
				...(sent.length > 0 ? [`${sent.length} tags pushed`] : []),
				"upstream fetch-only",
			].join(", "),
		);
	}
	sourceFacts(inp, src);
	return base;
}

/**
 * @param {Inputs} inp
 * @param {string} clone
 * @param {Source} src
 * @returns {string}
 */
function fetchSource(inp, clone, src) {
	const url = `https://github.com/${inp.source}.git`;
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
 * @param {string} clone
 * @param {boolean} dry
 */
function readUnsentTags(clone, dry) {
	const origin = readRemoteRefs(clone, "origin");
	const tags = new Set([
		...git(clone, ["for-each-ref", "--format=%(refname)", "refs/tags"]).split(
			"\n",
		),
		...(dry ? readRemoteRefs(clone, "upstream").keys() : []),
	]);
	return [...tags].filter(
		(ref) => ref.startsWith("refs/tags/") && !origin.has(ref),
	);
}

/**
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

const present = (/** @type {string} */ file) => {
	try {
		fs.lstatSync(file);
		return true;
	} catch {
		return false;
	}
};

/**
 * @param {Step} step
 * @param {string|null} base
 * @param {Source} src
 * @returns {string[]}
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
 * @typedef {{done: string[], changed: string[], repairs: string[],
 *   acts: (() => void)[], made: string[]}} AsideMoves
 */

/**
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

const SHELL_DIRECTIVE = "# shellcheck shell=sh\n";

/** @param {Buffer} bytes */
function hasShellName(bytes) {
	const text = bytes.toString("latin1");
	const head = /^(?:[ \t]*(?:#.*)?\n)*/.exec(text)?.[0] ?? "";
	return text.startsWith("#!") || /^#\s*shellcheck\s.*\bshell=/m.test(head);
}

/**
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
 * @typedef {{clone: string, from: string, was: {mode: string, blob: string},
 *   target: string|null, hook: boolean}} Held
 */

/**
 * @param {{inp: Inputs, clone: string, source: Map<string, {mode: string, blob: string}>}} ctx
 * @param {(typeof ASIDE)[number]} entry
 * @param {AsideMoves} moves
 */
function planAsideMove({ inp, clone, source }, entry, moves) {
	const { from, to, instructions } = entry;
	const was = source.get(from);
	if (!was) return;
	const target =
		was.mode === GIT_MODE.symlink
			? git(clone, ["cat-file", "blob", was.blob])
			: null;
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
 * @param {Inputs} inp
 * @param {Held} held
 * @param {(typeof ASIDE)[number]} entry
 * @param {AsideMoves} moves
 * @returns {boolean}
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
 * @param {boolean} dry
 * @param {AsideMoves} moves
 * @param {number} sourceSize
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

const asideIn = (/** @type {string} */ clone) =>
	ASIDE.map((m) => m.to).filter((p) => fs.existsSync(path.join(clone, p)));

/**
 * @param {Step} step
 * @param {Source} src
 * @param {string[]} aside
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
 * @param {string} clone
 * @param {NodeJS.ProcessEnv} env
 * @param {{slug: string, noun: string, title: string, labels: string[],
 *   place: import("../../../../scripts/lib/script-filer-argv.js").Placement,
 *   body: string, manual: string}} issue
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
			...buildScriptFilerArgv({
				title,
				labels,
				placement: place,
				origin: "wayfinder",
				bodyFile,
			}),
		],
		filerEnv,
	);
	const n = findFiledLine(filed.output)?.n;
	if (filed.status !== 0 || n === undefined)
		throw new Stop(`file-issue.js did not file ${noun}`, {
			code: filed.status === 2 ? 2 : 1,
			output: filed.output,
			manual,
		});
	return n;
}

/**
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
 * @param {boolean} repoExists
 * @returns {number|null}
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
			place: { standalone: "the new repo's first map, filed by new-repo.js" },
			body: buildMapBody(inp, null),
			manual:
				"file-issue.js refused the map as above — fix the idea or title file it names",
		});
	const dups = found?.dups ?? [];
	const body = found?.body ?? readMapBody(inp, map);
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
 * @param {{inp: Inputs, clone: string, map: number}} at
 * @param {string} body
 */
function writeMapPrompt({ inp, clone, map }, body) {
	const bodyFile = path.join(clone, ".git", "new-repo-map.md");
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
 * @param {Inputs} inp
 * @param {number} map
 * @returns {{kept: number, dups: number[], linked: boolean}|null}
 */
function reconcileState(inp, map) {
	const title = buildReconcileTitle(inp);
	/** @type {{number: number, title: string, state: string}[]} */
	const children = ghApiSlurp([`repos/${inp.repo}/issues/${map}/sub_issues`]);
	/** @type {Map<number, string>} */
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
 * @param {Step} step
 * @param {number|null} map
 * @param {string|null} base
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
	if (map === null)
		throw new Error("new-repo.js: no first map outside a dry run");
	const n = fileIssue(clone, env, {
		slug: "reconcile",
		noun: "the reconcile ticket",
		title: buildReconcileTitle(inp),
		labels: RECONCILE_LABELS,
		place: { parent: map },
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

const ONE_LINER_SLOT = "<one line: what it is and who it is for>";
const STATE_SLOT = "State: <pre-launch / live / …>.";

/**
 * @param {Inputs} inp
 * @param {number} map
 */
const buildStateLine = (inp, map) =>
	`State: pre-launch — the way is being charted on #${map} (${inp.title}).`;

/**
 * @param {Inputs} inp
 * @param {string} clone
 * @param {number|null} map
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

/** @param {string} clone */
function readSkeletonState(clone) {
	const spec = [
		...skeletonPaths((h) => fs.existsSync(path.join(clone, h))),
		...(readHiddenPaths(clone, [LOCAL_SETTINGS]).size > 0
			? []
			: [`:(exclude)${LOCAL_SETTINGS}`]),
	];
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
		return true;
	}
	return (
		hook !== renderHookShim("pre-commit").trimEnd() ||
		Boolean(readSkeletonState(clone).dirty) ||
		initChangesHead(inp, pre, clone)
	);
}

/**
 * @param {Inputs} inp
 * @param {Preflight} pre
 * @param {string} clone
 */
function initChangesHead(inp, pre, clone) {
	const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "new-repo-render-"));
	try {
		const tree = path.join(scratch, inp.name);
		git(scratch, ["clone", "-q", "--shared", clone, tree]);
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
		return r.status !== 0 || Boolean(readSkeletonState(tree).dirty);
	} finally {
		fs.rmSync(scratch, { recursive: true, force: true });
	}
}

/**
 * @param {Step} step
 * @param {Preflight} pre
 * @param {number|null} map
 * @param {string} resumeCmd
 * @returns {boolean}
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
	const message = [
		"-m",
		`Start ${inp.name} on the workflow core`,
		"-m",
		`Its first session charts #${map} under the core's rules. The adopted skeleton, pinned to workflow-core ${pre.tag}, written by new-repo.js.`,
	];
	const hookEnv = noInstall ? { ...env, WORKFLOW_CORE_DIR: CORE } : env;
	const beside =
		revParse(clone, "HEAD") !== null && readOriginMain(clone, false) === null;
	let r;
	if (beside) r = commitBeside(clone, spec, message, hookEnv);
	else {
		const add = runGit(clone, ["add", "-N", "--", ...spec], env);
		if (add.status !== 0)
			throw new Stop("git add refused the skeleton paths", {
				code: 2,
				output: add.output,
				manual,
			});
		r = runGit(clone, ["commit", "-q", ...message, "--", ...spec], hookEnv);
	}
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
 * @param {string} clone
 * @param {string[]} spec
 * @param {string[]} message
 * @param {NodeJS.ProcessEnv} env
 * @returns {{status: number, output: string}}
 */
function commitBeside(clone, spec, message, env) {
	const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "new-repo-commit-"));
	const tree = path.join(scratch, "tree");
	let added = false;
	try {
		const indexEnv = {
			...process.env,
			GIT_INDEX_FILE: path.join(scratch, "index"),
		};
		git(clone, ["read-tree", "HEAD"], undefined, indexEnv);
		git(clone, ["add", "-A", "--", ...spec], undefined, indexEnv);
		const skeletonTree = git(clone, ["write-tree"], undefined, indexEnv);
		const headSha = git(clone, ["rev-parse", "HEAD"]);
		git(clone, ["worktree", "add", "-q", "--detach", tree, headSha]);
		added = true;
		git(tree, ["read-tree", "-u", "--reset", skeletonTree]);
		const r = runGit(tree, ["commit", "-q", ...message], {
			...env,
			CLAUDE_PROJECT_DIR: tree,
		});
		if (r.status !== 0) return r;
		const skeletonSha = git(tree, ["rev-parse", "HEAD"]);
		git(clone, ["update-ref", "refs/heads/main", skeletonSha, headSha]);
		git(clone, ["reset", "-q"]);
		return r;
	} finally {
		if (added)
			spawnGitSync(["worktree", "remove", "--force", tree], { cwd: clone });
		fs.rmSync(scratch, { recursive: true, force: true });
		spawnGitSync(["worktree", "prune"], { cwd: clone });
	}
}

/**
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
 * @param {boolean} committing
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

const PLANS = ["", "2", "3"];

const bashrcPath = () => path.join(os.homedir(), ".bashrc");

/** @param {string} name */
const markers = (name) => ({
	open: `# --- ${name}, one alias per plan ---`,
	close: `# --- end ${name} block ---`,
});

/** @param {Inputs} inp */
function buildLaunchBlock(inp) {
	const aliases = PLANS.map(
		(d, i) =>
			`alias ${inp.prefix}${i + 1}='(cd ~/${inp.name} && CLAUDE_CONFIG_DIR=$HOME/.claude${d} claude agents)'`,
	);
	const { open, close } = markers(inp.name);
	return [open, ...aliases, close].join("\n");
}

/**
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

function bashrcSyntax() {
	if (!fs.existsSync(bashrcPath())) return null;
	const r = runChild(os.homedir(), ["bash", "-n", bashrcPath()], process.env);
	return r.status === 0 ? null : r.output;
}

/** @param {Inputs} inp */
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
 * @param {{inp: Inputs, file: string, found: {text: string, start: number, end: number}, block: string}} at
 * @returns {string}
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

/** @param {string} text */
function blockLead(text) {
	if (text === "" || text.endsWith("\n\n")) return "";
	if (text.endsWith("\n")) return "\n";
	return "\n\n";
}

/**
 * @param {Inputs} inp
 * @param {boolean} dryRun
 * @returns {string}
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

function planDigit() {
	const dir = path.basename(process.env.CLAUDE_CONFIG_DIR ?? ".claude");
	return /^\.claude([23])$/.exec(dir)?.[1] ?? "1";
}

/**
 * @typedef {{tag: string, founder: string, repoExists: boolean,
 *   cloneExists: boolean, source: Source|null, modules: string[]}} Preflight
 */

/** @param {string} tag */
const pluginRoot = (tag) =>
	installPathFor(
		undefined,
		readManifestMarketplaceName(CORE) ?? "workflow-core",
		"workflow-core",
		tag,
	);

/**
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
 * @param {Inputs} inp
 * @param {Preflight} pre
 * @param {string} clone
 * @param {{env: NodeJS.ProcessEnv, noInstall: boolean, resumeCmd: string,
 *   dry: boolean, at: {step: string}}} run
 * @returns {{map: number|null, aliases: string}}
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
			`gh repo clone ${inp.repo} ${shellQuote(clone)}, saving the inputs to .git/${RECORD}`,
		);
	else {
		gh(["repo", "clone", inp.repo, clone]);
		report(at.step, "done", `~/${inp.name}`);
	}
	if (!dry) {
		if (!fs.existsSync(recordPath(clone)))
			fs.writeFileSync(recordPath(clone), `${JSON.stringify(inp, null, 2)}\n`);
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
 * @param {Inputs} inp
 * @param {string} clone
 * @param {number|null} map
 * @param {string} aliases
 */
function printFirstSession(inp, clone, map, aliases) {
	out("");
	if (isCoreRoot(clone)) {
		out("This is a workflow-core checkout. Once per machine, first run:");
		out(selfPluginSetup(clone));
		out("");
	}
	const alias = `${inp.prefix}${planDigit()}`;
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
 * @param {string} step
 * @param {unknown} e
 * @param {() => string} rerunCommand
 * @returns {number}
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
