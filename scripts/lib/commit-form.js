/*
 * commit-form.js — the guard-commit-form core (workflow-core#2793, workflow-core#3224): the commit forms that
 * sweep the shared index (mantahostels#117).
 *
 * Why: the index is repo-global, so between one session's `git add` and its
 * commit, a parallel session's commit takes the staged files in under its own
 * message — mantahostels#63, where a roadmap correction landed inside an
 * unrelated commit.
 *
 * NINE VERDICTS, split by command form (mantahostels#109). mantahostels#103's
 * rule is deny on a structured fact where the action has no legitimate use,
 * warn where the hook is inferring:
 *
 *   git add (not -N)        warn   Two legitimate uses on record: staging
 *                                  through a merge conflict, and `git add -N`
 *                                  for a new file, which a pathspec commit
 *                                  rejects. A deny would wedge ordinary work.
 *   commit -a/-am/-i/--include
 *                           deny   Zero legitimate uses. `-a` sweeps a parallel
 *                                  session's files that are merely dirty and
 *                                  unstaged — the normal state of a live session.
 *   bare commit, no pathspec
 *                           warn   Harm depends on whether another session has
 *                                  staged something at that instant: a fact
 *                                  about the world, not about the command.
 *   commit --no-verify/-n   deny   Zero legitimate uses (mantahostels#975). Since
 *   merge/rebase/cherry-pick/      mantahostels#1705-1707 the flag buys nothing
 *   revert/am --no-verify          on a plain commit or merge, where
 *                                  `.husky/prepare-commit-msg` runs the stack
 *                                  anyway; mid-replay it cuts the stack to the
 *                                  secrets scan, and on a `git am` it skips
 *                                  `.husky/pre-applypatch`, that route's only
 *                                  gate. Not an anti-contention rule, so it
 *                                  binds in a worktree too (mantahostels#1213).
 *   commit --amend          deny   Zero legitimate uses in the shared tree
 *                                  (mantahostels#2540). Shared-tree-only and
 *                                  stood down mid-sequence.
 *   commit -m "…Fixes #n"   deny   Zero legitimate uses (workflow-core#129, workflow-core#118). Binds in
 *                                  every tree and stands down for nothing.
 *   commit -- <pathspec>    warn   A pathspec takes the working-tree copy of
 *                                  every path it names (mantahostels#1539), so
 *                                  a live neighbour's claimed, unsaved edits
 *                                  land under this message. Shared-tree-only
 *                                  and stood down mid-sequence.
 *   commit -- <untracked>   warn   A pathspec cannot reach a path git does not
 *                                  track (mantahostels#1612): git exits 1 and
 *                                  commits nothing, and a session reads that
 *                                  as "nothing to do". Binds in a worktree too;
 *                                  stood down mid-sequence. It OUTRANKS the
 *                                  sweep warn, git rejecting the whole commit,
 *                                  and is silent on a word an EARLIER SEGMENT
 *                                  intent-adds (mantahostels#3280), where that
 *                                  ground is false.
 *   commit -- <directory>   warn   A directory word holding a tracked and an
 *                                  untracked file is ACCEPTED: git commits the
 *                                  tracked one, exits 0 and leaves the new one
 *                                  behind (mantahostels#1651). Binds in a
 *                                  worktree too. The LOWEST-RANKED warn
 *                                  (mantahostels#3280): every verdict decided
 *                                  later takes the slot ahead of it.
 *
 * EVERY VERDICT BUT `--no-verify` AND THE CLOSING KEYWORD is suppressed while
 * a merge, rebase, cherry-pick, revert or am is in progress: staging is
 * unavoidable there, and finishing a merge is a bare `git commit`.
 *
 * ATTRIBUTION (mantahostels#118). The bare-commit warn names the FOREIGN
 * staged path — one this session never wrote, by the write ledger
 * (mantahostels#114) — and is silent where the index holds only the session's
 * own work. It FALLS BACK to the index-wide warn where the ledger is
 * unavailable.
 *
 * A TENTH OUTPUT, WHICH IS NOT A VERDICT (mantahostels#1647, spec
 * mantahostels#1762). On the clean branch a `git add`/`stage`/`commit` is
 * handed the commit rules, and a `node …/commit-paths.js` call the last three
 * of the act's own, plus the §Gotchas gate rules its paths earn (workflow-core#2147). A
 * warn suppresses them. The merge family is handed nothing.
 *
 * LIMITS
 *  - Scope is THIS repository. The three index verdicts, the pathspec warn and
 *    the `--amend` deny bind the shared working tree alone; `--no-verify`, the
 *    closing keyword and the two untracked-path warns bind in a linked
 *    worktree too. Any other repository is exempt from all nine.
 *  - It matches the *parsed command form*, never a substring, so a grep, an
 *    echo or a heredoc mentioning `git add` passes.
 *  - It FAILS OPEN, RECORDED (mantahostels#147), on a `cd`/`git -C` target it
 *    cannot resolve and on any git read that errors. No verdict refuses on an
 *    unknown tree (workflow-core#312).
 *  - An UNSET variable in that target is read as empty (workflow-core#312): shell state
 *    does not carry between Bash calls, so `git -C "$W"` with `W` from an
 *    earlier call runs in the cwd. The four refusals name the variable.
 *  - THE CLOSING-KEYWORD RULE READS `-m`/`--message` VALUES ONLY
 *    (mantahostels#2592). `-F`, `-c`/`-C`, a `--trailer` and the editor route
 *    carry the keyword unseen; the git hooks' scanner,
 *    check-commit-message-closes.js, catches them at commit time. `--message`
 *    abbreviations are not read either. It overmatches the glued `fixes#12`,
 *    which GitHub does not honour (mantahostels#2660, workflow-core#2668).
 *  - Long-option abbreviation is honoured only for `--include`, from `--inc`
 *    down; `--all` has none; `--no-verify` abbreviates to `--no-veri`, and
 *    `--amend` to `--am` (mantahostels#2540).
 *  - `-n` is read as `--no-verify` under `git commit` ONLY: it is `--dry-run`
 *    under add, `--no-stat` under merge and rebase, `--no-commit` under
 *    cherry-pick and revert, and `--no-scissors` under am (mantahostels#1705,
 *    mantahostels#1706, mantahostels#1707).
 *  - THIS IS THE HOOK-DEFEAT LIST'S ONE HOME (workflow-core#800). Two routes to the same
 *    harm are left open (mantahostels#975, workflow-core#792): `HUSKY=0`, and
 *    `core.hooksPath` pointed off .husky/_ by `-c`, `--config-env`, the
 *    `GIT_CONFIG_*` variables or a persistent `git config`. Each skips every
 *    hook while spelling no flag this reads.
 *  - A glob git expands itself — `-- 'docs/*'` — is mantahostels#1651's known
 *    residual.
 *  - Attribution errs toward warning: a file written by a shell redirect or a
 *    script that takes no claim reads foreign.
 *  - A commit reached through a wrapper is not seen: only a segment's own
 *    first word is read, so `timeout 5 git commit -a`, `sh -c "…"`, `env` and
 *    `command` carry any form past it, `git am --no-verify` included (workflow-core#800).
 *  - It guards the Bash tool, so it binds agent sessions and not the founder's
 *    own terminal. That is why the deny carries no override
 *    (mantahostels#109, mantahostels#110).
 */

