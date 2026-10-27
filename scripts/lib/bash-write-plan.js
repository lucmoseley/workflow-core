/*
 * bash-write-plan.js — what one Bash command writes, read off its parse, for
 * lib/claimed-bash-write.js's judge (#2788): the tier-1 targets it warns on,
 * the code paths it credits, the selection ledger's paths, and whether a
 * whole-file restore owes its rule.
 *
 * THE ROUTES IT READS are lib/shell-parse.js's writeTargets, every spelling
 * the guard tier reads (#1827): nine write routes, three deletions.
 *
 * AND A TENTH ARM THAT RESOLVES NOTHING (mantahostels#2854). Where a command
 * runs an INLINE INTERPRETER — `python`, `python3`, a versioned `python3.12`,
 * `node` or `nodejs`, with `-c` (python) or `-e`/`--eval`/`-p`/`--print`
 * (node), or with a heredoc or here-string — every tier-1 path the command
 * QUOTES anywhere is handed to the judge as a candidate. Both limbs are
 * required: a plain `grep 'docs/x.md'` has the path and not the interpreter,
 * and says nothing.
 *
 * WHY IT CANNOT RESOLVE ONE. The destination is a string inside a program in
 * another language, and this read-modify-write is the form the Bash route's
 * unannounced share is made of (mantahostels#2833). The arm names candidates
 * and the judge decides which of them a live neighbour holds, so a command
 * quoting five paths of which one is held still produces one line. The credit
 * half (mantahostels#2778) is not extended to it — `addTarget` carries why —
 * but every path-shaped candidate, of ANY tier, goes on the SELECTION ledger
 * instead (#1220), which test selection alone reads.
 *
 * AND THE PATHS AN `rm`, `git rm` OR `git mv` NAMES GO ON THAT LEDGER TOO, and
 * nowhere else (#1791): a deletion through Bash mints no write, so an overlay
 * test run kept HEAD's copy of a file the session had removed. A deletion's
 * paths cost one `git ls-files` first, so scratch under `.claude/tmp/` is
 * never noted. A host whose tests never read the ledger notes nothing (#1245).
 *
 * WHAT IT COSTS is on mantahostels#2854: its firing and false-warn rates, and
 * the per-session candidate distribution the budget rests on. Those rates
 * OVER-COUNT by an unmeasured margin (mantahostels#2865): they predate the
 * scan's stop at the script. Re-deriving means re-running
 * scripts/measure-bash-write-firing/, never adjusting the numbers.
 *
 * LIMITS
 *  - The NINE ROUTES read the PARSED command form, never a substring, so a
 *    grep, an echo or a heredoc MENTIONING a guarded path passes them. Quoted
 *    spans and heredoc bodies are removed before parsing (mantahostels#123) —
 *    which also means a heredoc's own redirect target IS read, but its body
 *    is not.
 *  - THE TENTH ARM IS THE INVERSE, a mention being all it has. Its scan is
 *    over the RAW command string and its scope is the WHOLE command rather
 *    than the interpreter's own segment, because a heredoc body belongs to no
 *    segment at all — so `node -e '…' && grep "docs/x.md" y` names the grep's
 *    path too. It reads the cwd the command ENDS in, so a `cd` that stays
 *    moved drops every relative candidate — a missed warn, the direction this
 *    guard errs. A quote must be closed by its own kind and escapes are not
 *    read, so `node -e "a(\"docs/z.md\")"` — a backslashed inner quote — is the
 *    arm's largest miss class. CANDIDATE ORDER IS BY QUOTE KIND, never source
 *    order — quotedTokens makes one pass per quote character — so nothing
 *    downstream may read the list positionally.
 *  - AN INLINE PROGRAM ARRIVING BY PIPE is not read (mantahostels#2865):
 *    `echo '…' | python3` is inline by every measure this arm cares about, and
 *    inlineInterp needs a flag or a heredoc opener on the interpreter's own
 *    word list to say so. The heredoc route (`python3 - <<'PY'`) is the stdin
 *    spelling that IS read.
 *  - A write by any other spelling — `dd of=`, `install`, `rsync`, a wrapper
 *    script, `xargs` — is not seen, the first three having been measured as
 *    too rare to read (mantahostels#2854 §Not in scope).
 *  - What writeTargets leaves unread is unread here: `git checkout <path>`
 *    without `--`, a git global option, a command word behind `sudo` or `env`.
 *  - A RELATIVE target is read only where the command runs in the directory
 *    the walk started in (mantahostels#2807): where a `cd` has moved it off,
 *    the same spelling names a file this hook is not reading. cdStep carries
 *    how the cwd is tracked and which way each miss errs. A `cd` spelled
 *    anywhere the walk does not see it — inside a script it runs, an
 *    `env --chdir`, a `git -C` — leaves it believing it never moved, and THAT
 *    is the direction that still over-bills. The file need not EXIST:
 *    requiring it would go silent on every redirect creating a new file, which
 *    is the dominant form here.
 *  - A join mantahostels#287 named stays open: a write-shaped line swallowed
 *    into a mis-paired multi-line string above it is invisible. The guarded
 *    head is not widened to bound that join (mantahostels#1818): it made
 *    `guard-npm-install.js` deny a benign command whose prose named an install.
 *  - The tier test in addTarget only saves the store a read: claim-warning.js's
 *    `isGuarded` decides, and drift here makes it UNDER-fire — a missed
 *    warning, never a wrong one.
 *  - The credit half inherits EVERY limit above: a spelling not read, a target
 *    behind a variable, a heredoc body. So it narrows the mantahostels#2778 gap
 *    rather than closing it (mantahostels#296).
 *  - THE WHOLE-FILE RESTORE RULE (#2028) reads three of the nine routes — a
 *    `cp` or `mv` destination, a `git restore` path, a `git checkout --` path
 *    — over any tier, plus every word of a `git checkout` with no `--`, and
 *    fires only where `git diff HEAD` finds the path changed. A `Write`
 *    putting a whole file back and a `git -C` restore are never seen, and the
 *    rule lands with the command's result, after the restore has run. It never
 *    denies: `git restore -- <your paths>` is the sanctioned discard (#1953),
 *    and whose edits a changed file holds cannot be read off the command — the
 *    inference mantahostels#103 warns on.
 */

