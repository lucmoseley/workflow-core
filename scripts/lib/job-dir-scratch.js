/*
 * job-dir-scratch.js — the dispatcher core that keeps session scratch out of
 * $CLAUDE_JOB_DIR (mantahostels#2406, mantahostels#2407).
 *
 * WHY A GUARD AND NOT A LINE IN CLAUDE.md. The background-job preamble points
 * every background session at `$CLAUDE_JOB_DIR/tmp`, and it is scoped to
 * background jobs where a pool line countering it is general — so on
 * `CLAUDE.md` §Ground truth's own first limb, "the more specific wins", the
 * preamble won. That ranking opens with "a guard's deny text wins over any
 * file", so moving the rule here settles the contest instead of trying to win
 * it with qualifying bytes.
 *
 * ROUTE (e), NOT (f) (`docs/doc-map.md` §Capture and placement §3). The text
 * is spliced into this core's own verdict through ruleText, so it is retrieved
 * at the moment it bites and costs neither the always-loaded pool nor route
 * (f)'s union ratchet.
 *
 * WHAT IT JUDGES, two limbs and one predicate, then one split.
 *
 *   Bash    — a write by any spelling lib/shell-parse.js's writeTargets reads
 *             (workflow-core#1827) whose target resolves under the job directory.
 *   Write   — the `file_path` (or NotebookEdit's `notebook_path`) itself, for
 *   /Edit     the same predicate. The preamble hands every background job the
 *             EXPANDED path, which is the spelling those tools can carry.
 *
 *   A write target is first resolved as the shell would land it (workflow-core#1030): its
 *   `$VAR`s expanded from the command's own earlier assignments, then the
 *   environment (`T=$CLAUDE_JOB_DIR/tmp; cat > $T/x`), and a relative result
 *   joined to the directory a `cd` earlier in the command moved to
 *   (`cd <job dir>/tmp && python3 - > x.py`).
 *
 *   A target is under the job directory on lib/job-dir.js's three limbs: its
 *   text names `CLAUDE_JOB_DIR` at all, or it sits under `$CLAUDE_JOB_DIR` as
 *   the hook sees it, or under the `<config>/jobs/<id>/` shape when that
 *   variable is unset. The third exists because a hook's environment is the
 *   harness's to give, and a rule that goes silent when one variable is
 *   missing is the fail-open the doc-map's own placement test disqualifies.
 *
 *   THE SPLIT (workflow-core#1139): a target resolving to a file directly in `<job>/tmp/`,
 *   no subfolder between, is REFUSED. Anything else under the job directory —
 *   `<job>/tmp/<dir>/<file>`, or outside `tmp/` altogether — is WARNED. A
 *   command holding one of each is refused.
 *
 * WHY A READ IS NOT A BREACH. `cat $CLAUDE_JOB_DIR/tasks/x.output` is how a
 * session reads its own background job's output and is correct. Only a WRITE
 * is read here, which is why the Bash limb walks write targets rather than the
 * command string.
 *
 * WHY THE FLAT FOLDER IS REFUSED AND THE REST ONLY WARNED. The house order is
 * warn first, deny once measured, as the sibling root-scratch core went
 * (mantahostels#2323, mantahostels#2436); workflow-core#1106 measured this one and found
 * the flat folder holds nearly every breach and almost no legitimate write.
 *
 * THE WARN'S BOUND: ONE FULL WARNING PER (agent, session), THEN SILENCE — the
 * shape mantahostels#2401 ruled for the sibling, on its own latch id. Terminal,
 * not decaying. The refusal is NOT latched: a latched deny would allow every
 * stray after the first, which is why mantahostels#2436 dropped the sibling's.
 *
 * LIMITS
 *  - The Bash limb reads writeTargets' spellings and no others, so `dd of=`, a
 *    heredoc body and a script that writes on the session's behalf are unread,
 *    as at the sibling.
 *  - A single-source `cp`/`mv` to `$CLAUDE_JOB_DIR/tmp` with no trailing `/` is
 *    judged as a write to the folder itself, and warned rather than refused,
 *    wherever the hook cannot see that folder on disk.
 *  - Unread, so a target built on them is judged as written: a `pushd`, a
 *    `cd -` or a `cd` to an unresolvable path (the directory becomes unknown),
 *    a `cd` inside `{ … }` (the flattener does not scope braces), a variable
 *    from an earlier Bash call or set by `export`/`read`/`for`, and every word
 *    lib/shell-parse.js's resolveWord refuses (`$(…)`, `${VAR:-x}`, a name the
 *    command assigns two different values or assigns after a `||`).
 *  - It guards Claude Code's tools. A command run in a terminal sees no hook.
 *  - A repo script writing its own job-dir path is COMPLIANT and is invisible
 *    here by construction — it never appears in the session's own tool input
 *    (`scripts/bg-run.sh`, `scripts/issue-body.js`). A path a skill hands its
 *    subagents is not that: each subagent writes it through its own tool call,
 *    which this core sees (workflow-core#1140).
 */

const { parseCommand, walkCommands, normAbs } = require("./shell-parse.js");
const { literal } = require("./shell-words.js");
const { isJobDir, jobRel } = require("./job-dir.js");
const { remedyKind } = require("./scratch-remedy.js");
const { ruleOrFallback } = require("./guard-verdict.js");

