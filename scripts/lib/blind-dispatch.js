/*
 * blind-dispatch.js — the dispatcher core that makes a blind dispatch state
 * that its git snapshot names no answer (#1783).
 *
 * Every subagent but Explore and Plan starts with a git snapshot taken at
 * dispatch — branch, `git status` entries, the five latest commit subjects — and
 * no dispatch can drop it. A subject naming an item under test, or its expected
 * score, ends that item's blindness for the run. The rule and the recipe for a
 * run with no snapshot are docs/agents/blind-dispatch.md's.
 *
 * What it does to an Agent dispatch whose prompt or description says "blind"
 * ("blind spot" excepted):
 *   * refuses it, printing the snapshot the subagent would read, unless the
 *     prompt carries a `Blind-checked: <sha>` line naming the current HEAD;
 *   * refuses one whose line names an older commit, printing the subjects
 *     landed since;
 *   * refuses a blind fork outright, a fork inheriting the dispatcher's whole
 *     context;
 *   * passes Explore and Plan, and every dispatch where
 *     CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS is on — the recipe's child.
 *
 * Why a refusal rather than an injected rule: injected text reaches the session
 * with the dispatch's result, after the subagent already holds its snapshot,
 * and blind scorers go out in parallel fan-outs, all leaking before any of them
 * returns (docs/doc-map.md §Capture and placement, step 3). The trigger is the
 * word, an inference, so the escape is one line in the prompt rather than a
 * wedge (mantahostels#103).
 *
 * LIMITS
 *  - A blind dispatch that never says "blind" is not seen, and a prompt using
 *    the word in another sense is refused once. Neither rate is measured.
 *  - The line is the dispatcher's word that it read the snapshot; nothing checks
 *    that it did, or judged it right.
 *  - The line pins HEAD alone: a new untracked file, or another branch at the
 *    same commit, still passes it.
 *  - The `includeGitInstructions` setting hides the snapshot too, but a hook
 *    cannot read a session's settings, so that child is still asked for the
 *    line. The recipe uses the environment variable for this reason.
 *  - An unborn branch, or a cwd outside any repository, passes: no commit
 *    subject can leak, though status entries on an unborn branch still do.
 *  - It passes, unrecorded, wherever git cannot say what HEAD is
 *    (mantahostels#147); a branch, log or status git cannot give prints empty.
 */

const { readCommit } = require("./commit-sha.js");
const { textOf } = require("./guard-entry.js");

/**
 * How many subjects or status entries a refusal prints before counting the
 * rest. A guess, never measured: enough to judge by, short of flooding.
 */
const MAX_LINES = 20;

/**
 * "blind", "blinded", "blindness", but not "blind spot(s)", tried per line as
 * grep reads. The space class is PCRE's ASCII `\s` within a line: JS's would
 * also take Unicode spaces.
 */
const BLIND = /\bblind(?:ed|ness)?\b(?![ \t\r\f\v-]+spots?\b)/i;

/** The last `Blind-checked: <sha>` line's sha. */
const CHECKED = /^[ \t\r\f\v]*Blind-checked:[ \t\r\f\v]*([0-9a-fA-F]{7,40})/;

/** The recipe's child, and everything it dispatches, starts with no snapshot. */
const GIT_OFF = /^(?:1|true|yes|on)$/i;

const FORK =
	"A fork inherits this session's whole context, so it is never blind: it knows everything you know about the answer. Dispatch the blind work as a fresh subagent (any type but fork), under the rule in docs/agents/blind-dispatch.md (#1783).";

const field = "prompt";
const noun = "agent dispatch";

/** A command's output as `$(…)` keeps it: trailing newlines dropped. @param {string} s */
const chomp = (s) => s.replace(/\n+$/, "");

/**
 * @typedef {import("./guard-dispatch.js").CoreContext} Ctx
 * @typedef {import("./guard-dispatch.js").CoreDecision} Decision
 */

