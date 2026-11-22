const { SELF_PLUGIN_HOOKS } = require("./core-hooks.js");
const { registeredGuards } = require("./guard-fires.js");
const { CORPUS_DIRS } = require("./needle-corpus.js");
const {
	HOST_NEEDLES,
	HOST_REGISTRATIONS,
	allRegistrations,
	buildCommandLine,
	isPinnedBy,
	spellSiblingTestsIfUntested,
} = require("./registrations.js");
const {
	parseCommand,
	unsetText,
	walkCommands,
	walkGit,
} = require("./shell-parse.js");
const {
	commitPathsArgs,
	commitPathsParse,
	literal,
	scanFlags,
} = require("./shell-words.js");
const { JS_TEST_FILE } = require("./test-kind.js");
const { isUnder, relativeUnder } = require("./is-under.js");

const HOST_SETTINGS = ".claude/settings.json";

const COMMIT_VALUE_FLAGS =
	"-m --message -F --file -c --reedit-message -C --reuse-message --fixup --squash --author --date --cleanup -t --template -S --gpg-sign --pathspec-from-file";

const CALLER_HOOKS = [
	"pre-commit",
	"prepare-commit-msg",
	"commit-msg",
	"pre-merge-commit",
	"post-commit",
	"pre-push",
];

const WHY =
	"Why this is a refusal and not a warning: a repo-wide registry invariant is false for EVERY session while the split is open, not just for yours, so no session can obtain a whole-suite certificate at any price until it closes (mantahostels#2664, mantahostels#2671).";

/**
 * @typedef {object} Repo
 * @property {(spec: string) => string[] | null} lsCached
 * @property {(spec: string) => string[] | null} lsOthers
 * @property {(spec: string) => string[] | null} stagedDeletions
 * @property {() => string[] | null} staged
 * @property {(rel: string) => boolean | null} headNames
 * @property {(rel: string) => string | null} headShow
 * @property {(rel: string) => boolean | null} indexNames
 * @property {(rel: string) => string | null} indexShow
 * @property {(rel: string) => boolean} exists
 * @property {(rel: string) => boolean} isFile
 * @property {(rel: string) => string | null} read
 * @property {(rel: string) => string[]} list
 */

/**
 * @typedef {object} RegistryPorts
 * @property {(dir: string) => { root: string | null, midSequence: boolean }}
 *   place
 * @property {(tree: string, root: string) => Repo} repo
 * @property {(dir: string, patch: string) => Map<string, string | null> | null}
 *   patchBodies
 * @property {(args: { repo: Repo, root: string, landing: string[],
 *   readLanding: ((rel: string) => string | null) | null }) =>
 *   { broken: NeedleBreak[] } | { failOpen: string }} needleDrift
 * @property {() => string | null} pluginNeedles
 * @property {string} pluginScripts
 * @typedef {{ arriving: boolean, key: string, id: string, text: string }}
 *   NeedleBreak
 * @typedef {import("./kit-context.js").KitContext & RegistryPorts} RegistryContext
 */

/**
 * @param {string} command
 * @param {RegistryContext} ctx
 * @returns {import("./guard-entry.js").Decision}
 */
function decide(command, ctx) {
	const parsed = parseCommand(command);
	let refusal = "";
	walkGit(
		parsed,
		({ tree, args, emptyVars }) => {
			const spec = readCommit(args);
			refusal += judgeCommit(tree, { ...spec, literalPaths: false }, ctx, {
				spans: parsed.spans,
				unset: unsetText(emptyVars),
			});
		},
		ctx,
		{
			subs: ["commit"],
			noun: "commit",
			scope: "repo",
			emptyUnset: true,
			unwrap: true,
		},
	);
	walkCommands(
		parsed,
		({ words, cwd }) => {
			refusal += judgeCommitPaths(words, cwd, parsed.spans, ctx);
		},
		ctx,
	);
	if (!refusal) return null;
	return { deny: ctx.corePaths(`${refusal.replace(/\n\n$/, "")}\n\n${WHY}`) };
}

/** @param {string[]} args */
function readCommit(args) {
	let hasPathspec = false;
	let hasAll = false;
	/** @type {string[]} */
	const words = [];
	scanFlags(COMMIT_VALUE_FLAGS, args, (kind, flag, value) => {
		if (
			(kind === "opt" || kind === "dangling") &&
			flag === "--pathspec-from-file"
		)
			hasPathspec = true;
		else if (kind === "flag" && flag === "-") hasPathspec = true;
		else if (kind === "flag" && (flag === "-a" || flag === "--all"))
			hasAll = true;
		else if (kind === "arg") {
			hasPathspec = true;
			words.push(value);
		}
	});
	return { words, hasPathspec, hasAll };
}

