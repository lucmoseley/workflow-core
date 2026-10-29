/*
 * root-scratch.js — the dispatcher core that refuses a scratch file at the
 * repo root (mantahostels#2340, ruled at mantahostels#2323; made a deny at
 * mantahostels#2436).
 *
 * `docs/environment.md` §12 names `.claude/tmp/` as the one sanctioned in-repo
 * scratch directory (mantahostels#2089).
 *
 * WHAT IT REFUSES: one predicate, reached by two routes.
 *
 *   A Bash write by any spelling lib/shell-parse.js's writeTargets reads
 *   (#1827), or a Write, Edit or NotebookEdit path (mantahostels#3380), whose
 *   target resolves to a DOT-PREFIXED path sitting DIRECTLY at the repo root,
 *   and which is neither gitignored nor tracked.
 *
 *   - dot-prefixed and directly at the root: `.claim2340.tmp`, `.i2340.out`,
 *     `.rev2216.out`. A target with a slash in it — `.claude/tmp/x`,
 *     `docs/research/y` — is a considered location and never this core's
 *     business.
 *   - NOT GITIGNORED, because `.gitignore` is the line between a sanctioned
 *     root dotfile (`.env*`, `.pnp.*`, an adopter's own markers) and a stray.
 *     This repo's guard tier writes no root marker: its markers sit under
 *     `.claude/tmp/markers`, and `.sweep-autofire` in the git common dir.
 *   - NOT TRACKED, because `.gitignore` and `.mcp.json` are root dotfiles that
 *     are neither ignored nor scratch.
 *
 * TWO LEGITIMATE ROOT WRITES ARE REFUSED BY IT, and the `dd` escape the
 * refusal names is what carries them: a mutation arm breaking the
 * declined-Markdown-tooling guarantee, across every name
 * `markdown-tooling-declined.test.ts` enumerates (`.remarkrc`, `.prettierrc`,
 * `.textlintrc`, `.prettierignore`, `.lycheeignore`), and a temp `tsconfig`
 * whose `extends` globs resolve relative to itself. GITIGNORING THEM IS NOT
 * THE FIX: the gitignore limb means "sanctioned root dotfile", and these are
 * its opposite. NOR IS AN IN-CORE ALLOWLIST of those six names: it would have
 * to be kept in step with a test file by hand, and it would silently permit a
 * real stray that happens to be called `.prettierrc`.
 *
 * NO LATCH (mantahostels#2436): a latched deny would allow every stray after
 * the first, so each refusal fires on its own.
 *
 * LIMITS
 *  - The Bash limb reads writeTargets' spellings and no others, so `dd of=`, a
 *    heredoc body and a script that writes on the session's behalf are
 *    unread. The escape is `dd` for that reason.
 *  - A word the reader takes for a file and is not — a `sed` script, a
 *    bundled `perl -pe`'s code — is refused only where it is itself a bare
 *    dot-prefixed name.
 *  - A file-tool path is not normalised beyond `./` and `/./`, so `docs/../.x`
 *    or `//.x` passes.
 *  - A target it cannot read literally is judged as a SYNTHETIC WHOLE NAME
 *    (mantahostels#2372): every `${…}`, `$(…)`, `$VAR` and backtick span
 *    becomes a single `X`, and that name goes through the same two git reads.
 *    So `.a2357.$c.json` is refused, while `.env.$SID` is claimed by
 *    `.gitignore`'s `.env*` and stays silent. The TRACKED limb is asked as a
 *    pathspec with each span as `*` instead, a placeholder being a name no
 *    file can carry — so a tracked `.envrc.$e` is seen, at the cost of any
 *    tracked sibling matching the glob silencing it.
 *    WHAT IS STILL NOT READ: a `.gitignore` pattern constraining the VARIABLE
 *    span rather than the suffix — `.mut-[0-9]*.out` claims the real name and
 *    not `.mut-X.out`, so a sanctioned file is refused. Nor an UNQUOTED `$(…)`
 *    or backtick: the flattener splits it into a segment of its own, leaving
 *    the redirect a fragment (`.a$`) no synthetic name can be built from.
 *    Quoted, the span survives the split and is read.
 *  - A `cd` earlier in the same command string is not read: a relative target
 *    resolves against the hook's own directory. It costs a miss where the `cd`
 *    leaves the repo and a false refusal where it enters it.
 *  - A command run outside Claude Code sees no hook.
 *  - A `git` that cannot answer `check-ignore` or `ls-files` allows the write,
 *    recorded — the house fail-open (mantahostels#103 §6).
 */

