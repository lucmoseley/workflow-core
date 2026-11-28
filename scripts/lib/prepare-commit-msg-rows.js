const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const { constants } = require("node:os");
const path = require("node:path");
const {
	commitRoute,
	inRouteSet,
	routeAbort,
	routeName,
	scanRefusal,
} = require("./commit-route.js");
const { checkInProcess } = require("./check.js");
const { readText } = require("./file-read.js");
const { spawnGitSync } = require("./git.js");
const { readHookGitDir } = require("./hook-entry.js");
const { dispatch } = require("./precommit-dispatch.js");
const { precommitStamp, takePrecommitStamp } = require("./precommit-stamp.js");
const { takeHookPause } = require("./run-budgeted.js");

const HOOK = "prepare-commit-msg";

/**
 * @typedef {object} PrepareCommitMsgContext
 * @property {string} cwd
 * @property {NodeJS.ProcessEnv} env
 * @property {string} husky
 * @property {string} root
 * @property {string} file
 * @property {string} gitDir
 * @property {string} route
 * @property {<T>(run: () => T) => T} outsideLimit
 */

/**
 * @typedef {import("./precommit-dispatch.js").RowResult} RowResult
 * @typedef {import("./precommit-dispatch.js").Row & {
 *   script: string,
 *   run: (ctx: PrepareCommitMsgContext) => RowResult | Promise<RowResult>,
 * }} PrepareCommitMsgRow
 */

const SCANNER = "scripts/check-commit-message-closes.js";
const HOLD = "scripts/review-hold-gate.js";
const TRAILER = "scripts/review-tier-trailer.js";

/**
 * @param {PrepareCommitMsgContext} ctx
 * @param {string} rel
 */
const scriptAt = (ctx, rel) => path.join(ctx.root, rel);

/** @param {string} file */
function readable(file) {
	try {
		fs.accessSync(file, fs.constants.R_OK);
		return true;
	} catch {
		return false;
	}
}

/** @param {unknown} v */
const isFunction = (v) => typeof v === "function";

/**
 * @param {string} file
 * @param {string} name
 * @param {(value: unknown) => boolean} [shaped]
 * @returns {unknown}
 */
function exportOf(file, name, shaped = isFunction) {
	const value = require(file)[name];
	if (!shaped(value)) throw new Error(`${file} exports no ${name}`);
	return value;
}

/** @typedef {(opts: { cwd: string, env: NodeJS.ProcessEnv, args?: string[] }) => RowResult} StepProgram */

/** @param {string} route */
function inProgressLine(route) {
	const abort = routeAbort(route);
	return abort
		? `  The ${routeName(route)} is left IN PROGRESS. Clear it with:  ${abort}\n`
		: "";
}

/**
 * @param {string} file
 * @param {string} what
 * @returns {RowResult}
 */
function unchecked(file, what) {
	require("./fail-open-logger.js").failOpenLogger(HOOK)?.(
		`${path.basename(file)} is missing — ${what}`,
	);
	return {
		exit: 0,
		stdout: "",
		stderr: `${HOOK}: ${file} is missing, so ${what}.\n`,
	};
}

/** @param {import("node:child_process").SpawnSyncReturns<unknown>} r */
function shellStatus(r) {
	if (r.status !== null) return r.status;
	return r.signal ? 128 + constants.signals[r.signal] : 1;
}

/** @type {RowResult} */
const PASS = { exit: 0, stdout: "", stderr: "" };

/** @param {PrepareCommitMsgContext} ctx @returns {Promise<RowResult>} */
async function closingKeyword(ctx) {
	const scanner = scriptAt(ctx, SCANNER);
	if (!readable(scanner))
		return {
			exit: 1,
			stdout: "",
			stderr: `${HOOK}: ${scanner} is missing, so the closing-keyword scan did not run.\n  Refusing rather than passing the message unread (#138).\n`,
		};
	const spec = /** @type {import("./check.js").CheckSpec} */ (
		exportOf(
			scanner,
			"SPEC",
			(v) =>
				typeof v === "object" && v !== null && "run" in v && isFunction(v.run),
		)
	);
	const r = await checkInProcess(spec, [ctx.file, HOOK], { script: scanner });
	return { ...r, exit: r.exit === 0 ? 0 : 1 };
}