const { closingMatch } = require("./closing-keyword.js");
const { denyText } = require("./guard-verdict.js");
const { ruleModule, ruleUnlessModule } = require("./rule-gates.js");
const {
	normAbs,
	parseCommand,
	unsetText,
	walkCommands,
	walkGit,
} = require("./shell-parse.js");
const {
	commitPathsArgs,
	commitPathsParse,
	gitValueFlags,
	literal,
	scanFlags,
} = require("./shell-words.js");

/**
 * @typedef {{ rel: string, region: string | null, holder: string }} Sweep
 * @typedef {"cached" | "others" | "others-standard"} LsMode
 * @typedef {object} CommitFormPorts
 * @property {string} root the host root, as the arbiter's repoRoot() reads it
 * @property {(dir: string) => boolean} midSequence a merge, rebase,
 *   cherry-pick, revert or `git am` in progress; false where git cannot answer
 * @property {(dir: string) => string[] | null} stagedFiles the index against
 *   HEAD, or the empty tree before the first commit; null where git errors
 * @property {(dir: string, path: string, mode: LsMode) => string[] | null}
 *   lsFiles `git ls-files` under one path; null where git errors
 * @property {(dir: string) => string | null} topLevel
 * @property {(dir: string, file: string) => string[] | null} patchFiles
 * @property {(file: string) => string | null} readList a pathspec list file's
 *   text; null where it is not a readable regular file
 * @property {(paths: string[], sessionId: string) => { sweeps: Sweep[] | null,
 *   written: string[] | null, fault: string }} commitCheck the arbiter's
 *   answer for that session: the sweep risks among `paths`, and the write
 *   ledger, each null where it is unavailable, `fault` saying why
 * @property {(match: string) => string} closingRefusal what the
 *   closing-keyword deny says after its opening line
 * @typedef {import("./kit-context.js").KitContext & CommitFormPorts & {
 *   session: string, env: Record<string, string | undefined> }}
 *   CommitFormContext `session` is the payload's session id, "" where it
 *   carries none
 */

