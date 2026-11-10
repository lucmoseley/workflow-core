/*
 * settings-lockout.js — whether a session started in an existing worktree
 * would be locked out by that worktree's own `.claude/settings.json` (#4752).
 *
 * The harness reads project settings from the session's cwd, so the
 * canary's PreToolUse line (#4745) runs as the worktree has it. A fresh cut
 * is safe, as `origin/main` holds only lines the lander's suite passed, but
 * a resume or a launch-into reopens a worktree whose own unlanded edit may
 * have broken the line. There every tool call is refused with the harness's
 * `onFailure` error, which names no fix, and the session cannot apply one.
 *
 * A worktree whose PreToolUse lines match `origin/main`'s is admitted
 * unrun. One whose lines differ has each line that meets a Bash call run
 * as the harness would, for a session the self-plugin loaded: a marker is
 * written for a probe session id by the main checkout's own marker writer,
 * then removed. A line that does not allow that call inside its timeout
 * refuses the start, naming the line and the fix. Where `origin/main`'s
 * lines refuse the probe too, the fault is not the worktree's edit, so the
 * start is left to the canary's own refusal, which names its fix.
 *
 * IT FAILS OPEN where it cannot run the probe — a settings file that will
 * not read, no main checkout, no marker written — admitting the start and
 * saying so through `warn` (#4752): the check only adds a fix to name, and
 * a start it refused on its own fault would strand a session the harness
 * would have run.
 */

const { spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
	flattenHooks,
	MARKER_WRITER,
	SELF_PLUGIN_DIR,
} = require("./core-hooks.js");
const { gitOrNull } = require("./git.js");
const {
	KILLED_EXIT,
	RUN_BUDGETED,
	TIMEOUT_EXIT,
} = require("./run-budgeted.js");
const { VERIFIED_REF } = require("./landing-refs.js");
const { readText } = require("./file-read.js");
const { mainCheckout } = require("./main-checkout.js");
const { MARKERS_REL, SELF_PLUGIN_PREFIX } = require("./marker-root.js");
const { writeFd } = require("./write-fd.js");

const SETTINGS = ".claude/settings.json";
/* The harness's default for a `command` hook (docs/practice/
 * shell-scripting-and-hooks.md §Claude Code hooks). */
const DEFAULT_TIMEOUT_S = 600;
/* Untraced: the canary answers in milliseconds, and a line slower than
 * this on every tool call strands its session as surely as one that hangs,
 * so a probe waits no longer than this whatever the line's own timeout. */
const PROBE_CAP_S = 15;
/* Untraced: a hook has nothing to clean up after a TERM. */
const KILL_GRACE_MS = 1000;
const PROBE_CALL = {
	hook_event_name: "PreToolUse",
	tool_name: "Bash",
	tool_input: { command: "ls" },
};

/**
 * @typedef {import("./core-hooks.js").HookEntry} HookEntry
 */

/**
 * Whether a PreToolUse `matcher` meets a Bash call: absent, empty and `*`
 * meet every tool; anything else is the harness's regex over the tool name.
 * @param {string | undefined} matcher
 */
function isBashMatched(matcher) {
	if (matcher === undefined || matcher === "" || matcher === "*") return true;
	try {
		return new RegExp(`^(?:${matcher})$`).test("Bash");
	} catch {
		/* A matcher that will not compile is probed, not skipped (#4752): a
		 * probe can only find a lockout, so probing too much costs a run of
		 * the line, and skipping it could miss one. */
		return true;
	}
}

/**
 * The `command` hooks of `settings` a session's first Bash call meets.
 * @param {{ hooks?: import("./core-hooks.js").Hooks }} settings
 * @returns {HookEntry[]}
 */
function bashLines(settings) {
	return flattenHooks({ PreToolUse: settings.hooks?.PreToolUse ?? [] }).filter(
		(h) => h.type === "command" && isBashMatched(h.matcher),
	);
}

/**
 * Why a PreToolUse line's run, as run-budgeted.js ended it, blocks the call
 * the harness's way (docs/practice/shell-scripting-and-hooks.md §exit codes):
 * exit 2 or a deny on stdout always; a failure — a timeout, any other
 * non-zero exit, JSON that will not parse — only under `onFailure: block`.
 * Null where the call goes on.
 * @param {HookEntry} line
 * @param {import("node:child_process").SpawnSyncReturns<string>} r
 * @param {number} budgetS
 * @returns {string | null}
 */
function blockOf(line, r, budgetS) {
	// jsonl-read-exempt: the first line of a hook's stderr prose, no JSON
	const said = r.stderr.trim().split("\n")[0];
	const saying = said ? `, saying: ${said}` : "";
	if (r.status === 2) return `it refused the call${saying}`;
	/** @type {string | null} */
	let failure = null;
	if (r.status === TIMEOUT_EXIT || r.status === KILLED_EXIT)
		failure = `it ran past ${budgetS}s`;
	else if (r.status !== 0)
		failure = `it exited ${r.status ?? r.signal}${saying}`;
	else if (r.stdout.trim().startsWith("{")) {
		try {
			const out = JSON.parse(r.stdout);
			if (
				out.hookSpecificOutput?.permissionDecision === "deny" ||
				out.decision === "block" ||
				out.continue === false
			)
				return `it denied the call on stdout${saying}`;
		} catch {
			failure = "its stdout did not parse as JSON";
		}
	}
	return failure !== null && line.onFailure === "block" ? failure : null;
}

