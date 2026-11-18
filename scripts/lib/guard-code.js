/*
 * guard-code.js — the code this repo's guard hooks run (#4227, #4203): a
 * detached worktree per sha of the verified ref, lib/pinned-code.js's guard
 * instance.
 *
 * ITS FILES, beside the code directory (`~/.claude/.guard-code`, or
 * `WFC_GUARD_CODE_DIR` where set, which the hook line reads too):
 *   - `.current`, the link the hook line runs `scripts/guard-dispatch.js`
 *     through (self-plugin/hooks/hooks.json, scripts/run-pinned-guards.js);
 *   - `.previous`, the worktree `.current` named before the last adoption,
 *     the target of run-pinned-guards.js's one-line repair;
 *   - `.refused`, one sha a line, never tried again: a probe's refusal, or
 *     one the repair rolled back from;
 *   - `.log`, a line per adoption and refusal;
 *   - `.probe-host`, an empty git repo the probe runs as the host, so no
 *     probe writes into a real one;
 *   - `.lock`, the adopting process's pidfile (lib/pid-lock.js), held from
 *     reading the tip to the flip, so no second adopter takes the tree the
 *     first has checked out but not yet flipped to as its spare (#5431). A
 *     holder running neither ADOPTERS script is stale, so a new caller of
 *     adoptGuardCodeAt in a process of its own is added there.
 *
 * ADOPTION checks the verified tip out, then a child node runs its
 * guard-dispatch.js on PROBE_PAYLOAD; only an exit 0 with no deny marking a
 * core it could not run flips `.current`. A fail-closed core whose module
 * fails to load answers with such a deny at exit 0 (lib/guard-dispatch.js),
 * so it refuses the tip; a fail-open core's, and any
 * PostToolUse core's, only logs, and is not seen. A probe that could not run, as on a timeout
 * or a failed checkout, refuses nothing and is tried again.
 *
 * Only the repo whose own hooks run from here adopts: one carrying
 * SELF_PLUGIN_HOOKS. An adopter's guards run from its pinned plugin.
 */

const { spawnSync } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { CORE_FAULT_TEXT } = require("./core-fault.js");
const { SELF_PLUGIN_HOOKS } = require("./core-hooks.js");
const { GIT_TIMEOUT_MS } = require("./git.js");
const { machineMarkerPath } = require("./machine-marker.js");
const { pidLock, waitForLock } = require("./pid-lock.js");
const {
	LOAD_TIMEOUT_MS,
	checkoutOf,
	fetchVerified,
	git,
	linkOf,
	pointLink,
	readLink,
	readVerifiedSha,
	removeWorktree,
	short,
	spareOf,
	whyOf,
	worktreeAt,
} = require("./pinned-code.js");

const PROGRAM = path.join("scripts", "guard-dispatch.js");
const CODE_DIR_ENV = "WFC_GUARD_CODE_DIR";
/* The scripts whose processes adopt: the hand route and the lander. */
const ADOPTERS = ["adopt-guard-code.js", "queue-lander.js"];
/* Untraced, a ceiling: a holder's probe at its timeout and six git calls at
 * theirs (the spare's four-call checkout, its fallback add and one prune);
 * the rest of its calls take milliseconds. */
const ADOPT_WAIT_MS = LOAD_TIMEOUT_MS + 6 * GIT_TIMEOUT_MS;

/* A call every guard lets through on an empty host: any deny is a fault. A
 * session id of its own each run, as a core counting a session's calls
 * (lib/agent-poll.js's allowance) would deny a reused one's repeats. */
const PROBE_PAYLOAD = {
	transcript_path: "/dev/null",
	hook_event_name: "PreToolUse",
	tool_name: "Bash",
	tool_input: { command: "ls" },
};

/**
 * @param {Record<string, string | undefined>} [env]
 * @returns {string}
 * @throws where HOME is unset or relative and no override is set
 */
const guardCodeDir = (env = process.env) =>
	env[CODE_DIR_ENV] || machineMarkerPath(".guard-code", env);