/* How many paths a warn names before it falls back to a count. A first guess:
 * nothing has measured what a session stops reading at. The budget is the
 * whole message's, not each word's. */
const PATHS_SHOWN_CAP = 10;

/* A session name is a whole ticket title. 60 is a guess at the width that
 * still names the ticket; nothing has measured it. */
const HOLDER_WIDTH = 60;

/** @param {CommitFormContext} ctx */
const untrackedEscape = (ctx) =>
	`Commit with \`node ${ctx.scriptPath("commit-paths.js")} -m "…" -- <paths>\` (Bash \`timeout: 600000\`): it intent-adds a file git does not know yet, and waits out a neighbour's index lock. By hand, \`git add -N <path>\` is the exception — intent-to-add stages a name and no content.`;

/** @param {CommitFormContext} ctx */
const denySweeping = (ctx) => `This commit form sweeps the shared index: @CMD@

\`git commit -a\`/\`-am\` commits every dirty TRACKED file, so it takes a parallel session's uncommitted edits — they need not have staged anything, only have a file open. \`-i\`/\`--include\` commits the shared index plus your paths. ${ctx.docPath("agents/guard-registry.md")} §Conventions bars both outright.

Commit by pathspec instead, naming only the files you changed:
  git commit -m "…" -- <paths>

${untrackedEscape(ctx)} Then commit by pathspec as normal.`;

const DENY_NO_VERIFY = `This flag skips none of the pre-commit gates on a plain commit or merge, and cuts them everywhere else: @CMD@

On \`git commit\` and \`git merge\` the flag skips \`.husky/pre-commit\` or \`.husky/pre-merge-commit\`, but \`.husky/prepare-commit-msg\`, which no flag skips, runs that same whole stack anyway — the secrets scan, the Biome staged-paths format check, check-doc-map.js, check-digest-version.js, check-guard-registry.js and check-roadmap-valid.js — and a finding refuses the operation (mantahostels#1705). On a commit made mid-rebase or mid-cherry-pick, where \`pre-commit\` would run that whole stack, the flag leaves the secrets scan alone (mantahostels#1706). On \`git am\` it skips \`.husky/pre-applypatch\`, that route's only gate and its secrets scan (mantahostels#1707): a credential applied past it is public the moment anyone pushes. Today's git refuses it on \`git revert\` and \`git cherry-pick\` outright.

Drop the flag: on a plain commit or merge it buys nothing, and everywhere else it turns gates off.

There is no override, deliberately — an escape a session can spell for itself is not a deny (mantahostels#109). The git-hook escapes, \`WFC_ALLOW_BRANCH\` among them, each stand down one gate alone, and are the founder's to set, never yours: stop and ask (workflow-core#916).`;

/* The opening line is a plain string so guard-fire-needles.json's
 * amend-shared-tip needle reads it byte for byte. */
const DENY_AMEND = `${"This amend rewrites whichever commit is `main`'s tip right now"}, which may not be yours: @CMD@

The shared working tree holds \`main\`, and four or more sessions commit to it every few minutes. Between your own \`git commit\` and this \`git commit --amend\`, a neighbouring session's commit routinely lands — and \`--amend\` targets the tip as it stands at that instant, so the amend takes THEIR commit under YOUR message.

It fails silently in the direction that matters: the amend reports success and prints a diffstat, and the diffstat is of the neighbour's change (observed on mantahostels#2507; account at mantahostels#2540).

Make a follow-up commit instead:
  git commit -m "…" -- <paths>

Where the history really must be rewritten, do it in a throwaway worktree, where no neighbour commits:
  git worktree add --detach <dir>

A \`git commit --amend\` there is allowed.`;

/** @param {string} refusal */
const denyClosesKeyword = (refusal) =>
	`This commit message closes an issue server-side the moment it is pushed: @CMD@

${refusal}`;