const GITLEAKS_STAGED = ["git", "--staged", "--redact"];

/**
 * @param {PrepareCommitMsgContext} ctx
 * @returns {RowResult}
 */
function replayScan(ctx) {
	const bin = ctx.env.WFC_GITLEAKS || "gitleaks";
	const r = spawnSync(bin, GITLEAKS_STAGED, {
		cwd: ctx.cwd,
		env: ctx.env,
		stdio: "inherit",
	});
	if (!r.error && r.status === 0) return PASS;
	return {
		exit: 1,
		stdout: "",
		stderr:
			(r.error ? `${HOOK}: ${bin} would not start: ${r.error.message}\n` : "") +
			scanRefusal(HOOK, ctx.route),
	};
}

/**
 * @param {RowResult} r
 * @param {string} route
 * @returns {RowResult}
 */
const withEpilogue = (r, route) =>
	r.exit === 0 ? r : { ...r, stderr: r.stderr + inProgressLine(route) };

/** @param {PrepareCommitMsgContext} ctx @returns {RowResult} */
function reviewHold(ctx) {
	const hold = scriptAt(ctx, HOLD);
	if (!readable(hold))
		return unchecked(
			hold,
			"this cherry-pick went unchecked for a sensitive-path review",
		);
	const program = /** @type {StepProgram} */ (exportOf(hold, "PROGRAM"));
	return withEpilogue(program({ cwd: ctx.cwd, env: ctx.env }), ctx.route);
}

/**
 * @param {PrepareCommitMsgContext} ctx
 * @returns {RowResult}
 */
function inlinePreCommit(ctx) {
	const r = ctx.outsideLimit(() =>
		spawnSync("sh", ["-e", path.join(ctx.husky, "pre-commit")], {
			cwd: ctx.cwd,
			env: { ...ctx.env, WFC_INDEX_FROZEN: "1" },
			stdio: "inherit",
		}),
	);
	if (ctx.gitDir) fs.rmSync(precommitStamp(ctx.gitDir), { force: true });
	if (r.error) throw r.error;
	const status = shellStatus(r);
	if (status === 0) return PASS;
	return {
		exit: status,
		stdout: "",
		stderr:
			`${HOOK}: the gates above refused this commit's content.\n` +
			"  This hook runs them because --no-verify cannot turn it off (mantahostels#1705).\n" +
			"  Fix the finding and commit again.\n" +
			(inProgressLine(ctx.route) ||
				"  Was this a revert? It is left IN PROGRESS:  git revert --abort\n"),
	};
}

/** @param {PrepareCommitMsgContext} ctx @returns {RowResult} */
function trailer(ctx) {
	const script = scriptAt(ctx, TRAILER);
	if (!readable(script))
		return unchecked(
			script,
			"this commit lands with no Review-Tier: trailer and no check that its tree stayed put",
		);
	const program = /** @type {StepProgram} */ (exportOf(script, "PROGRAM"));
	return withEpilogue(
		program({ cwd: ctx.cwd, env: ctx.env, args: [ctx.file] }),
		ctx.route,
	);
}

/** @param {PrepareCommitMsgContext} ctx */
function trailerIdle(ctx) {
	if (!ctx.file) return true;
	if (!ctx.gitDir) return false;
	const { reviewTierStamp } = require("./review-tier-stamp.js");
	const stamp = reviewTierStamp(ctx.gitDir, ctx.env.CLAUDE_CODE_SESSION_ID);
	if (stamp !== null && fs.existsSync(stamp)) return false;
	const read = readText(ctx.file);
	if (read.state !== "read") return false;
	const { KEY } = require("./review-tier-trailer.js");
	return !read.data.split("\n").some((line) => KEY.test(line));
}