/**
 * @typedef {import("./guard-dispatch.js").CoreContext} CoreContext
 * @typedef {import("./guard-entry.js").Decision} Decision
 * @typedef {{ flat: string, flatName: string, stray: string }} Found the
 *   offending targets as the caller wrote them: `flat` the first file straight
 *   into the job's own `tmp/`, refused; `stray` the first other, warned
 */

/** What stands in for an unset CLAUDE_JOB_DIR on the Bash limb, so an
 * expansion through it keeps the name in the resolved text. */
const JOB_DIR_STANDIN = "/CLAUDE_JOB_DIR";

const RULE = "job-dir-scratch";

/**
 * The file's own name where `p`, a job-dir path, is a file directly in the
 * job's `tmp/`, no subfolder between; null otherwise.
 * @param {string} p
 * @param {import("./job-dir.js").Where} where
 */
function flatName(p, where) {
	const rel = jobRel(p, where);
	if (rel === null || !rel.startsWith("tmp/")) return null;
	const name = rel.slice(4);
	return name && !name.includes("/") ? name : null;
}

/**
 * @param {string} subject
 * @param {CoreContext} ctx
 * @returns {Decision}
 */
function decide(subject, ctx) {
	/** @type {Found} */
	const found = { flat: "", flatName: "", stray: "" };
	const live = ctx.env.CLAUDE_JOB_DIR ?? "";
	/** @param {string} shown @param {string} p @param {string} jobDir */
	const classify = (shown, p, jobDir) => {
		const name = found.flat
			? null
			: flatName(p, { pwd: ctx.fallbackCwd, jobDir });
		if (name !== null) {
			found.flat = shown;
			found.flatName = name;
		} else if (!found.stray) found.stray = shown;
	};
	if (ctx.tool === "Bash") {
		/* Unset in the hook, the variable would refuse every expansion
		 * through it, `T=$CLAUDE_JOB_DIR/tmp; cat > $T/x` included. */
		const jobDir = live || JOB_DIR_STANDIN;
		const parsed = parseCommand(subject);
		walkCommands(
			parsed,
			(cmd) => {
				for (const t of cmd.writeTargets())
					if (t.mode === "write" && !found.flat)
						considerTarget(t.target, t.path, {
							spans: parsed.spans,
							where: { pwd: ctx.fallbackCwd, jobDir },
							classify,
						});
			},
			{
				...ctx,
				vars: { ...ctx.vars, CLAUDE_JOB_DIR: jobDir },
				bareRedirects: true,
			},
		);
	} else {
		/* A file path is a whole target already: only `./` and `//` to fold. */
		const p = subject.startsWith("/") ? normAbs(subject) : subject;
		if (isJobDir(p, { pwd: ctx.fallbackCwd, jobDir: live }))
			classify(subject, p, live);
	}
	if (!found.flat && !found.stray) return null;
	const rule = ruleOrFallback(
		ctx,
		"job-dir-scratch",
		"Session scratch goes in .claude/tmp/, never under $CLAUDE_JOB_DIR",
	);
	if (found.flat) return { deny: ctx.corePaths(refusal(found, rule, ctx)) };
	if (ctx.told(RULE)) return null;
	return {
		injectRules: [],
		prelude: ctx.corePaths(
			`Warn only, nothing refused: this writes session scratch under the job directory — ${found.stray}\n\n${rule}\n`,
		),
		latchAfter: RULE,
	};
}

/**
 * One word the command writes, and its path as writeTargets resolved it.
 * Where it will not resolve, the text literal still yields is judged, which is
 * all isJobDir's first limb needs.
 * @param {string} word
 * @param {string} resolved
 * @param {{ spans: string[], where: import("./job-dir.js").Where,
 *   classify: (shown: string, p: string, jobDir: string) => void }} at
 */
function considerTarget(word, resolved, { spans, where, classify }) {
	const lit = literal(word, spans).text;
	if (!lit) return;
	const p = resolved || lit;
	if (!isJobDir(p, where)) return;
	const landed = p.startsWith(`${JOB_DIR_STANDIN}/`)
		? `$CLAUDE_JOB_DIR${p.slice(JOB_DIR_STANDIN.length)}`
		: p;
	classify(
		landed === lit ? lit : `${lit} (lands at ${landed})`,
		p,
		where.jobDir,
	);
}

/** @type {Record<import("./scratch-remedy.js").RemedyKind, (sanctioned: string) => string>} */
const REMEDY = {
	write: (s) => `Same write, sanctioned path: ${s}`,
	move: (s) => `Move it to ${s}, then edit it there.`,
	command: (s) => `Same command, sanctioned target: ${s}`,
};

/**
 * @param {Found} found
 * @param {string} rule
 * @param {CoreContext} ctx
 */
function refusal(found, rule, ctx) {
	const sanctioned = `${ctx.root}/.claude/tmp/${found.flatName}`;
	return `Refused: this writes a file straight into the job directory's own tmp folder — ${found.flat}

Session scratch goes in \`.claude/tmp/\`. ${REMEDY[remedyKind(ctx.tool)](sanctioned)}

A fixture, or a child session's directory, that must sit outside the repo goes in a subfolder of its own under the job directory (\`<job dir>/tmp/<name>/<file>\`), which is warned once a session and never refused (workflow-core#1139).

${rule}`;
}

module.exports = {
	field: ["command", "file_path", "notebook_path"],
	noun: "write",
	decide,
};