/**
 * The full sha `rev` names, or "" where it names none or git would not say.
 * @param {import("./git.js").GitReader} read
 * @param {string} rev
 */
function readCommitSha(read, rev) {
	const r = readCommit(read, rev);
	return (r.ok && r.sha) || "";
}

/**
 * @param {string} prompt
 * @param {Ctx} ctx
 * @returns {Decision}
 */
function decide(prompt, ctx) {
	if (GIT_OFF.test(ctx.env.CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS ?? ""))
		return null;
	const lines = `${prompt}\n${textOf(ctx.input.description)}`.split("\n");
	if (!lines.some((l) => BLIND.test(l))) return null;
	const type = textOf(ctx.input.subagent_type);
	if (type === "Explore" || type === "Plan") return null;
	if (type === "fork") return { deny: ctx.corePaths(FORK) };
	return judge(prompt, ctx);
}

/**
 * A blind dispatch judged against the git snapshot of the payload's cwd, or
 * the host root's where it names none.
 * @param {string} prompt
 * @param {Ctx} ctx
 * @returns {Decision}
 */
function judge(prompt, ctx) {
	const cwd = ctx.cwd || ctx.root;
	/** @type {import("./git.js").GitReader} */
	const read = (args, noMatch) => ctx.git(["-C", cwd, ...args], noMatch);
	/** @param {string[]} args @returns {string | null} */
	const git = (...args) => {
		const r = read(args, []);
		return r.ok ? chomp(r.out) : null;
	};
	const head = git("rev-parse", "--verify", "-q", "HEAD");
	if (!head) return null;
	const short = git("rev-parse", "--short", "HEAD") ?? head;

	let unknown = "";
	const checked = prompt
		.split("\n")
		.flatMap((l) => CHECKED.exec(l)?.[1] ?? [])
		.at(-1);
	if (checked) {
		const resolved = readCommitSha(read, checked);
		if (resolved === head) return null;
		if (resolved) {
			const since =
				(git("log", "--format=  %h %s", `${resolved}..HEAD`) ?? "")
					.split("\n")
					.slice(0, MAX_LINES)
					.join("\n") || "  (none on HEAD's own line — HEAD moved elsewhere)";
			return {
				deny: ctx.corePaths(
					`This blind dispatch's \`Blind-checked: ${checked}\` is no longer HEAD. Commits landed since, which its snapshot would show:\n${since}\n\nIf none names an item under test or its expected answer, change the line to \`Blind-checked: ${short}\` and re-send. If one does, run the blind work through the recipe in docs/agents/blind-dispatch.md (#1783).`,
				),
			};
		}
		unknown = `Its \`Blind-checked: ${checked}\` names no commit in this repository. `;
	}

	const branch = git("rev-parse", "--abbrev-ref", "HEAD") ?? "";
	const subjects = git("log", "-5", "--format=  %h %s") ?? "";
	const status = statusBlock(git("status", "--short") ?? "");
	return {
		deny: ctx.corePaths(
			`${unknown}This dispatch reads as blind, and the subagent will start with this git snapshot, taken now:\n\nBranch: ${branch}\nRecent commits:\n${subjects}\nStatus:\n${status}\n\nIf any of it names an item under test or its expected answer, do not send it: hold your own commit until the run reports, or run the blind work through the recipe in docs/agents/blind-dispatch.md, which starts it with no snapshot. If none does, add this line to the prompt and re-send:\n\nBlind-checked: ${short}\n\nNot a blind dispatch? Add the line anyway; the word "blind" is all this guard reads (#1783).`,
		),
	};
}

/**
 * `git status --short`, indented, capped at MAX_LINES with the rest counted.
 * @param {string} status
 */
function statusBlock(status) {
	if (!status) return "  (clean)";
	const entries = status.split("\n");
	const shown = entries.slice(0, MAX_LINES).map((l) => `  ${l}`);
	if (entries.length > MAX_LINES)
		shown.push(`  … and ${entries.length - MAX_LINES} more`);
	return shown.join("\n");
}

module.exports = { decide, field, noun };