/** @param {CommitFormContext} ctx */
const addWarn = (
	ctx,
) => `Staging before committing hands the shared index to whichever session commits next — that is mantahostels#63, where one session's roadmap correction landed inside another session's unrelated commit under its message.

Commit by pathspec instead, with no staging step:
  git commit -m "…" -- <paths>

${untrackedEscape(ctx)}`;

const BARE_ADVICE = `Name your own files instead:
  git commit -m "…" -- <paths>`;

/* The flags each hook-skipping subcommand gives a value in a separate word,
 * so `git merge -m --no-verify` reads its own message as no flag. List only a
 * flag measured to swallow the next word: one listed wrongly lets
 * `--no-verify` through as its value. merge and rebase share guard-pull-form's
 * table (workflow-core#302); am's was measured at mantahostels#1707. `-m` under cherry-pick
 * and revert is the MAINLINE number. */
const NV_VALUE_FLAGS = {
	merge: gitValueFlags("merge"),
	rebase: gitValueFlags("rebase"),
	"cherry-pick": "-m --mainline --cleanup",
	revert: "-m --mainline --cleanup",
	am: "--directory --exclude --include --whitespace --patch-format --quoted-cr -p -C",
};

/* The `--no-verify` spellings each accepts (mantahostels#1705, workflow-core#1706, workflow-core#1707);
 * shorter ones git rejects as ambiguous with `--no-verbose`. cherry-pick and
 * revert accept none on git 2.43.0, so their arm is PROSPECTIVE — re-measure
 * with a RESOLVABLE revision, as git dies on a bad one first. `git am` has no
 * other `--no-v…` option. */
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
const COMMIT_SWEEPS = [
	"-a",
	"-i",
	"--all",
	"--inc",
	"--incl",
	"--inclu",
	"--includ",
	"--include",
];

/* Doc map's SCOPE in scripts/lib/doc-map.js: check-doc-map.js runs in
 * .husky/pre-commit on exactly this set (mantahostels#390). */
const DOC_MAP_SCOPE =
	/^(docs\/|\.claude\/|hooks\/|self-plugin\/|AGENTS\.md$|CLAUDE\.md$|PRODUCT\.md$|DESIGN\.md$|GLOSSARY\.md$)/;
/* The two files check-digest-version.js compares: either alone is the drift. */
const DIGEST_FILES = /^docs\/(reference-roadmap\.html|roadmap-digest\.md)$/;
/* Where a guard-registry region, the guards it names and their fragments
 * live. */
const REGISTRY_FILES =
	/^(CLAUDE\.md$|AGENTS\.md$|(docs|\.claude)\/.*\.md$|scripts\/.*\.sh$|docs\/agents\/rules\/)/;
