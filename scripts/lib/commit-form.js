const { closingMatch } = require("./closing-keyword.js");
const { denyText, ruleOrFallback } = require("./guard-verdict.js");
const { ruleModule } = require("./rule-gates.js");
const { isUnder, relativeUnder } = require("./is-under.js");
const {
	commitPathsArgs,
	normAbs,
	parseCommand,
	unsetText,
	walkCommands,
	walkGit,
} = require("./shell-parse.js");
const {
	commitPathsParse,
	gitValueFlags,
	literal,
	scanFlags,
} = require("./shell-words.js");

/**
 * @typedef {"cached" | "others" | "others-standard"} LsMode
 * @typedef {object} CommitFormPorts
 * @property {string} root
 * @property {(dir: string) => boolean} midSequence
 * @property {(dir: string) => string[] | null} stagedFiles
 * @property {(dir: string, path: string, mode: LsMode) => string[] | null} lsFiles
 * @property {(dir: string) => string | null} topLevel
 * @property {(dir: string, file: string) => string[] | null} patchFiles
 * @property {(file: string) => string | null} readList
 * @property {(dir: string) => string | null} pushedHead
 * @property {(match: string) => string} closingRefusal
 * @typedef {import("./kit-context.js").KitContext & CommitFormPorts} CommitFormContext
 */

// guess, #5529
const PATHS_SHOWN_CAP = 10;

/** @param {CommitFormContext} ctx */
const untrackedEscape = (ctx) =>
	`Commit with \`node ${ctx.scriptPath("commit-paths.js")} -m "…" -- <paths>\` (Bash \`timeout: 600000\`): it intent-adds a file git does not know yet. By hand, \`git add -N <path>\` first — intent-to-add stages a name and no content.`;

/** @param {CommitFormContext} ctx */
const denyNoVerify = (
	ctx,
) => `This flag skips none of the pre-commit gates on a plain commit or merge, and cuts them everywhere else: @CMD@

On \`git commit\` and \`git merge\` the flag skips \`.husky/pre-commit\` or \`.husky/pre-merge-commit\`, but \`.husky/prepare-commit-msg\`, which no flag skips, runs that same whole stack anyway — the secrets scan, the Biome staged-paths format check, check-doc-map.js, check-digest-version.js, check-guard-registry.js and check-roadmap-valid.js — and a finding refuses the operation (mantahostels#1705). On a commit made mid-rebase or mid-cherry-pick, where \`pre-commit\` would run that whole stack, the flag leaves the secrets scan alone (mantahostels#1706). On \`git am\` it skips \`.husky/pre-applypatch\`, that route's only gate and its secrets scan (mantahostels#1707): a credential applied past it is public the moment anyone pushes. Today's git refuses it on \`git revert\` and \`git cherry-pick\` outright.

Drop the flag: on a plain commit or merge it buys nothing, and everywhere else it turns gates off.

There is no override, deliberately — ${ruleOrFallback(ctx, "self-spelt-escape", "an escape a session can spell for itself is not a deny")} The git-hook escapes, \`WFC_ALLOW_BRANCH\` among them, each stand down one gate alone, and are the founder's to set, never yours: stop and ask (#916).`;

/** @param {CommitFormContext} ctx */
const denySweeping = (
	ctx,
) => `This commit form sweeps in every dirty tracked file: @CMD@

\`git commit -a\`/\`-am\` commits every TRACKED file with an edit in it. Your subagents share your worktree, so that takes a subagent's unfinished edit too, under your message (mantahostels#1539).

Commit by pathspec instead, naming only the files you changed:
  git commit -m "…" -- <paths>

${untrackedEscape(ctx)} Then commit by pathspec as normal.`;

const AMEND_OPENING = "This amend rewrites a commit already pushed";

/** @param {string} ref */
const denyAmend = (
	ref,
) => `${AMEND_OPENING}, as \`HEAD\` is on \`${ref}\`: @CMD@

The rewrite forks from what was pushed. The next push of it is a non-fast-forward and is refused, and landing again merges both the original commit and its rewrite (#4384).

Make a follow-up commit instead:
  git commit -m "…" -- <paths>`;