const { normAbs, parseCommand, walkCommands } = require("./shell-parse.js");
const { literal } = require("./shell-words.js");

/**
 * lib/code-signal.sh's CODE globs, spelled again here, in TWO LIMBS because
 * that array has two: the extensions, and `.husky/` — the six Husky hooks
 * carry no extension and the globs miss them (mantahostels#2779). A drift
 * makes the core credit a file the backstop does not count — inert, the
 * backstop intersecting with its own diff — or miss one it does, reopening
 * mantahostels#2778's gap silently; claimed-bash-write.test.ts holds the two in
 * step.
 */
const CODE_EXT = ["js", "mjs", "cjs", "ts", "tsx", "jsx", "py", "sh"];
const CODE_DIR = ".husky/";

const CODE_RE = new RegExp(`\\.(${CODE_EXT.join("|")})$`);

/** The refusing tier, as a prefix test that only saves the store a read. */
const TIER1 = /^(docs\/|\.claude\/|CLAUDE\.md$|AGENTS\.md$)/;

/** The words that may stand before a `cd` without being its command. */
const CD_PREFIX = new Set([
	"{",
	"(",
	"do",
	"then",
	"else",
	"elif",
	"builtin",
	"command",
	"eval",
	"time",
	"!",
]);

/** The interpreters whose inline program the tenth arm reads. */
const INTERPRETER = /^(python|python[0-9].*|node|nodejs)$/;

/** The routes whose write puts a whole file back (#2028). */
const RESTORE_ROUTES = ["cp", "mv", "git restore", "git checkout"];

/**
 * @typedef {import("./guard-dispatch.js").CoreContext} Ctx
 * @typedef {{ targets: string[], credit: string[], select: string[],
 *   deleted: string[], restored: string[] }} Writes what one command writes:
 *   the tier-1 targets, absolute; the code paths to credit, the paths for the
 *   selection ledger, those a deletion names and those a whole-file restore
 *   writes, repo-relative
 */

/**
 * A word's repo-relative spelling, or null where it is not inside the repo.
 * Purely textual: a write target need not exist, nor its parents, so two
 * spellings of one path can reach the judge separately, which costs a
 * duplicate line at worst. A `..` segment climbs back out of the repo and the
 * prefix test cannot see it, so it is rejected rather than resolved
 * (mantahostels#2778).
 * @param {string} abs
 * @param {string} root
 */
function relPath(abs, root) {
	if (!abs.startsWith(`${root}/`)) return null;
	const rel = abs.slice(root.length + 1);
	return /(^|\/)\.\.(\/|$)/.test(rel) ? null : rel;
}