/**
 * Why `line`, run in `dir` for marked session `sid`, blocks a Bash call;
 * null where it lets it through. The run is in a process group of its own,
 * killed whole at its budget (lib/run-budgeted.js), so a hung line leaves no
 * straggler.
 * @param {HookEntry} line
 * @param {{ dir: string, env: NodeJS.ProcessEnv, input: string }} probe
 *   `input`, a file holding the hook's stdin
 * @returns {string | null}
 */
function refusalOf(line, { dir, env, input }) {
	const budgetS = Math.min(
		Number(line.timeout ?? DEFAULT_TIMEOUT_S),
		PROBE_CAP_S,
	);
	/* run-budgeted.js closes the command's stdin, so the shell reopens it on
	 * the input file, passed as `$0`, before the line runs. */
	const r = spawnSync(
		process.execPath,
		[
			RUN_BUDGETED,
			String(budgetS * 1000),
			String(KILL_GRACE_MS),
			"sh",
			"-c",
			`exec <"$0"\n${line.command}`,
			input,
		],
		{ cwd: dir, env, encoding: "utf8" },
	);
	return blockOf(line, r, budgetS);
}

/**
 * The PreToolUse lines of `text`, parsed, or why they will not read.
 * @param {string} text
 * @returns {{ lines: HookEntry[] } | { why: string }}
 */
function parseLines(text) {
	try {
		return { lines: bashLines(JSON.parse(text)) };
	} catch (err) {
		return {
			why: `it does not parse as JSON (${String(err)}), so the harness cannot read its hooks or its plugins`,
		};
	}
}

/**
 * Why a session started in worktree `dir` would be locked out by its own
 * `.claude/settings.json`, as a refusal naming the line and the fix; null
 * where it would not, or where the probe cannot run, which it tells `warn`.
 * @param {string} dir a linked worktree of the repository
 * @param {(line: string) => void} [warn] where an unchecked start is said,
 *   stderr by default
 * @returns {string | null}
 */
function settingsLockout(dir, warn = (line) => writeFd(2, `${line}\n`)) {
	const file = path.join(dir, SETTINGS);
	const unchecked = (/** @type {string} */ why) => {
		warn(
			`settings lockout: ${file} was not checked, so the start goes ahead unchecked: ${why}`,
		);
		return null;
	};
	const read = readText(file);
	if (read.state === "absent") return null;
	if (read.state === "unreadable") return unchecked(read.message);
	const own = parseLines(read.data);
	const landedText = gitOrNull(["show", `${VERIFIED_REF}:${SETTINGS}`], {
		cwd: dir,
	});
	const landed = landedText === null ? null : parseLines(landedText);
	const landedLines = landed && "lines" in landed ? landed.lines : null;
	if (
		"lines" in own &&
		landedLines !== null &&
		JSON.stringify(own.lines) === JSON.stringify(landedLines)
	)
		return null;
	const fix = `restore it with \`git -C ${dir} checkout ${VERIFIED_REF} -- ${SETTINGS}\`, or mend that line by hand, then start the session again`;
	if ("why" in own)
		return `${file} cannot start a guarded session: ${own.why} — ${fix}`;
	const main = mainCheckout(dir);
	if (main === null) return unchecked("git names no main checkout for it");
	const sid = `settings-probe-${crypto.randomBytes(8).toString("hex")}`;
	/** @type {NodeJS.ProcessEnv} */
	const env = {
		...process.env,
		CLAUDE_PROJECT_DIR: dir,
		CLAUDE_PLUGIN_ROOT: path.join(main, SELF_PLUGIN_DIR),
	};
	const marked = spawnSync(
		"bash",
		[path.join(main, "scripts", MARKER_WRITER)],
		{
			cwd: dir,
			env,
			encoding: "utf8",
			input: JSON.stringify({
				session_id: sid,
				hook_event_name: "SessionStart",
			}),
		},
	);
	const marker = path.join(dir, MARKERS_REL, `${SELF_PLUGIN_PREFIX}${sid}`);
	const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "settings-probe-"));
	const input = path.join(scratch, "input.json");
	try {
		if (!fs.existsSync(marker))
			return unchecked(
				`the probe's self-plugin marker was not written (${MARKER_WRITER} exited ${marked.status ?? marked.signal})`,
			);
		fs.writeFileSync(
			input,
			JSON.stringify({ session_id: sid, cwd: dir, ...PROBE_CALL }),
		);
		const probe = { dir, env, input };
		const broken = own.lines
			.map((line) => ({ line, why: refusalOf(line, probe) }))
			.find((r) => r.why !== null);
		if (broken === undefined) return null;
		if (landedLines?.some((line) => refusalOf(line, probe) !== null))
			return null;
		return `${file}'s PreToolUse line \`${broken.line.command}\` would lock out every tool call of a session started there, as ${broken.why} — ${fix}`;
	} finally {
		fs.rmSync(marker, { force: true });
		fs.rmSync(scratch, { recursive: true, force: true });
	}
}

module.exports = { settingsLockout };