/** @param {string} refusal */
const denyClosesKeyword = (refusal) =>
	`This commit message closes an issue server-side the moment it is pushed: @CMD@

${refusal}`;

const NV_VALUE_FLAGS = {
	merge: gitValueFlags("merge"),
	rebase: gitValueFlags("rebase"),
	"cherry-pick": "-m --mainline --cleanup",
	revert: "-m --mainline --cleanup",
	am: "--directory --exclude --include --whitespace --patch-format --quoted-cr -p -C",
};

const NV_SPELLINGS = {
	merge: ["--no-verify"],
	"cherry-pick": ["--no-verify"],
	revert: ["--no-verify"],
	rebase: ["--no-veri", "--no-verif", "--no-verify"],
	am: [
		"--no-v",
		"--no-ve",
		"--no-ver",
		"--no-veri",
		"--no-verif",
		"--no-verify",
	],
};

const COMMIT_NO_VERIFY = ["-n", "--no-veri", "--no-verif", "--no-verify"];
const COMMIT_AMEND = ["--am", "--ame", "--amen", "--amend"];
const COMMIT_SWEEPS = ["-a", "--all"];

const DOC_MAP_SCOPE =
	/^(docs\/|\.claude\/|hooks\/|self-plugin\/|AGENTS\.md$|CLAUDE\.md$|PRODUCT\.md$|DESIGN\.md$|GLOSSARY\.md$)/;
const DIGEST_FILES = /^docs\/(reference-roadmap\.html|roadmap-digest\.md)$/;
const REGISTRY_FILES =
	/^(CLAUDE\.md$|AGENTS\.md$|(docs|\.claude)\/.*\.md$|scripts\/.*\.sh$|docs\/agents\/rules\/)/;
const BIOME_EXT =
	/\.(js|jsx|mjs|cjs|ts|tsx|mts|cts|json|jsonc|css|graphql|gql|vue|svelte|astro|html)$/;
const BIOME_EXCLUDED =
	/^(public\/|docs\/|\.claude\/worktrees\/|scripts\/fixtures\/|skills-lock\.json$|\.claude\/settings[^/]*\.json$)/;

/** @type {Record<string, "noVerify" | "amend" | "sweeps">} */
const COMMIT_FLAG = Object.fromEntries([
	...COMMIT_NO_VERIFY.map((f) => [f, "noVerify"]),
	...COMMIT_AMEND.map((f) => [f, "amend"]),
	...COMMIT_SWEEPS.map((f) => [f, "sweeps"]),
]);

/**
 * @param {string[]} args
 * @param {string[]} spans
 */
function scanCommit(args, spans) {
	const c = {
		noVerify: false,
		amend: false,
		sweeps: false,
		/** @type {string[]} */
		words: [],
		message: "",
	};
	scanFlags(gitValueFlags("commit"), args, (kind, name, value) => {
		const set =
			kind === "flag" && Object.hasOwn(COMMIT_FLAG, name)
				? COMMIT_FLAG[name]
				: undefined;
		if (kind === "arg") c.words.push(value);
		else if (kind === "opt" && (name === "-m" || name === "--message"))
			c.message += ` ${literal(value, spans).text}`;
		else if (set) c[set] = true;
	});
	return c;
}

/**
 * @typedef {{ intent: boolean, dry: boolean, force: boolean, nul: boolean }}
 *   AddFlags
 */

/** @type {Record<string, keyof AddFlags>} */
const ADD_FLAG = {
	"-N": "intent",
	"--intent-to-add": "intent",
	"-n": "dry",
	"--dry-run": "dry",
	"-f": "force",
	"--force": "force",
	"--pathspec-file-nul": "nul",
};

/** @type {[string, keyof AddFlags][]} */
const ADD_SHORT = [
	["N", "intent"],
	["n", "dry"],
	["f", "force"],
];

/**
 * @param {string[]} args
 * @returns {AddFlags}
 */