/**
 * Every quoted whitespace-free token in `text`, deduplicated.
 *
 * IT READS THE RAW COMMAND STRING, never the parsed words: the path this arm
 * looks for is a string inside a program in another language, so it is either
 * a heredoc body the parser has dropped as data or a span it has already
 * blanked to a sentinel.
 *
 * THREE PASSES, NOT ONE CHARACTER CLASS, so an opening quote must be closed by
 * its OWN kind — `"docs/a.md'` is not a token. Backticks are read because a
 * node heredoc's template literal is the ordinary spelling there.
 * @param {string} text
 */
function quotedTokens(text) {
	/** @type {Set<string>} */
	const seen = new Set();
	for (const q of ["'", '"', "`"])
		for (const m of text.matchAll(new RegExp(`${q}[^${q}\\s]+${q}`, "g")))
			seen.add(m[0].slice(1, -1));
	return [...seen];
}

/**
 * Does this command run its program from the command line, or from a heredoc
 * or here-string, rather than from a script file (mantahostels#2854)? `-c` for
 * python, `-e`/`--eval`/`-p`/`--print` for node, and a heredoc or here-string
 * opener for either — only a heredoc's BODY is dropped as data.
 *
 * A PIPE IS NOT READ (mantahostels#2865): treating a bare `python3` as inline
 * would fire on every `python3` in a pipeline.
 *
 * THE SCAN STOPS AT THE SCRIPT, and must: a flag past the module or file name
 * belongs to the PROGRAM, not to the interpreter, so scanning the whole word
 * list fired on `python3 -m pip install -c "docs/x.md"` and on
 * `node scripts/foo.js -e "docs/x.md"`, neither of which runs an inline
 * program. A bare `-` reads as a flag, which is what `python3 - <<'PY'` needs.
 *
 * TWO MISSED WARNS IT COSTS, both the safe direction: a bundled short option
 * (`python3 -uc '…'` is valid and reads as no inline flag), and a
 * separate-value flag before the inline one (`python3 -W ignore -c '…'` stops
 * at `ignore`).
 *
 * THE HEREDOC TEST IS BOUNDED BY THAT STOP (mantahostels#2865), not
 * unconditional: `node script.js <<'EOF'` stops at `script.js`, so a heredoc
 * feeding DATA to a script file says nothing.
 * @param {string} prog
 * @param {string[]} args
 * @param {() => { kind: string }[]} redirects
 */
function inlineInterp(prog, args, redirects) {
	const flag = prog.startsWith("node") ? /^(-e|--eval|-p|--print)/ : /^-c/;
	for (const word of args) {
		if (flag.test(word)) return true;
		if (!word.startsWith("-")) return false;
	}
	return redirects().some(
		(r) => r.kind === "heredoc" || r.kind === "here-string",
	);
}

/**
 * @typedef {{ abs: string, rel: string }} Place
 * @typedef {{ spans: string[], seed: string, cwd: string, root: string,
 *   out: Writes }} Reading `seed` is where the walk starts, `cwd` where the
 *   command now stands, "" where unknown
 */

/**
 * A word's absolute and repo-relative spellings, or null where it cannot be
 * read: an unexpanded `$VAR` or a command substitution is dropped rather than
 * guessed at, which is what keeps the credit list from ever naming a path this
 * command may not be writing.
 * @param {string} word
 * @param {Reading} rd
 * @param {boolean} away whether the command runs off the walk's start
 * @returns {Place | null}
 */
