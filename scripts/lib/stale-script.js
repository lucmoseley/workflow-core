/*
 * stale-script.js — the dispatcher core that warns when a Bash call may run a
 * neighbour's half-written script (mantahostels#1035). Its production
 * ports, the claim store and git, are lib/stale-script-host.js.
 *
 * Why: the working tree is repo-global, so `node scripts/x.js` runs the bytes
 * on disk — mid-save bytes included — and `scripts/` is a detect-only claim
 * tier (mantahostels#287), so an EXECUTION against a mid-edit file had no
 * signal at all.
 *
 * WARN, NEVER DENY — mantahostels#103's line: deny on a structured fact where
 * the action has no legitimate use, warn where the guard is inferring. The
 * neighbour's edit may be finished-but-uncommitted, and no session may be
 * blocked from running the repo's own tooling.
 *
 * A HOOK, NOT A CHECK INSIDE EACH SCRIPT: an in-script check covers only what
 * opts in (mantahostels#1035).
 *
 * WHY A CLAIM AND NOT DIRTINESS ALONE. `scripts/` is the busiest directory in
 * the repo and its writes are unrefused, so warning on every dirty script
 * would fire on the session's own work-in-progress. The claim is what names a
 * live neighbour.
 *
 * THE HOLDER IS NAMED BY SESSION ID, not by the name `claude agents --json`
 * would give: that oracle is too slow (mantahostels#317) to run ahead of
 * ordinary Bash calls. Liveness comes from the sessions registry, a filesystem
 * read.
 *
 * LIMITS
 *  - It reads the PARSED command form, never a substring, so a grep, an echo
 *    or a heredoc mentioning a script path passes.
 *  - The routes it knows are: a script run as the command itself, the first
 *    script under node/bash/sh/zsh/python/python3/tsx/ts-node, and
 *    `npm`/`pnpm` `run <name>` whose package.json body names scripts/ files —
 *    read as text, so a body naming a path it does not run buys a false
 *    warning. A script reached any other way — a wrapper, `xargs`, `env`,
 *    `npm --prefix <dir> run <name>`, a script another script runs — is not
 *    seen.
 *  - A script named as an ARGUMENT is not a run: only the first word that is a
 *    file is read, because everything after it belongs to that script.
 *  - Relative paths resolve against the hook's own directory, never a `cd`
 *    earlier in the command; the file must EXIST to become a candidate, which
 *    makes that failure silent rather than a false warning.
 *  - In a worktree the paths resolve outside the shared repo root and nothing
 *    warns — right, because a worktree runs its own copy of the file.
 *  - It fails open throughout (mantahostels#103 §6): no session id is
 *    recorded, and an unreadable claim store or a git that cannot say is
 *    silence.
 */

const { parseCommand, walkCommands } = require("./shell-parse.js");
const { absolute, literal } = require("./shell-words.js");
const { requiredGroup } = require("./regex-group.js");

/**
 * @typedef {import("./arbiter-store").ListedLock} Lock
 * @typedef {Exclude<Lock, { unreadable: true }>} LiveLock
 * @typedef {import("./guard-dispatch.js").CoreContext & {
 *   listLocks: () => Lock[] | null,
 *   relativeToRepo: (p: string) => string | null,
 *   isWatched: (rel: string) => boolean,
 * }} StaleContext the claim store's locks, null where it cannot be read; and
 *   the store's own reading of a path as a watched repo-relative one
 */

const INTERPRETERS = new Set([
	"node",
	"nodejs",
	"bash",
	"sh",
	"zsh",
	"python",
	"python3",
	"tsx",
	"ts-node",
]);