/**
 * @param {string[]} words
 * @param {string} cwd
 * @param {string[]} spans
 * @param {RegistryContext} ctx
 */
function judgeCommitPaths(words, cwd, spans, ctx) {
	for (const args of commitPathsArgs(words, spans)) {
		const reason = judgeCommitPathsRun(args, cwd, spans, ctx);
		if (reason) return reason;
	}
	return "";
}

/**
 * @param {string[]} args
 * @param {string} cwd
 * @param {string[]} spans
 * @param {RegistryContext} ctx
 */
function judgeCommitPathsRun(args, cwd, spans, ctx) {
	const call = commitPathsParse(args, spans);
	if (!call || call.tree) return "";
	const paths = [...call.paths];
	if (paths.length === 0 && !call.patch) return "";
	if (!cwd) {
		ctx.log(
			"could not resolve the directory a commit-paths.js call runs in — that commit was allowed unchecked",
		);
		return "";
	}
	const cls = ctx.treeClass(cwd);
	if (cls === "unknown") {
		ctx.log(
			`git could not say which tree ${cwd} is — that commit-paths.js commit was allowed unchecked`,
		);
		return "";
	}
	if (cls !== "shared" && cls !== "linked") return "";
	/** @type {Map<string, string | null> | undefined} */
	let patch;
	if (call.patch) {
		const file = literal(call.patch, spans);
		const bodies = file.known ? ctx.patchBodies(cwd, file.text) : null;
		if (bodies) patch = bodies;
		else
			ctx.log(
				`could not read the --patch file of a commit-paths.js call in ${cwd}, or apply it to HEAD — the files it carries were left unjudged`,
			);
	}
	return judgeCommit(
		cwd,
		{
			words: paths,
			hasPathspec: true,
			hasAll: false,
			literalPaths: true,
			patch,
		},
		ctx,
		{ spans, unset: "" },
	);
}

/**
 * @typedef {object} CommitSpec
 * @property {string[]} words
 * @property {boolean} hasPathspec
 * @property {boolean} hasAll
 * @property {boolean} literalPaths
 * @property {Map<string, string | null>} [patch]
 */

/**
 * @param {string} dir
 * @param {CommitSpec} spec
 * @param {RegistryContext} ctx
 * @param {{ spans: string[], unset: string }} at
 */
function judgeCommit(dir, spec, ctx, at) {
	const { root, midSequence } = ctx.place(dir);
	if (midSequence) return "";
	if (root === null) {
		ctx.log(
			`could not resolve the top level of ${dir} — that commit was allowed unchecked`,
		);
		return "";
	}
	const named = ctx.repo(dir, root);
	const { landing, overlay } = landingOf({
		dir,
		spec,
		repo: named,
		ctx,
		spans: at.spans,
		root,
	});
	if (landing === null || landing.length === 0) return "";
	const view = commitView({
		dir,
		root,
		repo: overlay ? patchedRepo(named, overlay) : named,
		landing,
		landsFrom: landsFromOf(spec, overlay),
		ctx,
	});

	/** @type {Set<string>} */
	const reported = new Set();
	let out = landing.map((p) => judgePath(p, view, reported)).join("");
	if (view.inLanding(SELF_PLUGIN_HOOKS) || view.inLanding(HOST_SETTINGS)) {
		const { regFile } = view.registries();
		if (view.inLanding(regFile)) out += judgeHookList(reported, view);
	}
	if (out) out += hostTail(view);
	out += judgeNeedleText(view);
	return out ? at.unset + out : "";
}

/**
 * @param {string} p
 * @param {View} view
 * @param {Set<string>} reported
 */