function addFlags(args) {
	const f = { intent: false, dry: false, force: false, nul: false };
	for (const a of args) {
		const set = Object.hasOwn(ADD_FLAG, a) ? ADD_FLAG[a] : undefined;
		if (set) f[set] = true;
		else if (/^-[^-]/.test(a))
			for (const [ch, key] of ADD_SHORT) if (a.includes(ch)) f[key] = true;
	}
	return f;
}

/**
 * @param {keyof typeof NV_SPELLINGS} sub
 * @param {string[]} args
 */
function skipsHooks(sub, args) {
	let hit = false;
	scanFlags(NV_VALUE_FLAGS[sub], args, (kind, name) => {
		if (kind === "flag" && NV_SPELLINGS[sub].includes(name)) hit = true;
	});
	return hit;
}

/**
 * @param {string} reason
 * @param {string} unset
 * @param {string} segment
 * @param {CommitFormContext} ctx
 */
function commitDenyText(reason, unset, segment, ctx) {
	let r = reason;
	if (unset) {
		const cut = r.indexOf("\n\n");
		r =
			cut < 0
				? `${r}\n\n${unset}`
				: `${r.slice(0, cut)}\n\n${unset}${r.slice(cut + 2)}`;
	}
	return denyText(ctx, segment, r.replace(/\n$/, ""));
}

/**
 * @param {string} p
 * @param {string} dir
 */
const absAt = (p, dir) => normAbs(p.startsWith("/") ? p : `${dir}/${p}`);

/**
 * @param {string} top
 * @param {string} abs
 */
const relativeTo = (top, abs) => relativeUnder(top, abs) || abs;

/**
 * @typedef {object} Judging
 * @property {CommitFormContext} ctx
 * @property {ReturnType<typeof parseCommand>} parsed
 * @property {string[]} spans
 * @property {string | null} denied
 * @property {string} warning
 * @property {string} leftBehind
 * @property {string[]} intentAdded
 * @property {Set<string>} committed
 * @property {boolean} ruleSubject
 * @property {string} ruleDir
 * @property {string[]} lastWords
 */

/**
 * @param {Judging} j
 * @param {string} word
 */
function known(j, word) {
	const l = literal(word, j.spans);
	return l.known && l.text ? l.text : null;
}

/**
 * @param {Judging} j
 * @param {{ dir: string, abs: string }} at
 * @param {LsMode} mode
 * @param {string} ticket
 */
function listUnder({ ctx }, { dir, abs }, mode, ticket) {
	const out = ctx.lsFiles(dir, abs, mode);
	if (out === null)
		ctx.log(
			`git could not list ${mode === "cached" ? "tracked" : "untracked"} files under ${abs} in ${dir} — that pathspec word was left unjudged for ${ticket}`,
		);
	return out;
}

/**
 * @param {Judging} j
 * @param {string} dir
 * @param {string} abs
 */
function onlyUntracked(j, dir, abs) {
	const at = { dir, abs };
	const tracked = listUnder(j, at, "cached", "mantahostels#1612");
	if (tracked === null || tracked.length > 0) return false;
	const others = listUnder(j, at, "others", "mantahostels#1612");
	return others !== null && others.length > 0;
}

/**
 * @param {Judging} j
 * @param {string[]} words
 * @param {string} dir
 */
function untrackedWarn(j, words, dir) {
	let list = "";
	for (const w of words) {
		const lit = known(j, w);
		if (lit === null) continue;
		const abs = absAt(lit, dir);
		const bare = abs.replace(/\/$/, "");
		if (j.intentAdded.some((ia) => isUnder(ia, [bare]))) continue;
		if (onlyUntracked(j, dir, abs)) list += `  ${lit}\n`;
	}
	if (!list) return;
	j.warning = `This commit names path(s) git does not track yet:\n\n${list}\nA pathspec commit cannot reach an untracked path. git answers \`error: pathspec '<path>' did not match any file(s) known to git\`, exits 1 and commits NOTHING — read that exit as "nothing to do" and the ticket looks finished with the file uncommitted (mantahostels#1612).\n\n${untrackedEscape(j.ctx)} Then commit by pathspec as normal. A path your .gitignore covers needs \`git add -f -N <path>\` by hand — the script refuses it — or it does not belong in this commit at all.`;
}