/* The languages Biome parses, outside biome.json's `includes` exclusions —
 * MIRRORED, not read: a hook must not parse config to decide whether to say
 * something, and a miss costs a rule, never a verdict. */
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
 * The flags `git commit` carries. `-m`/`--message` only feed the keyword test:
 * `-F` and `-t` name a FILE, `-c`/`-C`/`--fixup`/`--squash` a COMMIT. A
 * `--pathspec-from-file`, `dangling` or not, and a lone `-`, count as a
 * pathspec — the dangling one commits nothing, and reading it as a pathspec
 * keeps the warn down (mantahostels#495).
 * @param {string[]} args raw
 * @param {string[]} spans
 */
function scanCommit(args, spans) {
	const c = {
		sweeps: false,
		noVerify: false,
		amend: false,
		hasPathspec: false,
		/** @type {string[]} */
		words: [],
		message: "",
	};
	scanFlags(gitValueFlags("commit"), args, (kind, name, value) => {
		const set =
			kind === "flag" && Object.hasOwn(COMMIT_FLAG, name)
				? COMMIT_FLAG[name]
				: undefined;
		if (kind === "arg") {
			c.hasPathspec = true;
			c.words.push(value);
		} else if (kind === "opt" && (name === "-m" || name === "--message"))
			c.message += ` ${literal(value, spans).text}`;
		else if (set) c[set] = true;
		else if (pathspecFlag(kind, name)) c.hasPathspec = true;
	});
	return c;
}

/**
 * @param {string} kind scanFlags'
 * @param {string} name
 */
const pathspecFlag = (kind, name) =>
	name === "--pathspec-from-file"
		? kind === "opt" || kind === "dangling"
		: kind === "flag" && name === "-";

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

/* No other `git add` short flag carries an n, N or f, and none takes a value
 * in the same word. */
/** @type {[string, keyof AddFlags][]} */
const ADD_SHORT = [
	["N", "intent"],
	["n", "dry"],
	["f", "force"],
];

/**
 * The `git add` flags the guard reads.
 * @param {string[]} args raw
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
 * Whether a merge-family call skips the hooks.
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
 * A deny's text: the unset-variable line spliced after its framing paragraph
 * (workflow-core#312), paths at the plugin root, then the segment in place of the CMD
 * placeholder — after the paths, so the command is shown as typed.
 * @param {string} reason
 * @param {string} unset unsetText's
 * @param {string} segment masked
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
 * `abs` relative to `top` where it lies beneath it, else as given.
 * @param {string} top
 * @param {string} abs
 */
const relativeTo = (top, abs) =>
	abs.startsWith(`${top}/`) ? abs.slice(top.length + 1) : abs;

/**
 * One command's judging state, built by decide and threaded through the
 * functions below.
 * @typedef {object} Judging
 * @property {CommitFormContext} ctx
 * @property {ReturnType<typeof parseCommand>} parsed
 * @property {string[]} spans
 * @property {Map<string, ReturnType<CommitFormContext["treeClass"]>>} classes
 *   the walk's tree class, read again for the shared-tree gate: one git
 *   answer a tree
 * @property {string | null} denied
 * @property {string} warning the first warn found, held across segments in
 *   case a later one denies
 * @property {string} leftBehind mantahostels#1651's text, held out of
 *   `warning` so every verdict decided later outranks it (mantahostels#3280 D2)
 * @property {string[]} intentAdded what earlier segments intent-add, absolute
 *   and normalised, each argument with the untracked files git says it covers
 *   (mantahostels#3280 D1, mantahostels#3315, mantahostels#3321)
 * @property {boolean} ruleSubject
 * @property {string} ruleDir
 * @property {string[]} lastWords
 */

/**
 * A word's literal text; null where it is unreadable or empty.
 * @param {Judging} j
 * @param {string} word
 */
function known(j, word) {
	const l = literal(word, j.spans);
	return l.known && l.text ? l.text : null;
}

/**
 * @param {Judging} j
 * @param {string} dir
 */
function treeClassOf(j, dir) {
	let cls = j.classes.get(dir);
	if (cls === undefined) {
		cls = j.ctx.treeClass(dir);
		j.classes.set(dir, cls);
	}
	return cls;
}

/**
 * The arbiter's answer. No session is a defined state of the harness, so it
 * is no fault: the sweep check finds nothing and the bare warn stays
 * index-wide.
 * @param {Judging} j
 * @param {string[]} paths
 */
function commitCheck({ ctx }, paths) {
	const session = ctx.session || ctx.env.CLAUDE_CODE_SESSION_ID || "";
	return session
		? ctx.commitCheck(paths, session)
		: { sweeps: /** @type {Sweep[]} */ ([]), written: null, fault: "" };
}

/**
 * `git ls-files` under one pathspec word, or null, logged, where git errors.
 * @param {Judging} j
 * @param {{ dir: string, abs: string }} at the word, run from `dir`
 * @param {LsMode} mode
 * @param {string} ticket the verdict left unjudged
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
 * Each claimed path's paragraph and its declared-sweep line, the first
 * PATHS_SHOWN_CAP of them.
 * @param {Sweep[]} sweeps
 */
function sweepLines(sweeps) {
	let body = "";
	let swept = "";
	for (const { rel, region, holder: who } of sweeps.slice(0, PATHS_SHOWN_CAP)) {
		const holder =
			who.length > HOLDER_WIDTH ? `${who.slice(0, HOLDER_WIDTH)}…` : who;
		const subject = region ? `a claim on §${region} of it` : "a claim on it";
		body += `This commit names ${rel}, and a live session (${holder}) holds ${subject} with unsaved edits in the working tree. A pathspec commit takes the whole working-tree file, ${region ? "their region included, " : ""}so their work would be swept in under your message — that is mantahostels#1539.\n\n`;
		/* The declared-sweep line mantahostels#3270 prescribes, composed
		 * literally, not left as a template (mantahostels#3272). */
		swept += `  Swept: ${region ? `§${region}` : rel} (${holder})\n`;
	}
	const omitted = sweeps.length - PATHS_SHOWN_CAP;
	if (omitted > 0) {
		body += `… and ${omitted} more claimed path(s) this commit names.\n\n`;
		swept += `  … and ${omitted} more\n`;
	}
	return { body, swept };
}

/**
 * The pathspec-sweep warn (mantahostels#1539, whole-file and warn-only by
 * mantahostels#1560). `dir` is the commit's cwd: a pathspec is cwd-relative
 * and the arbiter resolves against the repo root.
 * @param {Judging} j
 * @param {string[]} words
 * @param {string} dir
 */
function sweepWarn(j, words, dir) {
	const { ctx } = j;
	const lits = words.map((w) => known(j, w));
	const resolved = lits.flatMap((l) => (l === null ? [] : [absAt(l, dir)]));
	if (resolved.length === 0) return;
	const { sweeps, fault } = commitCheck(j, resolved);
	if (sweeps === null)
		return ctx.log(
			`${fault} — the mantahostels#1539 sweep check was skipped for this pathspec commit`,
		);
	if (sweeps.length === 0) return;
	/* Does the pathspec name anything beyond the colliding files? Both sides
	 * are lexical, as the arbiter's are (mantahostels#3315); an unreadable word
	 * fails open to "there are other paths". */
	const collided = sweptPaths(sweeps);
	const others =
		lits.includes(null) ||
		resolved.some((p) => !collided.has(relativeTo(ctx.root, p)));
	j.warning = sweepWarning(sweeps, others);
}

/** @param {Sweep[]} sweeps */
const sweptPaths = (sweeps) => new Set(sweeps.map((s) => s.rel));

/**
 * The whole sweep warn: where the pathspec names other paths, it points at
 * them; where it does not, it hands over the Swept lines to declare.
 * @param {Sweep[]} sweeps
 * @param {boolean} others
 */
function sweepWarning(sweeps, others) {
	const { body, swept } = sweepLines(sweeps);
	return others
		? `${body}Commit your own paths instead:\n  git commit -m "…" -- <your other paths>`
		: `${body}This file is the whole pathspec, so there are no other paths to commit instead.\nCommit anyway and declare the sweep — put these lines in the commit message body (mantahostels#3270):\n${swept}`;
}

/**
 * Whether a word git tracks nothing under holds something untracked; false
 * where it was left unjudged.
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
 * The untracked-pathspec warn (mantahostels#1612): a word git tracks nothing
 * under but something untracked is there. A word matching nothing at all gets
 * no warn. IGNORED files are in scope: git rejects them too, and the message
 * carries the `-f` they need.
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
		/* CONTAINMENT (mantahostels#3318): a file intent-added inside a
		 * directory word clears that word too. */
		const bare = abs.replace(/\/$/, "");
		if (j.intentAdded.some((ia) => ia === abs || ia.startsWith(`${bare}/`)))
			continue;
		if (onlyUntracked(j, dir, abs)) list += `  ${lit}\n`;
	}
	if (!list) return;
	j.warning = `This commit names path(s) git does not track yet:\n\n${list}\nA pathspec commit cannot reach an untracked path. git answers \`error: pathspec '<path>' did not match any file(s) known to git\`, exits 1 and commits NOTHING — read that exit as "nothing to do" and the ticket looks finished with the file uncommitted (mantahostels#1612).\n\n${untrackedEscape(j.ctx)} Then commit by pathspec as normal. A path your .gitignore covers needs \`git add -f -N <path>\` by hand — the script refuses it — or it does not belong in this commit at all.`;
}

