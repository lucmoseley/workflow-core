const { spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
	flattenHooks,
	isToolCovered,
	MARKER_WRITER,
	MatcherError,
	SELF_PLUGIN_DIR,
} = require("./core-hooks.js");
const { parseFirstLine } = require("./first-line.js");
const { gitOrNull } = require("./git.js");
const {
	isRunnerFailure,
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
// The harness's default `command` hook timeout (https://code.claude.com/docs/en/hooks)
const DEFAULT_TIMEOUT_S = 600;
// #4752 guess
const PROBE_CAP_S = 15;
// #4752 guess
const KILL_GRACE_MS = 1000;
const PROBE_CALL = {
	hook_event_name: "PreToolUse",
	tool_name: "Bash",
	tool_input: { command: "ls" },
};

/**
 * @typedef {import("./core-hooks.js").HookEntry} HookEntry
 */

/** @param {string | undefined} matcher */
function isBashMatched(matcher) {
	try {
		return isToolCovered(matcher, "Bash");
	} catch (e) {
		if (!(e instanceof MatcherError)) throw e;
		return true;
	}
}

/**
 * @param {{ hooks?: import("./core-hooks.js").Hooks }} settings
 * @returns {HookEntry[]}
 */
function bashLines(settings) {
	return flattenHooks({ PreToolUse: settings.hooks?.PreToolUse ?? [] }).filter(
		(h) => h.type === "command" && isBashMatched(h.matcher),
	);
}

/**
 * @param {string} stdout
 * @returns {"deny" | "unparsed" | null}
 */
function decisionOf(stdout) {
	if (!stdout.trim().startsWith("{")) return null;
	try {
		const out = JSON.parse(stdout);
		return out.hookSpecificOutput?.permissionDecision === "deny" ||
			out.decision === "block" ||
			out.continue === false
			? "deny"
			: null;
	} catch {
		return "unparsed";
	}
}

/**
 * @param {HookEntry} line
 * @param {import("node:child_process").SpawnSyncReturns<string>} r
 * @param {{ budgetS: number, saying: string }} run
 * @returns {string | null}
 */
function failureOf(line, r, { budgetS, saying }) {
	if (r.status === TIMEOUT_EXIT || r.status === KILLED_EXIT)
		return budgetS < Number(line.timeout ?? DEFAULT_TIMEOUT_S)
			? `it took over the probe's ${budgetS}s cap, so each tool call there would wait at least that long`
			: `it ran past its ${budgetS}s timeout`;
	if (r.status !== 0) return `it exited ${r.status ?? r.signal}${saying}`;
	return decisionOf(r.stdout) === "unparsed"
		? "its stdout did not parse as JSON"
		: null;
}

/**
 * @param {HookEntry} line
 * @param {import("node:child_process").SpawnSyncReturns<string>} r
 * @param {number} budgetS
 * @returns {string | null}
 */
function blockOf(line, r, budgetS) {
	const said = parseFirstLine(r.stderr);
	const saying = said ? `, saying: ${said}` : "";
	if (r.status === 2) return `it refused the call${saying}`;
	if (r.status === 0 && decisionOf(r.stdout) === "deny")
		return `it denied the call on stdout${saying}`;
	const failure = failureOf(line, r, { budgetS, saying });
	return failure !== null && line.onFailure === "block" ? failure : null;
}

/**
 * @param {HookEntry} line
 * @param {{ dir: string, env: NodeJS.ProcessEnv, input: string }} probe
 * @returns {{ blocked: string } | { unrun: string } | null}
 */
function verdictOf(line, { dir, env, input }) {
	const budgetS = Math.min(
		Number(line.timeout ?? DEFAULT_TIMEOUT_S),
		PROBE_CAP_S,
	);
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
	if (r.error) return { unrun: r.error.message };
	if (isRunnerFailure(r)) return { unrun: parseFirstLine(r.stderr) };
	const blocked = blockOf(line, r, budgetS);
	return blocked === null ? null : { blocked };
}

/**
 * @param {HookEntry[]} lines
 * @param {{ dir: string, env: NodeJS.ProcessEnv, input: string }} probe
 * @returns {"blocked" | { unrun: string } | null}
 */
function landedVerdict(lines, probe) {
	/** @type {{ unrun: string } | null} */
	let unrun = null;
	for (const line of lines) {
		const v = verdictOf(line, probe);
		if (v === null) continue;
		if ("blocked" in v) return "blocked";
		unrun ??= v;
	}
	return unrun;
}

/**
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
 * @param {string} dir
 * @param {string} main
 * @param {{ own: HookEntry[], landed: HookEntry[] | null }} lines
 * @returns {{ line: HookEntry, blocked: string } | { unrun: string } | null}
 */
function probeLines(dir, main, { own, landed }) {
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
	/** @type {string | null} */
	let scratch = null;
	try {
		if (!fs.existsSync(marker))
			return {
				unrun: `the probe's self-plugin marker was not written (${MARKER_WRITER} exited ${marked.status ?? marked.signal})`,
			};
		scratch = fs.mkdtempSync(path.join(os.tmpdir(), "settings-probe-"));
		const input = path.join(scratch, "input.json");
		fs.writeFileSync(
			input,
			JSON.stringify({ session_id: sid, cwd: dir, ...PROBE_CALL }),
		);
		const probe = { dir, env, input };
		for (const line of own) {
			const verdict = verdictOf(line, probe);
			if (verdict === null) continue;
			if ("unrun" in verdict)
				return {
					unrun: `the probe of \`${line.command}\` would not run: ${verdict.unrun}`,
				};
			const landedV = landedVerdict(landed ?? [], probe);
			if (landedV === "blocked") return null;
			if (landedV !== null)
				return {
					unrun: `the probe of origin/main's lines would not run: ${landedV.unrun}`,
				};
			return { line, blocked: verdict.blocked };
		}
		return null;
	} finally {
		fs.rmSync(marker, { force: true });
		if (scratch !== null) fs.rmSync(scratch, { recursive: true, force: true });
	}
}

/**
 * @param {string} dir
 * @param {(line: string) => void} [warn]
 * @returns {string | null}
 */
function settingsLockout(dir, warn = (line) => writeFd(2, `${line}\n`)) {
	const file = path.join(dir, SETTINGS);
	const unchecked = (/** @type {string} */ why) => {
		warn(
			`settings lockout: ${file} was not checked, so the start goes ahead: ${why}`,
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
	const fix = `restore it with \`git -C ${dir} checkout ${VERIFIED_REF} -- ${SETTINGS}\`, or mend that line by hand, then start the session again`;
	if ("why" in own)
		return `${file} cannot start a guarded session: ${own.why} — ${fix}`;
	if (JSON.stringify(own.lines) === JSON.stringify(landedLines)) return null;
	const main = mainCheckout(dir);
	if (main === null) return unchecked("git names no main checkout for it");
	const found = probeLines(dir, main, { own: own.lines, landed: landedLines });
	if (found === null) return null;
	if ("unrun" in found) return unchecked(found.unrun);
	return `${file}'s PreToolUse line \`${found.line.command}\` would refuse or stall every tool call of a session started there, as ${found.blocked} — ${fix}`;
}

module.exports = { settingsLockout };
