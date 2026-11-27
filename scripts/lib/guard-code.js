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
	keptNames,
	linkOf,
	pointLink,
	readLink,
	readSpare,
	readVerifiedSha,
	removeWorktree,
	short,
	whyOf,
	worktreeAt,
} = require("./pinned-code.js");

const PROGRAM = path.join("scripts", "guard-dispatch.js");
const CODE_DIR_ENV = "WFC_GUARD_CODE_DIR";
const ADOPTERS = ["adopt-guard-code.js", "queue-lander.js"];
// guess, workflow-core#5431
const ADOPT_WAIT_MS = LOAD_TIMEOUT_MS + 6 * GIT_TIMEOUT_MS;

const PROBE_PAYLOAD = {
	transcript_path: "/dev/null",
	hook_event_name: "PreToolUse",
	tool_name: "Bash",
	tool_input: { command: "ls" },
};

/**
 * @param {Record<string, string | undefined>} [env]
 * @returns {string}
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

/** @typedef {{fault: string} | {error: string} | null} Probe */

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
 * @param {{repo: string, codeDir: string, files: ReturnType<typeof guardFiles>, log: (line: string) => void}} where
 * @param {string} sha
 * @param {Array<string|null>} keep
 * @returns {{dir: string|null, probe: Probe}}
 */
function probedWorktree({ repo, codeDir, files, log }, sha, keep) {
	/** @type {string|null} */
	let dir = null;
	try {
		dir = worktreeAt({ repo, codeDir, program: PROGRAM, log }, sha, keep);
		return { dir, probe: probe(dir, probeHost(files.probeHost)) };
	} catch (err) {
		return { dir, probe: { error: whyOf(err) } };
	}
}

/**
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
 * @param {{repo: string, codeDir: string}} where
 * @param {Array<string|null>} keep
 */
function pruneBeside({ repo, codeDir }, keep) {
	const kept = keptNames([
		...keep,
		readSpare({ codeDir, program: PROGRAM }, keep),
	]);
	for (const name of fs.readdirSync(codeDir))
		if (!kept.has(name)) removeWorktree(repo, path.join(codeDir, name));
}

/**
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
	ADOPT_WAIT_MS,
	adoptGuardCodeAt,
	adoptionLine,
	guardCodeDir,
	guardFiles,
};