/** A `scripts/` path in an npm script body, after a start, space or quote. */
const SCRIPT_PATH = /(?:^|[\s'"])(scripts\/[\w./-]+)/g;

/**
 * @param {string} command
 * @param {StaleContext} ctx
 * @returns {import("./guard-dispatch.js").CoreDecision}
 */
function decide(command, ctx) {
	const candidates = scriptRuns(command, ctx);
	/* The overwhelming majority of Bash calls leave here. */
	if (candidates.length === 0) return null;
	/* Without it a neighbour's claim is indistinguishable from this session's
	 * own, and every warning would be about the reader's own work. */
	if (!ctx.session) {
		ctx.log("no session_id in payload — a script invocation allowed unchecked");
		return null;
	}
	const text = warnings(candidates, ctx);
	return text ? { context: ctx.corePaths(text) } : null;
}

/**
 * What the command runs: absolute script paths, and `npm run` names as
 * `npm-script:<name>`.
 * @param {string} command
 * @param {StaleContext} ctx
 */
function scriptRuns(command, ctx) {
	const parsed = parseCommand(command);
	/** @type {string[]} */
	const out = [];
	/** One word, kept only where it names a file that exists. An unreadable
	 * word — an unexpanded $VAR, a substitution — is dropped, not guessed at.
	 * @param {string} word */
	const addPath = (word) => {
		const lit = literal(word, parsed.spans);
		if (!lit.known || !lit.text || lit.text.startsWith("-")) return false;
		if (!lit.text.includes("/")) return false;
		const abs = absolute(lit.text, ctx.fallbackCwd);
		if (!ctx.isFile(abs)) return false;
		out.push(abs);
		return true;
	};
	walkCommands(
		parsed,
		({ words }) => {
			const [first = "", ...rest] = words;
			const head = literal(first, parsed.spans);
			if (!head.known) return;
			const base = head.text.slice(head.text.lastIndexOf("/") + 1);
			if (INTERPRETERS.has(base)) rest.some(addPath);
			else if (base === "npm" || base === "pnpm") {
				const name = npmScript(rest, parsed.spans);
				if (name !== null) out.push(`npm-script:${name}`);
			} else addPath(first);
		},
		ctx,
	);
	return out;
}

/**
 * The name `npm run <name>` or `npm run-script <name>` runs, flags in any
 * position skipped; null where there is none or it cannot be read.
 * @param {string[]} words
 * @param {string[]} spans
 */
function npmScript(words, spans) {
	let sawRun = false;
	for (const word of words) {
		if (word.startsWith("-")) continue;
		if (sawRun) {
			const name = literal(word, spans);
			return name.known ? name.text : null;
		}
		if (word !== "run" && word !== "run-script") return null;
		sawRun = true;
	}
	return null;
}

/**
 * One warning per candidate that is BOTH dirty in the shared working tree AND
 * claimed by another live session, joined; "" where there is nothing to say
 * AND where the answer is unavailable: an unreadable lock store must not
 * manufacture a warning.
 * @param {string[]} candidates
 * @param {StaleContext} ctx
 */
function warnings(candidates, ctx) {
	const locks = ctx.listLocks();
	if (locks === null) return "";
	const out = [];
	for (const rel of watchedPaths(candidates, ctx)) {
		const lock = locks.find((l) => "path" in l && l.path === rel);
		if (!lock || lock.unreadable || !lock.alive) continue;
		/* The session's own work-in-progress is not news to it. */
		if (!lock.sessionId || lock.sessionId === ctx.session) continue;
		if (!isDirty(rel, ctx)) continue;
		out.push(warning(rel, lock));
	}
	return out.join("\n\n");
}

/**
 * Whether `rel` has uncommitted changes, through the call's one cached git
 * rather than arbiter-core.js's gitDirty, so the read shares the entry's
 * budget; false where git cannot say.
 * @param {string} rel
 * @param {StaleContext} ctx
 */
function isDirty(rel, ctx) {
	const r = ctx.git(["status", "--porcelain", "--", rel], []);
	return r.ok && r.out !== "";
}

/**
 * Every candidate resolved to a repo-relative watched path, de-duplicated.
 * @param {string[]} candidates
 * @param {StaleContext} ctx
 */
function watchedPaths(candidates, ctx) {
	/** @type {string[]} */
	const out = [];
	for (const raw of candidates) {
		const paths = raw.startsWith("npm-script:")
			? readNpmScriptPaths(raw.slice("npm-script:".length), ctx)
			: [raw];
		for (const p of paths) {
			const rel = ctx.relativeToRepo(p);
			if (rel !== null && ctx.isWatched(rel) && !out.includes(rel))
				out.push(rel);
		}
	}
	return out;
}

/**
 * The scripts/ paths an `npm run <name>` body mentions. Text, not a shell
 * parse: a false warning costs a sentence where a missed one costs the hang
 * this core exists for.
 * @param {string} name
 * @param {StaleContext} ctx
 */
function readNpmScriptPaths(name, ctx) {
	let body;
	try {
		body = JSON.parse(ctx.readText("package.json") ?? "")?.scripts?.[name];
	} catch {
		// An unreadable package.json is "unknown": warn about nothing rather than
		// guess (mantahostels#103 §6).
		return [];
	}
	if (typeof body !== "string") return [];
	return [...body.matchAll(SCRIPT_PATH)].map((m) =>
		requiredGroup(m, 1, SCRIPT_PATH),
	);
}

/**
 * @param {string} rel
 * @param {LiveLock} lock
 */
function warning(rel, lock) {
	const who = lock.sessionId || "an unidentified session";
	const when = lock.claimedAt ? `, holding it since ${lock.claimedAt}` : "";
	return (
		`${rel} is uncommitted in the shared working tree and claimed by session ${who} (pid ${lock.pid ?? "unknown"})${when}, which is still running — so this run may be executing an unfinished edit (mantahostels#1035).\n\n` +
		"Nothing is blocked. But if the command hangs, errors strangely or answers implausibly, re-run it once the file is committed before believing the output or debugging the script.\n\n" +
		"What is held: node scripts/session-arbiter.js list\n\n" +
		"Residual: a script dirty under NO claim is invisible here — a Bash-route write mints none (mantahostels#364) — so silence is not proof the file is settled."
	);
}

module.exports = { field: "command", noun: "script invocation", decide };