/**
 * @param {Judging} j
 * @param {string} dir
 * @param {string} abs
 */
function leftUnder(j, dir, abs) {
	if (!j.ctx.isDir(abs)) return [];
	const at = { dir, abs };
	const tracked = listUnder(j, at, "cached", "mantahostels#1651");
	if (tracked === null || tracked.length === 0) return [];
	return listUnder(j, at, "others-standard", "mantahostels#1651") ?? [];
}

/**
 * @param {Judging} j
 * @param {string[]} words
 * @param {string} dir
 */
function leftBehindWarn(j, words, dir) {
	let list = "";
	let budget = PATHS_SHOWN_CAP;
	let omitted = 0;
	for (const w of words) {
		const lit = known(j, w);
		if (lit === null) continue;
		const others = leftUnder(j, dir, absAt(lit, dir));
		if (others.length === 0) continue;
		const shown = Math.min(others.length, budget);
		budget -= shown;
		omitted += others.length - shown;
		list += `  ${lit}\n`;
		for (const f of others.slice(0, shown)) list += `    ${f}\n`;
	}
	if (!list) return;
	if (omitted) list += `  … and ${omitted} more\n`;
	j.leftBehind = `This commit names director(ies) holding file(s) git does not track yet:\n\n${list}\ngit ACCEPTS a directory pathspec: it commits the tracked files under it, exits 0 and leaves the untracked ones behind — no error, nothing to notice (mantahostels#1651). Read that exit as done and the ticket looks finished with the new file uncommitted.\n\nName the files you changed, rather than the directory holding them — the script refuses such a directory too. ${untrackedEscape(j.ctx)}`;
}

/**
 * @param {Judging} j
 * @param {string} p
 * @param {string} dir
 * @param {boolean} force
 */
function recordIntent(j, p, dir, force) {
	if (!p) return;
	const abs = absAt(p, dir);
	j.intentAdded.push(abs);
	const expanded = j.ctx.lsFiles(
		dir,
		abs,
		force ? "others" : "others-standard",
	);
	if (expanded === null) {
		j.ctx.log(
			`git could not list what \`git add -N ${abs}\` covers in ${dir} — only the argument itself was recorded for mantahostels#3321`,
		);
		return;
	}
	for (const rel of expanded) if (rel) j.intentAdded.push(absAt(rel, dir));
}

/**
 * @param {Judging} j
 * @param {string[]} args
 * @param {AddFlags} flags
 * @param {string} dir
 */
function scanIntentAdded(j, args, { intent, dry, force, nul }, dir) {
	if (!intent || dry) return;
	/** @param {string} p */
	const record = (p) => recordIntent(j, p, dir, force);
	scanFlags("--pathspec-from-file --chmod", args, (kind, name, value) => {
		if (kind === "arg") {
			const l = literal(value, j.spans);
			if (l.known) record(l.text);
		} else if (kind === "opt" && name === "--pathspec-from-file")
			for (const p of readPathspecsFromFile(j, value, dir, nul)) record(p);
	});
}

/**
 * @param {string} text
 * @param {boolean} nul
 */
const listPaths = (text, nul) =>
	nul
		? text.split("\0")
		: text
				.split("\n")
				.map((raw) => raw.replace(/\r$/, ""))
				.filter((line) => line && !line.startsWith('"'));

/**
 * @param {Judging} j
 * @param {string} word
 * @param {string} dir
 * @param {boolean} nul
 * @returns {string[]}
 */
function readPathspecsFromFile(j, word, dir, nul) {
	const { ctx } = j;
	const spec = known(j, word);
	if (spec === null) return [];
	if (spec === "-") {
		ctx.log(
			"`git add -N --pathspec-from-file -` takes its paths from stdin, which this guard cannot read — nothing recorded for mantahostels#3324",
		);
		return [];
	}
	const file = absAt(spec, dir);
	if (listRewritten(j, file)) {
		ctx.log(
			`the pathspec list ${file} is rewritten by a redirect in the same command — nothing recorded for mantahostels#3327`,
		);
		return [];
	}
	const text = ctx.readList(file);
	if (text === null) {
		ctx.log(
			`could not read the pathspec list ${file} for mantahostels#3324 — nothing recorded`,
		);
		return [];
	}
	return listPaths(text, nul);
}