const { parseCommand, walkCommands } = require("./shell-parse.js");
const { absolute, literal } = require("./shell-words.js");
const { remedyKind } = require("./scratch-remedy.js");
const { shellQuote } = require("./sh-quote.js");

/**
 * @typedef {import("./guard-dispatch.js").CoreContext} CoreContext
 * @typedef {import("./guard-entry.js").Decision} Decision
 * @typedef {{ shown: string, name: string }} Stray the stray as written, which
 *   the refusal quotes, and the same target repo-root-relative, which its
 *   suggested spelling is built from
 */

class GitUnanswered extends Error {}

/*
 * The span shapes literal cannot resolve: `${…}`, `$(…)`, a backtick
 * substitution, `$VAR`, a special parameter (`$$`, `$1`, `$?`, `$!`, `$@`,
 * `$#`, `$*`, `$-`) and the index-plus-\x01 tail a sentinel naming an
 * unrecorded span leaves behind. The two bracketed forms exclude their OWN
 * opening bracket, so a nested span matches innermost-first and the outer one
 * on the next pass.
 */
const RE_SPAN = new RegExp(
	[
		"\\$\\{[^{}]*\\}",
		"\\$\\([^()]*\\)",
		"`[^`]*`",
		"\\$[A-Za-z_][A-Za-z0-9_]*",
		"\\$[-0-9*@#?$!]",
		"[0-9]*\x01",
	].join("|"),
);

/**
 * Every unreadable span of `s` replaced by `ph`, so a name literal APART from
 * an expansion can still be judged whole: `X` for the name `.gitignore` is
 * asked about, an ordinary character so a glob there claims it as it claims
 * the real one; `*` for the pathspec the tracked limb is asked with. Null
 * where something unreadable survives — an unterminated `${`, say.
 * @param {string} s
 * @param {string} ph
 */
function synthesise(s, ph) {
	let out = s;
	for (let m = RE_SPAN.exec(out); m; m = RE_SPAN.exec(out))
		out = out.replace(m[0], ph);
	return /[$`]/.test(out) || out.includes("\x01") ? null : out;
}

/**
 * Is `p` a repo-root dot-prefixed path that git treats as neither ignored nor
 * tracked? A SYNTHETIC `p` comes with `syn`: the same target as the caller
 * wrote it, which the refusal quotes so a placeholder never reaches the page,
 * and with each span as `*` for the tracked limb.
 * @param {string} given
 * @param {CoreContext} ctx
 * @param {{ orig: string, glob: string }} [syn]
 * @returns {string | null} the stray's repo-root-relative name, as written
 */
function readStrayName(given, ctx, syn) {
	/** @param {string} s */
	const abs = (s) => absolute(s, ctx.fallbackCwd);
	/* `./.foo` and `.foo` are the same target; nothing else is normalised. */
	const p = abs(given).replace("/./", "/");
	/* The same fold on the original could land inside a span the placeholder
	 * stands for, deleting a `.` the session wrote. */
	const orig = syn ? abs(syn.orig) : p;
	const prefix = `${ctx.root}/`;
	if (!p.startsWith(prefix)) return null;
	const name = p.slice(prefix.length);
	/* A slash left means a subdirectory, which is a chosen location. */
	if (name.includes("/") || !/^\..+$/s.test(name) || name === "..") return null;
	const ignored = ctx.git(["check-ignore", "--", name], [1]);
	if (!ignored.ok)
		throw new GitUnanswered(
			`git check-ignore could not answer for ${name} — write allowed unchecked`,
		);
	if (ignored.out) return null;
	/* ASKED AS A GLOB where the name is synthetic: `name` carries a
	 * placeholder no tracked file can hold. */
	const spec = syn ? abs(syn.glob).slice(prefix.length) : name;
	const tracked = ctx.git(
		syn
			? ["ls-files", "--", spec]
			: ["ls-files", "--error-unmatch", "--", spec],
		syn ? [] : [1],
	);
	if (!tracked.ok)
		throw new GitUnanswered(
			`git ls-files could not answer for ${spec} — write allowed unchecked`,
		);
	if (tracked.out) return null;
	return orig.startsWith(prefix) ? orig.slice(prefix.length) : orig;
}

/**
 * One word the command writes, judged literally where it reads, else whole
 * as a synthetic name.
 * @param {string} word
 * @param {string[]} spans
 * @param {CoreContext} ctx
 * @returns {Stray | null}
 */
function considerTarget(word, spans, ctx) {
	const lit = literal(word, spans);
	if (!lit.text) return null;
	if (lit.known) {
		const name = readStrayName(lit.text, ctx);
		return name === null ? null : { shown: lit.text, name };
	}
	const x = synthesise(lit.text, "X");
	const glob = synthesise(lit.text, "*");
	if (x === null || glob === null) return null;
	const name = readStrayName(x, ctx, { orig: lit.text, glob });
	return name === null ? null : { shown: lit.text, name };
}

/**
 * @param {string} subject
 * @param {CoreContext} ctx
 * @returns {Decision}
 */
function decide(subject, ctx) {
	try {
		const stray = findStray(subject, ctx);
		return stray ? { deny: ctx.corePaths(refusal(stray, ctx)) } : null;
	} catch (e) {
		if (!(e instanceof GitUnanswered)) throw e;
		ctx.log(e.message);
		return null;
	}
}

/**
 * @param {string} subject
 * @param {CoreContext} ctx
 * @returns {Stray | null}
 */
function findStray(subject, ctx) {
	if (ctx.tool !== "Bash") {
		/* A file tool's path is one literal word: straight to the predicate. */
		const name = readStrayName(subject, ctx);
		return name === null ? null : { shown: subject, name };
	}
	const parsed = parseCommand(subject);
	/** @type {Stray | null} */
	let stray = null;
	/* Its writes read whatever word heads the command: `for i in 1 2 3; do … >
	 * .c2226.out; done` flattens to a segment headed by `do`
	 * (mantahostels#2321). An `mv`'s source and a deletion take a file away,
	 * so only a write is judged — `mv .x .claude/tmp/x` is the remedy. */
	walkCommands(
		parsed,
		(cmd) => {
			for (const t of cmd.writeTargets())
				if (!stray && t.mode === "write")
					stray = considerTarget(t.target, parsed.spans, ctx);
		},
		{ ...ctx, bareRedirects: true },
	);
	return stray;
}

/**
 * An inline code span, fenced by MORE backticks than its longest inner run,
 * or it closes early and takes the rest of the refusal with it.
 * @param {string} s
 */
function mdSpan(s) {
	const longest = Math.max(0, ...(s.match(/`+/g) ?? []).map((r) => r.length));
	const fence = "`".repeat(longest + 1);
	const pad = longest > 0 ? " " : "";
	return `${fence}${pad}${s}${pad}${fence}`;
}

