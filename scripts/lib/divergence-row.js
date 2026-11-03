/*
 * divergence-row.js — record-divergence.js's core (workflow-core#2797): whether a Bash call
 * was a refused `git pull` or a rejected `git push`, and the row recording the
 * divergence that caused it (workflow-core#289).
 *
 * A CORE: it does no I/O. Every git read, the pushed ref, the session count,
 * the clock, the directory test and the log directory arrive as ports
 * (lib/divergence-row-host.js wires the real ones), and it returns the row and
 * where it goes rather than writing it.
 *
 * THE COMMAND IS READ BY lib/shell-parse.js's git walk, quote-aware, `-C`
 * followed as git composes it. The walk filters by tree class; this recorder
 * records in ANY repo, so it hands the walk a classifier that judges every
 * tree, and `strict`, so a tree that will not resolve comes back "" and the
 * row is dropped rather than filed under the cwd.
 */

const { basename } = require("node:path").posix;

/**
 * The refusal strings, in git's own words, probed in this order; the first
 * found is the row's marker. A pull that merely printed "Already up to date"
 * matches none and is not a row.
 *
 * "Need to specify how to reconcile" is git's message when the branches have
 * diverged and no pull strategy is configured — the same divergence, refused
 * one step earlier, so it belongs in the same population.
 */
const MARKERS = [
	"Not possible to fast-forward",
	"Need to specify how to reconcile divergent branches",
	"Updates were rejected because",
	"non-fast-forward",
	"! [rejected]",
	"fetch first",
];

/**
 * @typedef {object} DivergencePorts
 * @property {boolean} disabled WFC_NO_DIVERGENCE_LOG is set: no row at all
 * @property {string} pwd the hook's own directory, for a payload with no
 *   usable cwd
 * @property {(p: string) => boolean} isDir
 * @property {(dir: string) => string | null} toplevel `git rev-parse
 *   --show-toplevel` in `dir`
 * @property {(dir: string) => string | null} commonDir the absolute git common
 *   dir of `dir`
 * @property {(top: string) => string} pushedRef lib/landing-refs.js's pushed
 *   ref for the checkout at `top`, "" where it will not say
 * @property {(top: string, ref: string) => boolean} refExists
 * @property {(top: string) => string | null} upstream `@{u}`, abbreviated
 * @property {(top: string, ref: string) => string | null} counts `git
 *   rev-list --left-right --count HEAD...<ref>`
 * @property {() => number | null} sessions live Claude sessions, null where
 *   unreadable
 * @property {() => Date} now
 * @property {(top: string) => string} projectDir the project directory a
 *   record about the repo at `top` is filed under
 *
 * Each git port answers its stdout less trailing newlines, or null where git
 * would not answer.
 *
 * @typedef {{ dir: string, file: string, line: string }} Row one line, its
 *   newline included, to append to `file` in `dir`
 */

/** jq's `//`: null, false and an absent field all fall through. */
const isPresent = (/** @type {unknown} */ v) =>
	v !== undefined && v !== null && v !== false;

/**
 * The text git printed: `tool_output`, else `tool_response`, else the whole
 * payload, as jq's `tostring` reads it — a string raw, anything else compact
 * JSON. The field's name has changed across harness versions.
 * @param {Record<string, unknown>} payload
 */
function outputOf(payload) {
	const v =
		[payload.tool_output, payload.tool_response].find(isPresent) ?? payload;
	return typeof v === "string" ? v : JSON.stringify(v);
}

/**
 * The first pull or push the command runs, and the tree it runs against; ""
 * where that tree will not resolve. Null where it runs neither.
 * @param {string} command
 * @param {string} cwd
 * @param {(p: string) => boolean} isDir
 * @returns {{ kind: string, tree: string } | null}
 */
function firstRefusable(command, cwd, isDir) {
	/* Loaded only here: most calls carry no refusal and never reach the walk
	 * (workflow-core#2899). */
	const { parseCommand, walkGit } = require("./shell-parse.js");
	/** @type {{ kind: string, tree: string } | null} */
	let found = null;
	walkGit(
		parseCommand(command),
		({ sub, tree }) => {
			found ??= { kind: sub, tree };
		},
		{
			cwd: undefined,
			fallbackCwd: cwd,
			/* No variable resolves: the hook's environment is not the shell the
			 * command ran in, so a `$VAR` path is one the row cannot place. */
			vars: {},
			isDir,
			/* Every tree is judged: a refusal is recorded in whichever repo it
			 * happened in. */
			treeClass: () => "shared",
			/* `strict` hands an unresolved tree over rather than logging it. */
			log: () => undefined,
		},
		{
			subs: ["pull", "push"],
			noun: "divergence row",
			scope: "repo",
			strict: true,
		},
	);
	return found;
}