/**
 * The untracked files under a directory word that also holds tracked ones;
 * empty where it holds none, or was left unjudged.
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
 * The left-behind warn (mantahostels#1651): a directory word with tracked
 * files under it and untracked ones too. IGNORED files are excluded, or a
 * directory word would list node_modules. The ledger is not consulted: a new
 * file arriving by `cat >` is credited to nobody.
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
 * Record one intent-added argument. `git add -N src` stages every untracked
 * file under src, so a later `-- src/new.md` names a tracked path: the walk
 * happens here (mantahostels#3321), matching `git add`'s own
 * --exclude-standard, which -f widens to the ignored files.
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
 * Record what a `git add -N` segment intent-adds, for untrackedWarn
 * (mantahostels#3280 D1). -N ONLY: -n leaves the path untracked, and a bundle
 * carrying both is a dry run.
 * @param {Judging} j
 * @param {string[]} args raw
 * @param {AddFlags} flags
 * @param {string} dir the segment's own cwd
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
 * The paths a pathspec list's text names. `--pathspec-file-nul` takes every
 * character literally; otherwise a C-quoted line, git's escape for a path
 * holding a newline or a quote, is skipped and left warned.
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
 * The list a `git add -N --pathspec-from-file <file>` names
 * (mantahostels#3324), resolved against the segment's cwd. Four shapes record
 * nothing, each failing towards the warn: stdin (`-`), an unreadable list, a
 * C-quoted line, and a list this command redirects into (mantahostels#3327),
 * whose bytes at hook time are not git's.
 * @param {Judging} j
 * @param {string} word raw
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
 * Whether one redirect truncates into `file`. A target that will not resolve
 * is read as the list, the direction that keeps the warn; a relative one's
 * basename is compared too, a `git -C` moving the list but not the redirect.
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
 * Whether any segment of this command truncates into `file`. TRUNCATING
 * redirects only, and `<>`: `>>` keeps the stale lines, a subset only ever
 * failing towards the warn. A `tee`, `sed -i` or script rewriting it passes
 * unseen.
 * @param {Judging} j
 * @param {string} file normalised absolute
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
 * The bare-commit warn (mantahostels#118): the staged paths this session
 * never wrote; the index-wide warn (mantahostels#117) where the ledger is
 * unavailable.
 * @param {Judging} j
 * @param {string[]} staged
 */