function place(word, rd, away) {
	const lit = literal(word, rd.spans);
	if (!lit.known || !lit.text || lit.text.startsWith("-")) return null;
	const text = lit.text.replace(/^\.\//, "");
	if (!text.startsWith("/") && away) return null;
	const abs = text.startsWith("/") ? text : `${rd.seed}/${text}`;
	const rel = relPath(abs, rd.root);
	return rel === null ? null : { abs, rel };
}

/**
 * One word sorted into the lists. A path can land in both the tier-1 and the
 * code list: `.claude/skills/x/run.sh` is both.
 *
 * `candidate` is the inline-interpreter arm's (mantahostels#2854), whose paths
 * are merely QUOTED somewhere in the command rather than resolved as its write
 * destination: warned about and never credited, crediting the write ledger
 * needing a resolved target and mantahostels#114 barring over-billing. It goes
 * on the selection list instead where it is path-shaped — a `/` or a `.` and
 * no byte a path here never carries — which keeps `'utf-8'` and `'\n'` off it;
 * anything else that gets through is inert, the reader intersecting with git's
 * dirty set. `delete` is the deletion arms' (#1791): the deleted list alone,
 * never warned.
 * @param {Place | null} at
 * @param {"write" | "candidate" | "delete"} mode
 * @param {Writes} out accumulator: the word is pushed onto its lists
 */
function addTarget(at, mode, out) {
	if (!at) return;
	if (mode === "delete") {
		out.deleted.push(at.rel);
		return;
	}
	if (TIER1.test(at.rel)) out.targets.push(at.abs);
	if (mode === "candidate") {
		if (/^[A-Za-z0-9._@+/-]+$/.test(at.rel) && /[./]/.test(at.rel))
			out.select.push(at.rel);
		return;
	}
	if (CODE_RE.test(at.rel) || at.rel.startsWith(CODE_DIR))
		out.credit.push(at.rel);
}

/**
 * A command word's text after its last `/`, as bash's longest-prefix strip to
 * a slash reads one.
 * @param {string} word
 * @param {string[]} spans
 */
function commandName(word, spans) {
	const text = literal(word, spans).text;
	return text.slice(text.lastIndexOf("/") + 1);
}

/**
 * Move the running cwd past a `cd`, `pushd` or `popd`; false where the command
 * is none of them (mantahostels#2807).
 *
 * TRACKED TEXTUALLY, AND ONLY AS FAR AS IT READS. lib/shell-parse.js's walk
 * cwd is NOT used: it reads an unset `$VAR` as empty and stays put, so
 * `cd "$WT"` would leave the core crediting the shared tree's copy of every
 * relative target after it. Here an unreadable target, a bare `cd`, a `pushd`
 * and a `popd` all make the cwd unknown, which costs a missed credit, never a
 * wrong one — and a subshell's `)` is not read either, so `(cd /x && …); tee
 * y.sh` stays moved for the rest of the command, the same safe direction.
 *
 * THE HEAD IS FOUND PAST ANY GROUPING OR BUILTIN PREFIX, which the routes do
 * NOT do: reading MORE cds only ever moves a target from credited to dropped,
 * whereas widening the write routes is a separate call. `\cd` too — a leading
 * backslash suppresses alias lookup and runs the same builtin.
 * @param {string[]} words
 * @param {Reading} rd accumulator: its cwd is moved
 */
function cdStep(words, rd) {
	const lits = words.map((w) => literal(w, rd.spans));
	const at = lits.findIndex((l) => !CD_PREFIX.has(l.text));
	const head = lits[at]?.text ?? "";
	if (head === "pushd" || head === "popd") {
		rd.cwd = "";
		return true;
	}
	if (head !== "cd" && head !== "\\cd") return false;
	const dest = lits[at + 1];
	if (!dest?.known || !dest.text) rd.cwd = "";
	else if (dest.text.startsWith("/")) rd.cwd = normAbs(dest.text);
	// A relative hop off an unknown cwd is still unknown.
	else if (rd.cwd) rd.cwd = normAbs(`${rd.cwd}/${dest.text}`);
	return true;
}

/**
 * One command's writes, into the lists.
 * @param {import("./shell-parse.js").Command} cmd
 * @param {Reading} rd
 * @returns {boolean} whether it runs an inline interpreter
 */
function readCommand(cmd, rd) {
	if (cdStep(cmd.words, rd)) return false;
	const away = rd.cwd !== rd.seed;
	const rows = cmd.writeTargets();
	// `mv` destroys its sources, so a held one is clobbered as a write's is.
	for (const t of rows)
		addTarget(
			place(t.target, rd, away),
			t.mode === "delete" ? "delete" : "write",
			rd.out,
		);
	noteRestores(cmd.words, rows, rd, away);
	const prog = commandName(cmd.words[0] ?? "", rd.spans);
	return (
		INTERPRETER.test(prog) &&
		inlineInterp(
			prog,
			cmd.words.slice(1).map((w) => literal(w, rd.spans).text),
			cmd.redirects,
		)
	);
}

/**
 * What `subject` writes, read off its parse.
 * @param {string} subject
 * @param {Ctx} ctx
 * @returns {Writes}
 */
function writes(subject, ctx) {
	const parsed = parseCommand(subject);
	const seed = normAbs(
		typeof ctx.cwd === "string" && ctx.cwd.startsWith("/")
			? ctx.cwd
			: ctx.fallbackCwd,
	);
	/** @type {Reading} */
	const rd = {
		spans: parsed.spans,
		seed,
		cwd: seed,
		root: ctx.root,
		out: { targets: [], credit: [], select: [], deleted: [], restored: [] },
	};
	let inline = false;
	walkCommands(
		parsed,
		(cmd) => {
			if (readCommand(cmd, rd)) inline = true;
		},
		{ ...ctx, bareRedirects: true },
	);
	if (inline) {
		const raw = { ...rd, spans: [] };
		for (const tok of quotedTokens(subject))
			addTarget(place(tok, raw, rd.cwd !== seed), "candidate", rd.out);
	}
	return rd.out;
}

/**
 * The whole-file restores among `rows`, picked by their route, and every word
 * of a `git checkout` with no `--`, which writeTargets leaves unread because
 * the word is as often a revision: each is a candidate.
 * @param {string[]} words
 * @param {import("./shell-parse.js").WriteTarget[]} rows
 * @param {Reading} rd accumulator: each restore is pushed onto out.restored
 * @param {boolean} away
 */
function noteRestores(words, rows, rd, away) {
	/** @param {string} word */
	const note = (word) => {
		const at = place(word, rd, away);
		if (at) rd.out.restored.push(at.rel);
	};
	for (const t of rows)
		if (t.mode === "write" && RESTORE_ROUTES.includes(t.route)) note(t.target);
	const [git = "", sub = "", ...rest] = words;
	if (commandName(git, rd.spans) !== "git") return;
	if (literal(sub, rd.spans).text !== "checkout" || rest.includes("--")) return;
	let value = false;
	for (const word of rest) {
		if (value) value = false;
		else if (["-b", "-B", "--orphan"].includes(word)) value = true;
		else if (!word.startsWith("-")) note(word);
	}
}

/**
 * The tracked files a deletion's paths are or hold — a directory `rm -r`
 * names expanding to its files — for the selection ledger. Literal, so a `*`
 * in a path is no glob. A git that will not answer notes none of them, logged.
 * @param {string[]} deleted
 * @param {Ctx} ctx
 * @returns {string[]}
 */
function readTrackedDeletions(deleted, ctx) {
	if (deleted.length === 0) return [];
	const r = ctx.git(
		["--literal-pathspecs", "ls-files", "-z", "--", ...deleted],
		[],
	);
	if (!r.ok) {
		ctx.log(
			`git ls-files failed (${r.why}) — a deletion's tracked files went unnoted in the selection ledger`,
		);
		return [];
	}
	return r.out.split("\0").filter(Boolean);
}

/**
 * Whether the host's tests read the selection ledger. Its one reader is
 * run-vitest.js's overlay, so a host whose `test` script never runs it notes
 * nothing nothing reads (#1245). The match is lexical, on the script's text:
 * mantahostels's resolve-core.js wrapper names run-vitest.js and matches, and
 * a wrapper that does not name it drops the note. A host with no or an
 * unreadable package.json is the expected non-reader, no fault worth logging.
 * @param {Ctx} ctx
 */
function isSelectionReader(ctx) {
	let text;
	try {
		text = ctx.readText("package.json");
	} catch {
		/* An unreadable package.json is a non-reader, as an absent one is. */
		return false;
	}
	return text !== null && /"test": *"[^"]*run-vitest\.js/.test(text);
}