/**
 * @param {PrepareCommitMsgContext} ctx
 * @param {{ stamped: boolean, replay: boolean }} path
 */
function trailerArmed(ctx, { stamped, replay }) {
	const due =
		stamped ||
		!replay ||
		(ctx.route === "cherry-pick" && readable(scriptAt(ctx, HOLD)));
	return due && (!readable(scriptAt(ctx, TRAILER)) || !trailerIdle(ctx));
}

/** @type {PrepareCommitMsgRow[]} */
const ROWS = [
	{
		id: "closing-keyword",
		script: SCANNER,
		arm: { always: true },
		when: { unlessRoutes: ["replay"], facts: ["message"] },
		policy: "gate",
		quietPass: true,
		run: closingKeyword,
	},
	{
		id: "replay-scan",
		script: "scripts/lib/prepare-commit-msg-rows.js",
		arm: { always: true },
		when: { routes: ["replay"], unlessFacts: ["stamped"] },
		policy: "gate",
		run: replayScan,
	},
	{
		id: "review-hold",
		script: HOLD,
		arm: { always: true },
		when: { routes: ["cherry-pick"], unlessFacts: ["stamped"] },
		policy: "gate",
		run: reviewHold,
	},
	{
		id: "inline-pre-commit",
		script: ".husky/pre-commit",
		arm: { always: true },
		when: { unlessRoutes: ["replay"], unlessFacts: ["stamped"] },
		policy: "gate",
		run: inlinePreCommit,
	},
	{
		id: "trailer",
		script: TRAILER,
		arm: { always: true },
		when: { facts: ["trailer"] },
		policy: "gate",
		run: trailer,
	},
];

/**
 * @param {{ cwd: string, env: NodeJS.ProcessEnv }} io
 * @param {{
 *   write: (fd: number, text: string) => void,
 *   husky: string,
 *   file: string,
 *   interrupted?: () => Promise<number | null>,
 *   rows?: PrepareCommitMsgRow[],
 * }} opts
 * @returns {Promise<number>}
 */
function runPrepareCommitMsg(
	io,
	{ write, husky, file, interrupted = async () => null, rows },
) {
	const pause = takeHookPause(io.env);
	const env = pause.env;
	const gitDir = readHookGitDir(io.cwd, env);
	const recorded = takePrecommitStamp(gitDir);
	const route = commitRoute("prepare-commit-msg", gitDir, { env });
	const written = spawnGitSync(["write-tree"], {
		cwd: io.cwd,
		env,
		encoding: "utf8",
	});
	const tree = written.status === 0 ? String(written.stdout).trim() : "";
	const huskyDir = path.resolve(io.cwd, husky);
	/** @type {PrepareCommitMsgContext} */
	const ctx = {
		cwd: io.cwd,
		env,
		outsideLimit: pause.outside,
		husky: huskyDir,
		root: env.WFC_PLUGIN_ROOT || path.dirname(huskyDir),
		file,
		gitDir,
		route,
	};
	const stamped = recorded !== "" && tree !== "" && recorded === tree;
	/** @type {Record<string, () => boolean>} */
	const facts = {
		message: () => file !== "",
		stamped: () => stamped,
		trailer: () =>
			trailerArmed(ctx, { stamped, replay: inRouteSet("replay", route) }),
	};
	return dispatch({
		rows: rows ?? ROWS,
		gates: "all",
		voice: { hook: "prepare-commit-msg", noun: "step" },
		ports: {
			load: (row) => () => row.run(ctx),
			write,
			interrupted,
			route: () => route,
			fact: (name) => {
				const answer = facts[name];
				if (!answer) throw new Error(`no fact is named '${name}'`);
				return answer();
			},
		},
	});
}

module.exports = { ROWS, runPrepareCommitMsg };