function judgePath(p, view, reported) {
	const { dir, ctx } = view;
	const base = p.replace(/^scripts\//, "");
	const inHead = view.repo.headNames(p);
	if (inHead === null) {
		ctx.log(
			`git could not read HEAD's tree for ${p} in ${dir} — that path was left unjudged and the commit allowed unchecked`,
		);
		return "";
	}
	if (inHead) {
		const kept = view.landingExists(p);
		if (kept === null)
			ctx.log(
				`git could not read the index entry for ${p} in ${dir} — that path was left unjudged and the commit allowed unchecked`,
			);
		if (kept !== false || JS_TEST_FILE.test(p) || !isChecker(p)) return "";
		return judgeCheckerRemoval(base, view);
	}
	if (JS_TEST_FILE.test(p)) return "";
	if (isChecker(p)) return judgeChecker(base, view);
	if (!/^scripts\/guard-.*\.(sh|js)$/.test(p)) return "";
	reported.add(base);
	return judgeGuard(base, view);
}

/** @param {string} p */
const isChecker = (p) => /^scripts\/check-.*\.js$/.test(p);

/**
 * @param {LandingAt} at
 * @returns {string[] | null}
 */
function landingPaths(at) {
	const { dir, spec, repo, ctx } = at;
	if (!spec.hasPathspec) {
		const staged = repo.staged();
		if (staged === null)
			ctx.log(
				`git could not read the staged path list in ${dir} — that commit was allowed unchecked`,
			);
		return staged;
	}
	return spec.words.flatMap((word) => wordPaths(word, at));
}

/**
 * @typedef {{ dir: string, spec: CommitSpec, repo: Repo,
 *   ctx: RegistryContext, spans: string[] }} LandingAt
 */

/**
 * @param {LandingAt & { root: string }} at
 * @returns {{ landing: string[] | null,
 *   overlay: Map<string, string | null> | null }}
 */
function landingOf(at) {
	const { spec, root } = at;
	const { patch } = spec;
	if (!patch) return { landing: landingPaths(at), overlay: null };
	const whole = landingPaths({
		...at,
		spec: { ...spec, words: spec.words.filter((w) => !patch.has(w)) },
	});
	const fromPatch = landingPaths({
		...at,
		spec: { ...spec, words: [...patch.keys()] },
	});
	const kept = new Set(whole);
	/** @type {Map<string, string | null>} */
	const overlay = new Map();
	for (const [file, body] of patch) {
		const rel = relativeUnder(root, file);
		if (rel && !kept.has(rel)) overlay.set(rel, body);
	}
	return {
		landing: [...new Set([...(whole ?? []), ...(fromPatch ?? [])])],
		overlay,
	};
}

/** @typedef {"index" | "worktree" | "patch"} LandsFrom */

/**
 * @param {CommitSpec} spec
 * @param {Map<string, string | null> | null} overlay
 * @returns {LandsFrom}
 */
function landsFromOf(spec, overlay) {
	if (overlay) return "patch";
	return !spec.hasPathspec && !spec.hasAll ? "index" : "worktree";
}

/**
 * @param {Repo} repo
 * @param {Map<string, string | null>} overlay
 * @returns {Repo}
 */
function patchedRepo(repo, overlay) {
	/** @param {string} rel */
	const body = (rel) => overlay.get(rel) ?? null;
	return {
		...repo,
		exists: (rel) => (overlay.has(rel) ? body(rel) !== null : repo.exists(rel)),
		isFile: (rel) => (overlay.has(rel) ? body(rel) !== null : repo.isFile(rel)),
		read: (rel) => (overlay.has(rel) ? body(rel) : repo.read(rel)),
	};
}

/**
 * @param {string} word
 * @param {LandingAt} at
 * @returns {string[]}
 */
function wordPaths(word, { dir, spec, repo, ctx, spans }) {
	const lit = literal(word, spans);
	if (!lit.known || !lit.text) return [];
	const abs = lit.text.startsWith("/") ? lit.text : `${dir}/${lit.text}`;
	const pathspec = spec.literalPaths ? `:(literal)${abs}` : abs;
	let listed = repo.lsCached(pathspec);
	if (listed === null) {
		ctx.log(
			`git could not list tracked files under ${abs} in ${dir} — that pathspec word was left unjudged for mantahostels#2671`,
		);
		return [];
	}
	if (spec.literalPaths && listed.length === 0 && repo.isFile(abs)) {
		const others = repo.lsOthers(pathspec);
		if (others === null)
			ctx.log(
				`git could not list untracked files under ${abs} in ${dir} — that commit-paths.js path was left unjudged`,
			);
		else listed = others;
	}
	const deleted = repo.stagedDeletions(pathspec);
	if (deleted === null)
		ctx.log(
			`git could not read the staged deletions under ${abs} in ${dir} — a member this commit removes may have gone unjudged`,
		);
	return [...listed, ...(deleted ?? [])];
}

/**
 * @typedef {object} Registries
 * @property {string} hookReg
 * @property {string} checkerReg
 * @property {string} needleReg
 * @property {string} regFile
 */

/**
 * @param {{ dir: string, root: string, repo: Repo, landing: string[],
 *   landsFrom: LandsFrom, ctx: RegistryContext }} at
 */
function commitView({ dir, root, repo, landing, landsFrom, ctx }) {
	const bare = landsFrom === "index";
	const lands = new Set(landing);
	const inLanding = (/** @type {string} */ rel) => lands.has(rel);
	const log = ctx.log;

	/** @param {string} rel @returns {boolean | null} */
	const landingExists = (rel) =>
		bare ? repo.indexNames(rel) : repo.exists(rel);

	/**
	 * @param {string} rel
	 * @returns {string | null | undefined}
	 */
	const landingBody = (rel) => {
		if (bare) {
			const named = repo.indexNames(rel);
			if (named === null) return;
			if (!named) return null;
			return repo.indexShow(rel) ?? undefined;
		}
		if (!repo.exists(rel)) return null;
		return repo.read(rel) ?? undefined;
	};

	const readLanding =
		landsFrom === "worktree"
			? null
			: (/** @type {string} */ rel) => {
					const body = landingBody(rel);
					if (body === undefined)
						throw new Error(
							`could not read the copy of ${rel} this commit lands`,
						);
					return body;
				};

	/**
	 * @param {string} rel
	 * @returns {string | null | undefined}
	 */
	const headBody = (rel) => {
		const named = repo.headNames(rel);
		if (named === null) return;
		if (!named) return null;
		return repo.headShow(rel) ?? undefined;
	};

	/** @param {string} rel */
	const willBody = (rel) => (inLanding(rel) ? landingBody(rel) : headBody(rel));

	/**
	 * @param {string} rel
	 * @param {string} lit
	 */
	const willHold = (rel, lit) => {
		if (inLanding(rel)) {
			const body = landingBody(rel);
			if (body !== undefined) return body?.includes(lit);
			log(
				`could not read the copy of ${rel} this commit lands in ${dir} — that wiring requirement was treated as met and the commit allowed unchecked`,
			);
			return true;
		}
		const named = repo.headNames(rel);
		if (named === false) return false;
		if (named === null) {
			log(
				`git could not read HEAD's tree for ${rel} in ${dir} — that wiring requirement was treated as met and the commit allowed unchecked`,
			);
			return true;
		}
		const body = repo.headShow(rel);
		if (body === null) {
			log(
				`git could not show HEAD:${rel} in ${dir} — that wiring requirement was treated as met and the commit allowed unchecked`,
			);
			return true;
		}
		return body.includes(lit);
	};

	/**
	 * @param {string} rel
	 * @param {string} lit
	 */
	const willSurelyHold = (rel, lit) => {
		if (inLanding(rel)) {
			const body = landingBody(rel);
			if (body !== undefined) return body?.includes(lit);
			log(
				`could not read the copy of ${rel} this commit lands in ${dir} — that registry was read as no longer naming the member, and the commit allowed unchecked`,
			);
			return false;
		}
		const named = repo.headNames(rel);
		if (named === null)
			log(
				`git could not read HEAD's tree for ${rel} in ${dir} — that registry was read as no longer naming the member, and the commit allowed unchecked`,
			);
		if (!named) return false;
		return repo.headShow(rel)?.includes(lit) ?? false;
	};

	/** @param {string} rel */
	const willExist = (rel) => {
		if (inLanding(rel)) {
			const kept = landingExists(rel);
			if (kept !== null) return kept;
			log(
				`git could not read the index entry for ${rel} in ${dir} — that sibling test was treated as present and the commit allowed unchecked`,
			);
			return true;
		}
		const named = repo.headNames(rel);
		if (named !== null) return named;
		log(
			`git could not read HEAD's tree for ${rel} in ${dir} — that sibling test was treated as present and the commit allowed unchecked`,
		);
		return true;
	};

	/** @param {string} rel */
	const willCarry = (rel) =>
		(inLanding(rel) ? landingExists(rel) : repo.headNames(rel)) !== false;

	/** @type {Registries | null} */
	let regs = null;
	const registries = () => {
		if (regs) return regs;
		const regFile =
			willCarry(SELF_PLUGIN_HOOKS) ||
			repo.headNames(SELF_PLUGIN_HOOKS) !== false
				? SELF_PLUGIN_HOOKS
				: HOST_SETTINGS;
		const pick = (/** @type {string} */ core, /** @type {string} */ own) =>
			willCarry(core) ? core : own;
		regs = {
			regFile,
			hookReg: pick("scripts/hook-registrations.test.ts", HOST_REGISTRATIONS),
			checkerReg: pick(
				"scripts/checker-registrations.test.ts",
				HOST_REGISTRATIONS,
			),
			needleReg: pick("scripts/guard-fire-needles.json", HOST_NEEDLES),
		};
		return regs;
	};

	/** @type {HostFacts | null | undefined} */
	let host;
	const readHostFacts = () => {
		if (host === undefined) host = readHost(willBody, dir, log);
		return host;
	};

	return {
		dir,
		root,
		repo,
		landing,
		landsFrom,
		ctx,
		inLanding,
		landingExists,
		landingBody,
		readLanding,
		willHold,
		willSurelyHold,
		willExist,
		willCarry,
		registries,
		readHostFacts,
	};
}

/** @typedef {ReturnType<typeof commitView>} View */

/**
 * @typedef {object} HostFacts
 * @property {Set<string>} registeredElsewhere
 * @property {Set<string>} calledElsewhere
 * @property {string[]} ids
 * @property {Set<string>} events
 * @property {Map<string, boolean>} pinned
 */

/**
 * @param {(rel: string) => string | null | undefined} willBody
 * @param {string} dir
 * @param {(what: string) => void} log
 * @returns {HostFacts | null}
 */
function readHost(willBody, dir, log) {
	const unparsed = `could not parse the ${HOST_REGISTRATIONS} or ${HOST_SETTINGS} this commit leaves in ${dir} — every ${HOST_REGISTRATIONS} entry was judged unknown`;
	/** @type {Record<string, unknown>[]} */
	const files = [];
	for (const f of [HOST_REGISTRATIONS, HOST_SETTINGS]) {
		const body = willBody(f);
		if (body === undefined) {
			log(
				`could not read the ${f} this commit leaves in ${dir} — every ${HOST_REGISTRATIONS} entry was judged unknown`,
			);
			return null;
		}
		try {
			files.push(JSON.parse(body || "{}"));
		} catch {
			log(unparsed);
			return null;
		}
	}
	const [j = {}, settings = {}] = files;
	/** @param {unknown} o */
	const keys = (o) =>
		o && typeof o === "object" && !Array.isArray(o) ? Object.keys(o) : [];
	const rows = /** @type {import("./registrations.js").Row[]} */ (
		(Array.isArray(j.hooks) ? j.hooks : []).filter(
			(/** @type {unknown} */ r) =>
				typeof (/** @type {{ id?: unknown }} */ (r)?.id) === "string",
		)
	);
	/** @type {Map<string, boolean>} */
	const pins = new Map();
	try {
		for (const reg of allRegistrations(settings))
			for (const [, file = ""] of buildCommandLine(reg).matchAll(
				/scripts\/([\w.-]+)/g,
			))
				pins.set(
					file,
					(pins.get(file) ?? true) && rows.some((row) => isPinnedBy(row, reg)),
				);
	} catch {
		log(unparsed);
		return null;
	}
	return {
		registeredElsewhere: new Set(keys(j.registeredElsewhere)),
		calledElsewhere: new Set(keys(j.calledElsewhere)),
		ids: rows.map((r) => r.id),
		events: new Set(rows.map((r) => `${r.event}\x1f${r.matcher ?? ""}`)),
		pinned: pins,
	};
}

/** @param {string} rel */
const isHost = (rel) => rel.startsWith(".claude/");

/**
 * @param {View} view
 * @param {string} reg
 * @param {"registeredElsewhere" | "calledElsewhere"} key
 * @param {string} file
 */
function isAllowlisted(view, reg, key, file) {
	if (!isHost(reg)) return view.willHold(reg, `"${file}"`);
	const h = view.readHostFacts();
	return h === null || h[key].has(file);
}

/**
 * @param {View} view
 * @param {string} reg
 * @param {string} file
 */
function isPinned(view, reg, file) {
	if (!isHost(reg)) return view.willHold(reg, `"scripts/${file}`);
	const h = view.readHostFacts();
	if (h === null) return true;
	const all = h.pinned.get(file);
	if (all !== undefined) return all;
	return h.ids.some((id) => id.includes(file));
}

/**
 * @param {View} view
 * @param {string} key
 */
function hasCoreNeedle(view, key) {
	const text = view.ctx.pluginNeedles();
	if (text === null) {
		view.ctx.log(
			`could not read ${view.ctx.pluginScripts}/guard-fire-needles.json — the core needle for ${key} was treated as present and the commit allowed unchecked`,
		);
		return true;
	}
	return text.includes(`"${key}"`);
}

/**
 * @param {View} view
 * @param {string} file
 */
function siblingFault(view, file) {
	const names = spellSiblingTestsIfUntested(file, (p) => view.willExist(p));
	return names === null
		? ""
		: `  - no sibling test: no ${names} in this commit or in HEAD\n`;
}

/**
 * @param {string} reg
 * @param {string} core
 */
function wholeRepo(reg, core) {
	return isHost(reg)
		? "check-registrations.js asserts the same over the whole repository, and .husky/pre-commit runs it, so the commit would be refused there too, after the rest of the stack."
		: `${core} the same over the whole repository, so from this commit until the wiring one every session's full suite goes red on a file it never touched.`;
}

/** @param {View} view */
function callerSurfaces(view) {
	const { repo } = view;
	const out = CALLER_HOOKS.map((h) => `.husky/${h}`).filter((p) =>
		repo.isFile(p),
	);
	const listed = (/** @type {string} */ d, /** @type {RegExp} */ re) =>
		repo
			.list(d)
			.filter((n) => re.test(n))
			.sort()
			.map((n) => `${d}/${n}`)
			.filter((p) => repo.isFile(p));
	out.push(...listed(".github/workflows", /\.yml$/));
	out.push(...listed(".github/workflows", /\.yaml$/));
	const { regFile } = view.registries();
	if (repo.isFile(regFile)) out.push(regFile);
	for (const d of ["scripts", "scripts/lib"])
		out.push(...listed(d, /\.js$/), ...listed(d, /\.sh$/));
	return out;
}

/**
 * @param {string} file
 * @param {View} view
 */
function judgeChecker(file, view) {
	const { checkerReg, regFile } = view.registries();
	const wired =
		isAllowlisted(view, checkerReg, "calledElsewhere", file) ||
		callerSurfaces(view).some((cand) => {
			if (cand === `scripts/${file}`) return false;
			const body = view.repo.read(cand);
			if (body === null) {
				view.ctx.log(
					`could not read ${cand} in ${view.dir} — it was treated as a caller and the commit allowed unchecked`,
				);
				return true;
			}
			return body.includes(file) && view.willHold(cand, file);
		});
	let missing = "";
	if (!wired)
		missing += `  - no caller: nothing in .husky/, .github/workflows/, ${regFile} or another scripts/ file names it after this commit\n`;
	missing += siblingFault(view, file);
	if (!missing) return "";
	const allowEntry = isHost(checkerReg)
		? `a \`calledElsewhere\` entry to ${checkerReg}, keyed by the file name with its reason,`
		: "a commented CALLED_ELSEWHERE entry to scripts/checker-registrations.test.ts";
	return `scripts/${file} is a new checker, and this commit does not carry its wiring:

${missing}
${wholeRepo(checkerReg, "scripts/checker-registrations.test.ts asserts")}

Name the wiring in the same commit — the hook, workflow or script that calls it, and the sibling test. If it is deliberately hand-only, add ${allowEntry} in THIS commit instead.

`;
}

/**
 * @param {string} file
 * @param {View} view
 */
function judgeGuard(file, view) {
	const { hookReg, regFile, needleReg } = view.registries();
	const host = isHost(hookReg);
	const pin = host ? "`hooks` row" : "REGISTRATIONS entry";
	const allowEntry = host
		? `a \`registeredElsewhere\` entry to ${hookReg}, keyed by the file name with its reason,`
		: "a commented REGISTERED_ELSEWHERE entry to scripts/hook-registrations.test.ts";
	let missing = "";
	if (!isAllowlisted(view, hookReg, "registeredElsewhere", file)) {
		if (!view.willHold(regFile, `scripts/${file}`))
			missing += `  - not registered: ${regFile} does not run it after this commit\n`;
		if (!isPinned(view, hookReg, file))
			missing += `  - not pinned: ${hookReg} has no ${pin} for it after this commit\n`;
		if (!view.willHold(needleReg, `"${file}`))
			missing += `  - not counted: ${needleReg} has no entry for it after this commit\n`;
	}
	missing += siblingFault(view, file);
	if (!missing) return "";
	return `scripts/${file} is a new guard, and this commit does not carry its wiring:

${missing}
${wholeRepo(hookReg, "scripts/hook-registrations.test.ts and scripts/count-guard-fires.test.ts assert")}

Land the registration, the ${pin}, the needle entry and the sibling test in the SAME commit. If nothing will ever register it — a guard another script invokes directly — add ${allowEntry} in this commit instead.

`;
}

/**
 * @param {string} file
 * @param {View} view
 */
function judgeCheckerRemoval(file, view) {
	const { checkerReg } = view.registries();
	const host = isHost(checkerReg);
	const stays = host
		? (view.readHostFacts()?.calledElsewhere.has(file) ?? false)
		: view.willSurelyHold(checkerReg, `"${file}":`);
	if (!stays) return "";
	const entry = host ? "`calledElsewhere`" : "CALLED_ELSEWHERE";
	const why = host
		? "check-registrations.js asserts over the whole repository that every `calledElsewhere` entry names a checker that still exists, and .husky/pre-commit runs it."
		: "scripts/checker-registrations.test.ts asserts over the whole repository that every CALLED_ELSEWHERE entry names a checker that still exists, so from this commit until the entry goes every session's full suite goes red on a file it never touched.";
	return `scripts/${file} is deleted by this commit, and its ${entry} entry stays behind:

  - ${checkerReg} still names "${file}" after this commit

${why}

Drop that entry in the SAME commit as the deletion.

`;
}

/**
 * @param {string} text
 * @returns {{ event: string, matcher: string, key: string }[] | { error: string }}
 */
function registrationsIn(text) {
	try {
		return registeredGuards(JSON.parse(text)).map((r) => ({
			event: r.event,
			matcher: r.matcher ?? "",
			key: r.key,
		}));
	} catch (e) {
		return { error: e instanceof Error ? e.message : String(e) };
	}
}

/** @typedef {{ event: string, matcher: string, key: string }} Registration */

/**
 * @param {Set<string>} reported
 * @param {View} view
 */
function judgeHookList(reported, view) {
	const lists = readHookLists(view);
	if (!lists) return "";
	const { now, before } = lists;
	const { regFile, hookReg, needleReg } = view.registries();
	const triple = (/** @type {Registration} */ r) =>
		`${r.event}\x1f${r.matcher}\x1f${r.key}`;
	const beforeTriples = new Set(before.map(triple));
	const beforeKeys = new Set(before.map((r) => r.key));
	const nowKeys = new Set(now.map((r) => r.key));
	const judged = (/** @type {Registration} */ r) =>
		r.key !== "" && !reported.has(r.key.split(" ")[0] ?? "");
	const changed = now.filter((r) => judged(r) && !beforeTriples.has(triple(r)));
	const added = new Set(
		changed
			.filter((r) => !beforeKeys.has(r.key) && !isCounted(r, view))
			.map((r) => `  - scripts/${r.key}`),
	);
	const moved = new Set(
		changed
			.filter((r) => beforeKeys.has(r.key) && !isMoveCovered(r, view))
			.map(
				(r) =>
					`  - scripts/${r.key}, now on ${r.event} with matcher ${r.matcher || "<none>"}`,
			),
	);
	const removed = new Set(
		before
			.filter((r) => judged(r) && !nowKeys.has(r.key) && isStale(r, view))
			.map((r) => `  - scripts/${r.key}`),
	);
	if (added.size + removed.size + moved.size === 0) return "";

	const list = (/** @type {Set<string>} */ set) =>
		`${[...set].sort().join("\n")}\n`;
	const host = isHost(hookReg);
	const pin = host ? "`hooks` row" : "REGISTRATIONS entry";
	const why = host
		? `A hook run with no needle entry arrives uncounted, a needle entry for a hook nothing runs reads as a guard that never fires, and ${hookReg} pins the whole registration list, event, matcher and arguments together — check-registrations.js refuses each in .husky/pre-commit too.`
		: "scripts/count-guard-fires.test.ts fails on drift in EITHER direction — a hook run with no needle entry arrives uncounted, and a needle entry for a hook nothing runs reads as a guard that never fires. scripts/hook-registrations.test.ts pins the whole registration list, event, matcher and arguments together, so a moved one fails too.";
	let out = `This commit changes which hooks ${regFile} runs, and the registries that track them do not move with it:\n`;
	if (added.size > 0)
		out += `\nNewly run, with no ${needleReg} entry or no ${pin} in ${hookReg} after this commit:\n\n${list(added)}`;
	if (removed.size > 0)
		out += `\nNo longer run, but still carried by ${needleReg} or ${hookReg} after this commit:\n\n${list(removed)}`;
	if (moved.size > 0)
		out += `\nMoved to another event or matcher, with ${hookReg} left out of this commit:\n\n${list(moved)}`;
	return `${out}\n${why}\n\nMove ${regFile}, ${needleReg} and ${hookReg} in the same commit.\n\n`;
}

/**
 * @param {View} view
 * @returns {{ now: Registration[], before: Registration[] } | null}
 */
function readHookLists(view) {
	const { dir, repo, ctx } = view;
	const { regFile } = view.registries();
	const unchecked = "its hook-list change was allowed unchecked";
	const body = view.landingBody(regFile);
	const bare = view.landsFrom === "index";
	if (bare && body === null) return null;
	if (bare && body === undefined) {
		ctx.log(`could not read the staged ${regFile} in ${dir} — ${unchecked}`);
		return null;
	}
	const now = body == null ? { error: "" } : registrationsIn(body);
	if ("error" in now) {
		ctx.log(
			`could not read the hook registrations out of the ${regFile} this commit lands — ${unchecked}`,
			now.error || undefined,
		);
		return null;
	}
	const headText = repo.headShow(regFile);
	if (headText === null) {
		ctx.log(`could not read HEAD's ${regFile} in ${dir} — ${unchecked}`);
		return null;
	}
	const before = registrationsIn(headText);
	if ("error" in before) {
		ctx.log(
			`could not read the hook registrations out of HEAD's ${regFile} in ${dir} — ${unchecked}`,
			before.error,
		);
		return null;
	}
	if (before.length === 0) {
		ctx.log(
			`HEAD's ${regFile} in ${dir} registers no hook at all — ${unchecked}`,
		);
		return null;
	}
	return { now, before };
}

/**
 * @param {Registration} r
 * @param {View} view
 */
function isCounted(r, view) {
	const { hookReg, needleReg } = view.registries();
	const counted =
		view.willHold(needleReg, `"${r.key}"`) ||
		(isHost(needleReg) && hasCoreNeedle(view, r.key));
	return counted && isPinned(view, hookReg, r.key.split(" ")[0] ?? "");
}

/**
 * @param {Registration} r
 * @param {View} view
 */
function isMoveCovered(r, view) {
	const { hookReg } = view.registries();
	if (view.inLanding(hookReg)) return true;
	if (isHost(hookReg)) {
		const h = view.readHostFacts();
		return h === null || h.events.has(`${r.event}\x1f${r.matcher}`);
	}
	return (
		view.willHold(hookReg, `event: "${r.event}"`) &&
		view.willHold(
			hookReg,
			r.matcher ? `matcher: "${r.matcher}"` : "matcher: null",
		)
	);
}

/**
 * @param {Registration} r
 * @param {View} view
 */
function isStale(r, view) {
	const { hookReg, needleReg } = view.registries();
	if (view.willSurelyHold(needleReg, `"${r.key}"`)) return true;
	if (isHost(hookReg))
		return view.readHostFacts()?.ids.includes(`scripts/${r.key}`) ?? false;
	return view.willSurelyHold(hookReg, `"scripts/${r.key}"`);
}

/** @param {View} view */
function judgeNeedleText(view) {
	const { root, ctx, landing } = view;
	if (!landing.some((p) => isUnder(p, CORPUS_DIRS))) return "";
	const drift = ctx.needleDrift({
		repo: view.repo,
		root,
		landing,
		readLanding: view.readLanding,
	});
	if ("failOpen" in drift) {
		ctx.log(
			`the needle-drift scan failed — this commit's needle text was allowed unchecked`,
			drift.failOpen,
		);
		return "";
	}
	const line = (/** @type {NeedleBreak} */ n) =>
		`  - ${n.key} / ${n.id}, keyed on: ${n.text.replace(/\s+/g, " ")}\n`;
	const reworded = drift.broken
		.filter((n) => !n.arriving)
		.map(line)
		.join("");
	const arriving = drift.broken
		.filter((n) => n.arriving)
		.map(line)
		.join("");
	if (!reworded && !arriving) return "";
	let out =
		"This commit changes wording that scripts/guard-fire-needles.json keys a needle on, and the needle does not move with it:\n";
	if (reworded)
		out += `\nPrinted somewhere before this commit and printed nowhere after it:\n\n${reworded}\nMove each needle's \`text\` to the new wording in the same commit, or put the old wording back.`;
	if (arriving)
		out += `\nKeyed by a needle this commit ADDS, on wording nothing in the tree prints:\n\n${arriving}\nKey each on text the guard actually prints — or land the printer in the same commit.`;
	return `${out}\n\nscripts/count-guard-fires.test.ts asserts every needle is text this repo still prints, so the suite goes red on the mismatch for everyone until the two agree.\n\n`;
}

/** @param {View} view */
function hostTail(view) {
	const { hookReg, checkerReg, needleReg } = view.registries();
	if (!isHost(hookReg) && !isHost(checkerReg) && !isHost(needleReg)) return "";
	const plugin = view.ctx.pluginScripts;
	const absent = [HOST_REGISTRATIONS, HOST_NEEDLES].filter(
		(f) => !view.willCarry(f),
	);
	let out = `This repo keeps its registries in ${HOST_REGISTRATIONS} and ${HOST_NEEDLES} (#1456). \`node ${plugin}/check-registrations.js\` lists every hook, guard and checker either is missing.\n\n`;
	if (absent.length > 0)
		out += `Not in this repo yet: ${absent.join(" ")}. \`node ${plugin}/upgrade.js\` seeds each empty; or write ${HOST_REGISTRATIONS} as {"hooks": [], "registeredElsewhere": {}, "calledElsewhere": {}} and ${HOST_NEEDLES} as {"guards": {}}, and land them in this commit.\n\n`;
	return out;
}

module.exports = { field: "command", noun: "command", decide };
