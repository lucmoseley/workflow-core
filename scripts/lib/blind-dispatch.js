const { readCommit } = require("./commit-sha.js");
const { textOf } = require("./guard-entry.js");
const { trimEndRun } = require("./trim-run.js");

// guess, #5529
const MAX_LINES = 20;

const BLIND = /\bblind(?:ed|ness)?\b(?![ \t\r\f\v-]+spots?\b)/i;

const CHECKED = /^[ \t\r\f\v]*Blind-checked:[ \t\r\f\v]*([0-9a-fA-F]{7,40})/;

const GIT_OFF = /^(?:1|true|yes|on)$/i;

const FORK =
	"A fork inherits this session's whole context, so it is never blind: it knows everything you know about the answer. Dispatch the blind work as a fresh subagent (any type but fork), under the rule in docs/agents/blind-dispatch.md (#1783).";

/** @param {string} s */
const chomp = (s) => trimEndRun(s, "\n");

/**
 * @typedef {import("./core-contract.js").CoreContext} Ctx
 * @typedef {import("./core-contract.js").CoreDecision} Decision
 */

/**
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
 * @param {string} prompt
 * @param {Ctx} ctx
 * @returns {Decision}
 */
function judge(prompt, ctx) {
	const tree = ctx.tree();
	const cwd = ctx.cwd || tree.root;
	/** @type {import("./git.js").GitReader} */
	const read = (args, noMatch) => tree.git(["-C", cwd, ...args], noMatch);
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

/** @param {string} status */
function statusBlock(status) {
	if (!status) return "  (clean)";
	const entries = status.split("\n");
	const shown = entries.slice(0, MAX_LINES).map((l) => `  ${l}`);
	if (entries.length > MAX_LINES)
		shown.push(`  … and ${entries.length - MAX_LINES} more`);
	return shown.join("\n");
}

module.exports = { decide, field: "prompt", noun: "agent dispatch" };