/**
 * @param {{ kind: string, path: string | null, target: string }} r
 * @param {string} file
 * @param {string[]} spans
 */
function truncatesInto(r, file, spans) {
	if (!["truncate", "clobber", "read-write"].includes(r.kind)) return false;
	if (!r.path || r.path === file) return true;
	const l = literal(r.target, spans);
	const base = file.slice(file.lastIndexOf("/") + 1);
	return (
		l.known &&
		!l.text.startsWith("/") &&
		l.text.slice(l.text.lastIndexOf("/") + 1) === base
	);
}

/**
 * @param {Judging} j
 * @param {string} file
 */
function listRewritten(j, file) {
	let hit = false;
	walkCommands(
		j.parsed,
		(cmd) => {
			if (cmd.redirects().some((r) => truncatesInto(r, file, j.spans)))
				hit = true;
		},
		{ ...j.ctx, bareRedirects: true },
	);
	return hit;
}

/**
 * @param {Judging} j
 * @param {string[]} args
 * @param {string} tree
 */
function judgeAdd(j, args, tree) {
	scanIntentAdded(j, args, addFlags(args), tree);
}

/**
 * @param {Judging} j
 * @param {string[]} words
 * @param {string} tree
 */
function untrackedWarns(j, words, tree) {
	if (j.warning || j.ctx.midSequence(tree)) return;
	untrackedWarn(j, words, tree);
	if (!j.warning) leftBehindWarn(j, words, tree);
}

/**
 * @param {Judging} j
 * @param {string} tree
 */
function readPushedHead(j, tree) {
	const ref = j.ctx.pushedHead(tree);
	if (ref === null)
		j.ctx.log(
			`git could not say whether HEAD in ${tree} is pushed — the amend allowed unchecked`,
		);
	return ref ?? "";
}

/**
 * @param {Judging} j
 * @param {import("./shell-parse.js").GitCall} call
 */
function judge(j, { segment, sub, tree, args, emptyVars }) {
	if (j.denied !== null) return;
	/** @param {string} reason */
	const deny = (reason) => {
		j.denied = commitDenyText(reason, unsetText(emptyVars), segment, j.ctx);
	};
	if (sub in NV_SPELLINGS) {
		if (skipsHooks(/** @type {keyof typeof NV_SPELLINGS} */ (sub), args))
			deny(denyNoVerify(j.ctx));
		return;
	}
	j.ruleSubject = true;
	if (sub !== "commit") return judgeAdd(j, args, tree);
	j.ruleDir = tree;
	const c = scanCommit(args, j.spans);
	j.lastWords = c.words;
	if (c.noVerify) return deny(denyNoVerify(j.ctx));
	const match = closingMatch(c.message);
	if (match !== null)
		return deny(denyClosesKeyword(j.ctx.closingRefusal(match)));
	const atRest = !j.ctx.midSequence(tree);
	if (c.sweeps && atRest) return deny(denySweeping(j.ctx));
	if (c.amend && atRest && !j.committed.has(tree)) {
		const ref = readPushedHead(j, tree);
		if (ref) return deny(denyAmend(ref));
	}
	j.committed.add(tree);
	untrackedWarns(j, c.words, tree);
}

/**
 * @param {Judging} j
 * @param {string} dir
 * @param {string[]} words
 */
function repoRelative(j, dir, words) {
	const top = j.ctx.topLevel(dir);
	if (top === null) {
		j.ctx.log(
			`the repo root did not resolve in ${dir} — the scoped §Gotchas rules were not selected`,
		);
		return [];
	}
	return words.flatMap((w) => {
		const lit = known(j, w);
		if (lit === null) return [];
		return [relativeTo(top, absAt(lit, dir))];
	});
}

/**
 * @param {Judging} j
 * @param {NonNullable<ReturnType<typeof commitPathsParse>>} call
 * @param {string | undefined} cwd
 */
