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
 */

const { spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const {
	flattenHooks,
	MARKER_WRITER,
	SELF_PLUGIN_DIR,
} = require("./core-hooks.js");
const { gitOrNull } = require("./git.js");
const { VERIFIED_REF } = require("./landing-refs.js");
const { mainCheckout } = require("./main-checkout.js");
const { MARKERS_REL, SELF_PLUGIN_PREFIX } = require("./marker-root.js");

const SETTINGS = ".claude/settings.json";
/* The harness's default for a `command` hook (docs/practice/
 * shell-scripting-and-hooks.md §Claude Code hooks). */
const DEFAULT_TIMEOUT_S = 600;
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
function meetsBash(matcher) {
	if (matcher === undefined || matcher === "" || matcher === "*") return true;
	try {
		return new RegExp(`^(?:${matcher})$`).test("Bash");
	} catch {
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
		(h) => h.type === "command" && meetsBash(h.matcher),
	);
}

/**
 * Why `line`, run in `dir` for marked session `sid`, does not allow a Bash
 * call; null where it does.
 * @param {HookEntry} line
 * @param {{ dir: string, env: NodeJS.ProcessEnv, sid: string }} probe
 * @returns {string | null}
 */
function refusalOf(line, { dir, env, sid }) {
	const seconds = Number(line.timeout ?? DEFAULT_TIMEOUT_S);
	const r = spawnSync("sh", ["-c", String(line.command)], {
		cwd: dir,
		env,
		encoding: "utf8",
		input: JSON.stringify({ session_id: sid, cwd: dir, ...PROBE_CALL }),
		timeout: seconds * 1000,
	});
	if (r.error && /ETIMEDOUT/.test(String(r.error)))
		return `it ran past its ${seconds}s timeout`;
	if (r.error) return `it would not start: ${r.error.message}`;
	if (r.status === 0) return null;
	// jsonl-read-exempt: the first line of a hook's stderr prose, no JSON
	const said = r.stderr.trim().split("\n")[0];
	return `it exited ${r.status ?? r.signal}${said ? `, saying: ${said}` : ""}`;
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
		return { why: `it does not parse as JSON: ${String(err)}` };
	}
}

/**
 * Why a session started in worktree `dir` would be locked out by its own
 * `.claude/settings.json`, as a refusal naming the line and the fix; null
 * where it would not.
 * @param {string} dir a linked worktree of the repository
 * @returns {string | null}
 */
function settingsLockout(dir) {
	const file = path.join(dir, SETTINGS);
	if (!fs.existsSync(file)) return null;
	const own = parseLines(fs.readFileSync(file, "utf8"));
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
		return `${file} would lock out every tool call of a session started there: ${own.why} — ${fix}`;
	const main = mainCheckout(dir);
	if (main === null) return null;
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
	try {
		if (marked.status !== 0 || !fs.existsSync(marker)) return null;
		const probe = { dir, env, sid };
		const broken = own.lines
			.map((line) => ({ line, why: refusalOf(line, probe) }))
			.find((r) => r.why !== null);
		if (broken === undefined) return null;
		if (landedLines?.some((line) => refusalOf(line, probe) !== null))
			return null;
		return `${file}'s PreToolUse line \`${broken.line.command}\` would lock out every tool call of a session started there, as ${broken.why} — ${fix}`;
	} finally {
		fs.rmSync(marker, { force: true });
	}
}

module.exports = { settingsLockout };