/** @param {string} codeDir */
function guardFiles(codeDir) {
	return {
		current: linkOf(codeDir, "current"),
		previous: linkOf(codeDir, "previous"),
		refused: linkOf(codeDir, "refused"),
		log: linkOf(codeDir, "log"),
		probeHost: linkOf(codeDir, "probe-host"),
		lock: linkOf(codeDir, "lock"),
	};
}

/** @param {string} file */
function readRefused(file) {
	try {
		return new Set(
			fs
				.readFileSync(file, "utf8")
				.split("\n")
				.map((l) => l.trim())
				.filter(Boolean),
		);
	} catch {
		// No file: nothing refused yet.
		return new Set();
	}
}

/**
 * @param {string} dir
 */
function probeHost(dir) {
	if (!fs.existsSync(path.join(dir, ".git"))) {
		fs.mkdirSync(dir, { recursive: true });
		git(dir, ["init", "--quiet"]);
	}
	return dir;
}

/**
 * @typedef {{fault: string} | {error: string} | null} Probe null where the
 *   code passed; `fault`, the code's own, which refuses its sha for good;
 *   `error`, the probe's, as a timeout or a failed checkout, retried next time
 */

/**
 * @param {string} dir
 * @param {string} host
 * @returns {Probe}
 */
function probe(dir, host) {
	const r = spawnSync(process.execPath, [path.join(dir, PROGRAM)], {
		cwd: host,
		encoding: "utf8",
		input: JSON.stringify({
			...PROBE_PAYLOAD,
			session_id: `guard-code-probe-${randomUUID()}`,
			cwd: host,
		}),
		env: { ...process.env, CLAUDE_PROJECT_DIR: host },
		stdio: ["pipe", "pipe", "pipe"],
		timeout: LOAD_TIMEOUT_MS,
	});
	if (r.error) return { error: r.error.message };
	if (r.status !== 0) return { fault: `exit ${r.status}, ${whyOf(r)}` };
	const out = r.stdout.trim();
	if (out === "") return null;
	let verdict;
	try {
		verdict = JSON.parse(out).hookSpecificOutput ?? {};
	} catch {
		return { fault: `output is not a verdict: ${out.split("\n")[0]}` };
	}
	const reason = String(verdict.permissionDecisionReason ?? "");
	return verdict.permissionDecision === "deny" &&
		reason.includes(CORE_FAULT_TEXT)
		? { fault: `the probe call was denied: ${reason.split("\n")[0]}` }
		: null;
}

/**
 * @typedef {{kind: "current" | "adopted" | "refused" | "known-refused", sha: string, why?: string}
 *   | {kind: "error", why: string}} Adoption
 */

/**
 * The worktree at `sha`, made where it was not yet, and its probe; a failed
 * checkout is the probe's error.
 * @param {{repo: string, codeDir: string, files: ReturnType<typeof guardFiles>}} where
 * @param {string} sha
 * @param {Array<string|null>} keep the live and previous worktrees
 * @returns {{dir: string|null, probe: Probe}}
 */
function probedWorktree({ repo, codeDir, files }, sha, keep) {
	/** @type {string|null} */
	let dir = null;
	try {
		dir = worktreeAt({ repo, codeDir, program: PROGRAM }, sha, keep);
		return { dir, probe: probe(dir, probeHost(files.probeHost)) };
	} catch (err) {
		return { dir, probe: { error: whyOf(err) } };
	}
}

/**
 * Adopt the verified tip as the guards' code where it is new, unrefused and
 * passes the probe; `fetch` false reads the ref as `repo` last fetched it.
 * @param {{repo: string, codeDir: string, fetch?: boolean}} opts
 * @returns {Adoption}
 */
function adoptGuardCode({ repo, codeDir, fetch = true }) {
	const files = guardFiles(codeDir);
	fs.mkdirSync(path.dirname(codeDir), { recursive: true });
	/** @param {string} line */
	const log = (line) =>
		fs.appendFileSync(files.log, `${new Date().toISOString()} ${line}\n`);
	const fetchError = fetch ? fetchVerified(repo) : null;
	const lock = pidLock(files.lock, ADOPTERS);
	if (!waitForLock(lock, ADOPT_WAIT_MS))
		return {
			kind: "error",
			why: `another adoption held ${files.lock} past ${ADOPT_WAIT_MS / 1000} s; tried again next time`,
		};
	try {
		return adoptLocked({ repo, codeDir, files, log }, fetchError);
	} finally {
		lock.release();
	}
}