function bareWarn(j, staged) {
	const { written, fault } = commitCheck(j, []);
	if (written === null && fault)
		j.ctx.log(
			`${fault} — the write ledger was unread, so this bare commit's warn stays index-wide`,
		);
	if (written !== null) {
		/* Whole line, literal: docs/a.md in the ledger claims no credit for a
		 * neighbour's docs/a.md.bak. */
		const mine = new Set(written);
		const foreign = staged.filter((p) => !mine.has(p));
		if (foreign.length === 0) return;
		j.warning = `This commit names no pathspec, so it takes the whole index — and the index holds ${foreign.length} path(s) this session never wrote:\n\n${foreign.map((p) => `  ${p}`).join("\n")}\nThe index is repo-global, so this commit would land someone else's staged work under your message (mantahostels#63). If you did write one of those from a shell redirect or a script, the ledger cannot see it and it is listed anyway.\n\n${BARE_ADVICE}`;
		return;
	}
	j.warning = `This commit names no pathspec, so it will take everything in the index:\n\n${staged.map((p) => `  ${p}`).join("\n")}\nThe index is repo-global — any of those files may be a parallel session's staged work, which this commit would land under your message (mantahostels#63). This session's writes could not be read, so the guard cannot tell whose they are; check before proceeding.\n\n${BARE_ADVICE}`;
}

/**
 * Whether the shared index is at stake in `tree`: a linked worktree has its
 * own (mantahostels#1213).
 * @param {Judging} j
 * @param {string} tree
 */
const sharedAtRest = (j, tree) =>
	treeClassOf(j, tree) === "shared" && !j.ctx.midSequence(tree);

/**
 * A `git add`/`stage`. Its intent-adds are read in every tree, as the verdict
 * they feed binds in a linked worktree too.
 * @param {Judging} j
 * @param {string[]} args
 * @param {string} tree
 */
function judgeAdd(j, args, tree) {
	const add = addFlags(args);
	scanIntentAdded(j, args, add, tree);
	/* -N stages a name and no content; -n stages nothing. */
	if (add.intent || add.dry || j.warning || !sharedAtRest(j, tree)) return;
	j.warning = addWarn(j.ctx);
}

/**
 * A pathspec commit's two untracked warns. They bind in every tree — git
 * rejects an unmatchable pathspec there too — and stand down mid-sequence,
 * where git refuses a partial commit itself.
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
 * A shared-tree commit's index warns: the sweep warn on a pathspec, the bare
 * warn on whatever the index holds without one.
 * @param {Judging} j
 * @param {ReturnType<typeof scanCommit>} c
 * @param {string} tree
 */
function indexWarn(j, c, tree) {
	if (j.warning) return;
	if (c.hasPathspec) return sweepWarn(j, c.words, tree);
	const staged = j.ctx.stagedFiles(tree);
	if (staged === null)
		return j.ctx.log(
			`git could not read the index in ${tree} — pathspec-less commit allowed unchecked`,
		);
	if (staged.length > 0) bareWarn(j, staged);
}