/**
 * The REPOSITORY's name, not this checkout's: the common git dir's parent, so
 * a refusal in a linked worktree is filed under the repository it belongs to.
 * The top level's name where git gives no common dir.
 * @param {string} top
 * @param {string} common
 */
function repoName(top, common) {
	const repo = basename(common.replace(/\/\.git$/, "").replace(/\/$/, ""));
	return repo || basename(top);
}

/**
 * ahead/behind and the state they read as; `-`, `-`, `unknown` where they
 * will not count.
 * @param {string | null} counts
 */
function readCounts(counts) {
	const m = /^([0-9]+)[ \t\n\v\f\r]+([0-9]+)$/.exec(counts ?? "");
	if (!m) return { ahead: "-", behind: "-", state: "unknown" };
	const [, ahead = "", behind = ""] = m;
	const a = Number(ahead) > 0;
	const b = Number(behind) > 0;
	let state = "level";
	if (a && b) state = "diverged";
	else if (b) state = "behind";
	else if (a) state = "ahead";
	return { ahead, behind, state };
}

/**
 * Tab and newline are the row's own delimiters, and `repo` and `ref` come off
 * the filesystem and the ref namespace. Collapsed to spaces, as
 * lib/guard-log.sh does for the same reason.
 * @param {string} s
 */
const flat = (s) => s.replace(/[\t\r\n]/g, " ");

/**
 * The command, the refusal string matched and the payload's cwd, where the
 * payload is a Bash call whose output carries a refusal; null otherwise.
 * @param {unknown} payload
 * @returns {{ command: string, marker: string, cwd: unknown } | null}
 */
function readRefusal(payload) {
	if (!payload || typeof payload !== "object" || Array.isArray(payload))
		return null;
	const p = /** @type {Record<string, unknown>} */ (payload);
	if (p.tool_name !== "Bash") return null;
	const input = /** @type {Record<string, unknown> | null} */ (
		p.tool_input && typeof p.tool_input === "object" ? p.tool_input : null
	);
	const command = input?.command;
	if (typeof command !== "string" || !command) return null;
	const out = outputOf(p);
	const marker = MARKERS.find((m) => out.includes(m));
	return marker ? { command, marker, cwd: p.cwd } : null;
}

/**
 * The ref ahead/behind are counted against: the pushed ref (workflow-core#2408), else —
 * where the repo has no such ref, an adopter on another default branch — the
 * configured upstream, the row naming whichever was used; "" where neither is.
 * @param {string} top
 * @param {DivergencePorts} ports
 */
function countedRef(top, ports) {
	const pushed = ports.pushedRef(top);
	if (pushed && ports.refExists(top, pushed)) return pushed;
	return ports.upstream(top) ?? "";
}

/**
 * The row a Bash call's payload records, or null where it records none.
 * @param {unknown} payload the hook payload, parsed
 * @param {DivergencePorts} ports
 * @returns {Row | null}
 */
function divergenceRow(payload, ports) {
	if (ports.disabled) return null;
	const refusal = readRefusal(payload);
	if (!refusal) return null;
	const { cwd: given } = refusal;
	const cwd =
		typeof given === "string" && given && ports.isDir(given)
			? given
			: ports.pwd;
	const call = firstRefusable(refusal.command, cwd, ports.isDir);
	/* A tree that is no directory has no top level either: git answers for
	 * neither. */
	if (!call?.tree) return null;
	const top = ports.toplevel(call.tree);
	if (!top) return null;

	const ref = countedRef(top, ports);
	const { ahead, behind, state } = readCounts(
		ref ? ports.counts(top, ref) : null,
	);
	const n = ports.sessions();
	/* The `.000Z` is SHAPE, not precision: whole seconds is all this reads, and
	 * the millis are there so a row sorts and parses beside lib/guard-log.sh's,
	 * which pads the same three zeroes. */
	const when = `${ports.now().toISOString().slice(0, 19)}.000Z`;
	const fields = [
		when,
		flat(repoName(top, ports.commonDir(call.tree) ?? "")),
		call.kind,
		ahead,
		behind,
		state,
		n === null ? "-" : String(n),
		flat(ref || "-"),
		flat(refusal.marker),
	];
	const dir = ports.projectDir(top);
	return { dir, file: `${dir}/divergence.log`, line: `${fields.join("\t")}\n` };
}

module.exports = { divergenceRow };