/**
 * adoptGuardCode's work once it holds the lock: the tip is read here, so a
 * waiter adopts what the holder left newest.
 * @param {{repo: string, codeDir: string, files: ReturnType<typeof guardFiles>, log: (line: string) => void}} where
 * @param {string|null} fetchError
 * @returns {Adoption}
 */
function adoptLocked(where, fetchError) {
	const { repo, files, log } = where;
	const sha = readVerifiedSha(repo);
	if (sha === null)
		return {
			kind: "error",
			why: `no verified ref in ${repo}${fetchError ? ` (fetch: ${fetchError})` : ""}`,
		};
	const current = readLink(files.current);
	if (current !== null && path.basename(current) === sha)
		return { kind: "current", sha };
	if (readRefused(files.refused).has(sha))
		return { kind: "known-refused", sha };
	const keep = [current, readLink(files.previous)];
	const { dir, probe: result } = probedWorktree(where, sha, keep);
	if (result === null && dir !== null) {
		flip(where, current, dir);
		return { kind: "adopted", sha };
	}
	if (dir !== null) pruneBeside(where, keep);
	if (result !== null && "fault" in result) {
		fs.appendFileSync(files.refused, `${sha}\n`);
		log(`refused ${short(sha)}: ${result.fault}`);
		return { kind: "refused", sha, why: result.fault };
	}
	const why = `${short(sha)} not probed, ${result?.error}; tried again next time`;
	log(why);
	return { kind: "error", why };
}

/**
 * Remove every worktree in `codeDir` but those `keep` names and the spare.
 * @param {{repo: string, codeDir: string}} where
 * @param {Array<string|null>} keep
 */
function pruneBeside({ repo, codeDir }, keep) {
	const spare = spareOf({ codeDir, program: PROGRAM }, keep);
	const kept = new Set(
		[...keep, spare].filter((k) => k !== null).map((k) => path.basename(k)),
	);
	for (const name of fs.readdirSync(codeDir))
		if (!kept.has(name)) removeWorktree(repo, path.join(codeDir, name));
}

/**
 * Point `.current` at `live` and `.previous` at what it named, then remove
 * every other worktree but the spare.
 * @param {{repo: string, codeDir: string, files: ReturnType<typeof guardFiles>, log: (line: string) => void}} where
 * @param {string|null} current
 * @param {string} live
 */
function flip({ repo, codeDir, files, log }, current, live) {
	if (current !== null) pointLink(files.previous, current);
	pointLink(files.current, live);
	log(
		`adopted ${short(path.basename(live))}${current ? `, previous ${short(path.basename(current))}` : ""}`,
	);
	pruneBeside({ repo, codeDir }, [live, current]);
}

/**
 * adoptGuardCode for the checkout at `root` where it is this repo, one whose
 * own hooks run from the guard code; null elsewhere. Never throws: a caller
 * moving on with other work gets the fault as an error.
 * @param {string} root
 * @param {{fetch?: boolean, env?: Record<string, string | undefined>}} [opts]
 * @returns {Adoption|null}
 */
function adoptGuardCodeAt(root, { fetch = true, env = process.env } = {}) {
	try {
		if (!fs.existsSync(path.join(root, SELF_PLUGIN_HOOKS))) return null;
		if (checkoutOf(root) === null) return null;
		return adoptGuardCode({ repo: root, codeDir: guardCodeDir(env), fetch });
	} catch (err) {
		return { kind: "error", why: whyOf(err) };
	}
}

/**
 * @param {Adoption} a
 */
function adoptionLine(a) {
	if (a.kind === "error") return `guard code: not adopted, ${a.why}`;
	if (a.kind === "current") return `guard code: ${short(a.sha)} already live`;
	if (a.kind === "adopted") return `guard code: adopted ${short(a.sha)}`;
	if (a.kind === "known-refused")
		return `guard code: ${short(a.sha)} was refused before; the live code stays`;
	return `guard code: refused ${short(a.sha)}, ${a.why}; the live code stays`;
}

module.exports = {
	adoptGuardCodeAt,
	adoptionLine,
	guardCodeDir,
	guardFiles,
};