/**
 * One `git add`/`stage`/`commit` or merge-family call against any working
 * tree of this repo.
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
		/* Nothing else about the merge family is judged: none stages a
		 * pathspec. Judged in every tree and mid-sequence too. */
		if (skipsHooks(/** @type {keyof typeof NV_SPELLINGS} */ (sub), args))
			deny(DENY_NO_VERIFY);
		return;
	}
	j.ruleSubject = true;
	if (sub !== "commit") return judgeAdd(j, args, tree);
	/* `commit` alone scopes the §Gotchas rules (mantahostels#1805): they are
	 * about gates that fire at commit time. The last commit wins. */
	j.ruleDir = tree;
	const c = scanCommit(args, j.spans);
	j.lastWords = c.words;
	if (c.noVerify) return deny(DENY_NO_VERIFY);
	const match = closingMatch(c.message);
	if (match !== null)
		return deny(denyClosesKeyword(j.ctx.closingRefusal(match)));
	if (c.hasPathspec) untrackedWarns(j, c.words, tree);
	/* Everything past here protects the SHARED index. */
	if (!sharedAtRest(j, tree)) return;
	if (c.sweeps) return deny(denySweeping(j.ctx));
	/* Below the shared-tree gate and the mid-sequence stand-down: neither a
	 * linked worktree's HEAD nor a rebase's is `main`'s tip (mantahostels#2540). */
	if (c.amend) return deny(DENY_AMEND);
	indexWarn(j, c, tree);
}

/**
 * Each readable word, joined to `dir` where relative, relative to `dir`'s
 * repo root, so one set of patterns judges every source.
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
 * The paths one `node …/commit-paths.js` call would land, for the §Gotchas
 * scoping (workflow-core#2147).
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

/**
 * A `node …/commit-paths.js` call runs no git the walk sees, and already
 * commits by pathspec (workflow-core#2022); the paths it would land feed the §Gotchas
 * scoping as a pathspec does (workflow-core#2147).
 * @param {Judging} j
 */
function commitPathsCalls(j) {
	let subject = false;
	/** @type {string[]} */
	const paths = [];
	walkCommands(
		j.parsed,
		(cmd) => {
			const cpArgs = commitPathsArgs(cmd.words, j.spans);
			if (cpArgs === null) return;
			subject = true;
			const call = commitPathsParse(cpArgs, j.spans);
			if (call !== null) paths.push(...commitPathsWords(j, call, cmd.cwd));
		},
		j.ctx,
	);
	return { subject, paths };
}

/**
 * The commit rules, scoped by the paths the commit names.
 *
 * PRIORITY ORDER, highest first, as the ceiling defers the tail: the three
 * about the act itself, then the gates by what a session loses to each — a
 * local FAIL first, the sweep-only WARN last — and push-cadence, which binds
 * after the commit, closing (workflow-core#2285). THE SCOPING IS AN EXCLUSION: each skip
 * states its own condition (mantahostels#1805).
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
			"push-cadence-landing",
		],
		skip: [
			...(j.ruleSubject ? [] : ["commit-pathspec"]),
			...ruleModule(ctx, "roadmap", ["digest-version-drift"]),
			...ruleModule(ctx, "governance", [
				"doc-map-precommit",
				"superseded-values-gate",
			]),
			...ruleModule(ctx, "landing", ["push-cadence-landing"]),
			...ruleUnlessModule(ctx, "landing", ["push-cadence"]),
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
		classes: new Map(),
		denied: null,
		warning: "",
		leftBehind: "",
		intentAdded: [],
		ruleSubject: false,
		ruleDir: "",
		lastWords: [],
	};
	walkGit(
		parsed,
		(call) => judge(j, call),
		{ ...ctx, treeClass: (dir) => treeClassOf(j, dir) },
		{
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
		},
	);
	if (j.denied !== null) return { deny: j.denied };

	const cp = commitPathsCalls(j);
	/* mantahostels#1651's verdict claims the slot last, and only where nothing
	 * decided later took it (mantahostels#3280 D2). */
	const warning = j.warning || j.leftBehind;
	if (warning) return { injectRules: [], prelude: ctx.corePaths(warning) };

	if (!j.ruleSubject && !cp.subject) return null;
	const paths = [...cp.paths];
	if (j.ruleDir)
		paths.push(
			...repoRelative(j, j.ruleDir, j.lastWords),
			/* An unreadable index selects no rules from it: an advisory read
			 * fails open (mantahostels#103 §6). */
			...(ctx.stagedFiles(j.ruleDir) ?? []),
		);
	return commitRules(j, paths);
}

module.exports = {
	field: "command",
	noun: "command",
	decide,
	sweepWarning,
	sweptPaths,
};