/**
 * Whether a restore would discard uncommitted changes (#2028): against HEAD,
 * so a staged edit counts. HEAD is resolved first because outside a
 * repository `git diff` falls back to --no-index. A git that cannot answer
 * stays silent on the restore, and logs why.
 * @param {string[]} restored
 * @param {Ctx} ctx
 */
function restoreOwed(restored, ctx) {
	if (restored.length === 0) return false;
	const head = ctx.git(["rev-parse", "--verify", "--quiet", "HEAD"], [1]);
	if (!head.ok || !head.out.trim()) {
		ctx.log("HEAD did not resolve — a whole-file restore went unjudged");
		return false;
	}
	const diff = ctx.git(
		["--literal-pathspecs", "diff", "--name-only", "HEAD", "--", ...restored],
		[],
	);
	if (!diff.ok) {
		ctx.log(
			`git diff failed (${diff.why}) — a whole-file restore went unjudged`,
		);
		return false;
	}
	return diff.out.trim() !== "";
}

/**
 * What the judge is handed for `subject`: its writes, the selection list
 * narrowed to a host that reads it, and whether a restore is owed its rule.
 * @param {string} subject
 * @param {Ctx} ctx
 * @returns {Writes & { owed: boolean }}
 */
function plan(subject, ctx) {
	const w = writes(subject, ctx);
	w.select.push(...readTrackedDeletions(w.deleted, ctx));
	if (!isSelectionReader(ctx)) w.select = [];
	return { ...w, owed: restoreOwed(w.restored, ctx) };
}

module.exports = { plan };