/**
 * @param {string | undefined} tool
 * @param {string} bare the stray's name, its leading dot dropped
 * @param {string} escaped the stray's name as one shell word
 * @param {string} root
 * @returns {[string, string]}
 */
function remedy(tool, bare, escaped, root) {
	switch (remedyKind(tool)) {
		case "write":
			return ["Same write, sanctioned path", `${root}/.claude/tmp/${bare}`];
		case "move":
			return [
				"Move it into the sanctioned directory, then edit it there",
				`mv ${escaped} .claude/tmp/${shellQuote(bare)}`,
			];
		case "command":
			return ["Same command, sanctioned spelling", `.claude/tmp/${bare}`];
	}
}

/**
 * The two recipe lines are indented four spaces, a code BLOCK, where a
 * backtick is literal and nothing a session copies carries a fence away with
 * it (mantahostels#2436).
 * @param {Stray} stray
 * @param {CoreContext} ctx
 */
function refusal({ shown, name }, ctx) {
	const bare = name.replace(/^\./, "");
	const escaped = shellQuote(name);
	const [same, sanctioned] = remedy(ctx.tool, bare, escaped, ctx.root);
	return `Refused: ${mdSpan(shown)} is a dot-prefixed file directly at the repo root, which git neither ignores nor tracks. \`docs/environment.md\` §12 puts in-repo scratch in \`.claude/tmp/\` and nowhere else — gitignored, out of Biome's scope and out of vitest's, and swept at 24 hours. ${same}:

    ${sanctioned}

IF THIS REALLY IS A ROOT CONFIG FILE RATHER THAN SCRATCH — a mutation arm breaking \`scripts/markdown-tooling-declined.test.ts\`, or a temp \`tsconfig\` whose \`extends\` globs resolve relative to itself — this reads no \`dd\`, so write it through one and it is not seen:

    printf '%s' '{}' | dd of=${escaped}

There is no flag, and none is wanted: an escape a session can spell for itself is not a deny (mantahostels#109).`;
}

module.exports = {
	field: ["command", "file_path", "notebook_path"],
	noun: "write",
	decide,
};