function commitPathsWords(j, call, cwd) {
	if (!cwd) {
		j.ctx.log(
			"a commit-paths.js call's directory is unknown — the scoped §Gotchas rules were not selected",
		);
		return [];
	}
	const words = [...call.paths];
	if (call.patch) {
		const file = known(j, call.patch);
		const files = file === null ? null : j.ctx.patchFiles(cwd, file);
		if (files === null)
			j.ctx.log(
				`could not read the --patch file of a commit-paths.js call in ${cwd} — the scoped §Gotchas rules did not see its files`,
			);
		else words.push(...files);
	}
	return repoRelative(j, cwd, words);
}

/** @param {Judging} j */
function commitPathsCalls(j) {
	let subject = false;
	/** @type {string[]} */
	const paths = [];
	walkCommands(
		j.parsed,
		(cmd) => {
			for (const cpArgs of commitPathsArgs(cmd.words, j.spans)) {
				subject = true;
				const call = commitPathsParse(cpArgs, j.spans);
				if (call !== null) paths.push(...commitPathsWords(j, call, cmd.cwd));
			}
		},
		j.ctx,
	);
	return { subject, paths };
}

/**
 * @param {Judging} j
 * @param {string[]} paths
 * @returns {import("./guard-entry.js").Decision}
 */
function commitRules(j, paths) {
	const { ctx } = j;
	/** @param {RegExp} re */
	const touches = (re) => paths.some((p) => re.test(p));
	const biome = paths.some((p) => BIOME_EXT.test(p) && !BIOME_EXCLUDED.test(p));
	return {
		injectRules: [
			"commit-pathspec",
			"commit-show-diff",
			"commit-message",
			"doc-map-precommit",
			"digest-version-drift",
			"guard-registry-gate",
			"biome-staged-gate",
			"superseded-values-gate",
			"machinery-superseded",
			"push-cadence",
		],
		skip: [
			...(j.ruleSubject ? [] : ["commit-pathspec"]),
			...ruleModule(ctx, "roadmap", ["digest-version-drift"]),
			...ruleModule(ctx, "governance", [
				"doc-map-precommit",
				"superseded-values-gate",
			]),
			...(touches(DOC_MAP_SCOPE) ? [] : ["doc-map-precommit"]),
			...(touches(DIGEST_FILES) ? [] : ["digest-version-drift"]),
			...(touches(REGISTRY_FILES) ? [] : ["guard-registry-gate"]),
			...(biome ? [] : ["biome-staged-gate"]),
			...(touches(/^docs\//)
				? []
				: ["superseded-values-gate", "machinery-superseded"]),
		],
	};
}

/**
 * @param {string} command
 * @param {CommitFormContext} ctx
 * @returns {import("./guard-entry.js").Decision}
 */
function decide(command, ctx) {
	const parsed = parseCommand(command);
	/** @type {Judging} */
	const j = {
		ctx,
		parsed,
		spans: parsed.spans,
		denied: null,
		warning: "",
		leftBehind: "",
		intentAdded: [],
		committed: new Set(),
		ruleSubject: false,
		ruleDir: "",
		lastWords: [],
	};
	walkGit(parsed, (call) => judge(j, call), ctx, {
		subs: [
			"add",
			"stage",
			"commit",
			"merge",
			"rebase",
			"cherry-pick",
			"revert",
			"am",
		],
		noun: "commit form",
		scope: "repo",
		emptyUnset: true,
	});
	if (j.denied !== null) return { deny: j.denied };

	const cp = commitPathsCalls(j);
	const warning = j.warning || j.leftBehind;
	if (warning) return { injectRules: [], prelude: ctx.corePaths(warning) };

	if (!j.ruleSubject && !cp.subject) return null;
	const paths = [...cp.paths];
	if (j.ruleDir)
		paths.push(
			...repoRelative(j, j.ruleDir, j.lastWords),
			...(ctx.stagedFiles(j.ruleDir) ?? []),
		);
	return commitRules(j, paths);
}

module.exports = {
	field: "command",
	noun: "command",
	decide,
};
