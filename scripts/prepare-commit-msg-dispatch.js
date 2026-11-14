#!/usr/bin/env node
/*
 * prepare-commit-msg-dispatch.js — .husky/prepare-commit-msg's dispatcher
 * (#5207): runs every row of lib/prepare-commit-msg-rows.js in this one
 * process, through lib/precommit-dispatch.js, on the commit route
 * lib/commit-route.js reads.
 *
 *   node scripts/prepare-commit-msg-dispatch.js --husky <dir> [<message-file> [<source> [<sha>]]]
 *
 * `--husky` is the hook's own directory, which holds the `pre-commit` the
 * inline path runs; the steps' scripts are read from WFC_PLUGIN_ROOT, else
 * the directory above it. The rest is what git hands the hook; only the
 * message file is read.
 *
 * BEFORE ANY ROW, in this order: the pre-commit stamp is read and DELETED,
 * so a stamp that outlived its commit stands down no later one; the route is
 * read, and a route that will not read refuses rather than gating the commit
 * as an ordinary one (#1503); and the index's tree is written, to match the
 * stamp against.
 *
 * Exit 0 every armed row passed or stood down; a refusing row's own code
 * otherwise, 2 where a row or this entry threw; 128 + n on signal n.
 */

const { writeFd } = require("./lib/write-fd.js");

/** @typedef {{ cwd: string, env: NodeJS.ProcessEnv }} HookIo */

/**
 * The registry's run under `io`, each row's output through `write`: the
 * wiring the entry below and the tests share. Throws where the route will
 * not read.
 * @param {HookIo} io
 * @param {{
 *   write: (fd: number, text: string) => void,
 *   husky: string,
 *   file: string,
 *   interrupted?: () => Promise<number | null>,
 *   rows?: import("./lib/prepare-commit-msg-rows.js").PrepareCommitMsgRow[],
 * }} opts
 * @returns {Promise<number>}
 */
function runPrepareCommitMsg(
	io,
	{ write, husky, file, interrupted = async () => null, rows },
) {
	const path = require("node:path");
	const { commitRoute, inRouteSet } = require("./lib/commit-route.js");
	const { spawnGitSync } = require("./lib/git.js");
	const { readHookGitDir } = require("./lib/hook-entry.js");
	const { dispatch } = require("./lib/precommit-dispatch.js");
	const { takePrecommitStamp } = require("./lib/precommit-stamp.js");
	const { ROWS, trailerArmed } = require("./lib/prepare-commit-msg-rows.js");

	const gitDir = readHookGitDir(io.cwd, io.env);
	const recorded = takePrecommitStamp(gitDir);
	const route = commitRoute("prepare-commit-msg", gitDir, { env: io.env });
	const written = spawnGitSync(["write-tree"], {
		cwd: io.cwd,
		env: io.env,
		encoding: "utf8",
	});
	const tree = written.status === 0 ? String(written.stdout).trim() : "";
	const huskyDir = path.resolve(io.cwd, husky);
	/** @type {import("./lib/prepare-commit-msg-rows.js").PrepareCommitMsgContext} */
	const ctx = {
		...io,
		husky: huskyDir,
		root: io.env.WFC_PLUGIN_ROOT || path.dirname(huskyDir),
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
			fact: (name) => facts[name]?.() ?? false,
		},
	});
}

/** @returns {Promise<number>} */
async function main() {
	const { flagValue, parseOrCode } = require("./lib/cli-args.js");
	const { catchSignals } = require("./lib/hook-entry.js");
	const { scriptPath } = require("./lib/script-path.js");
	const usage = `node ${scriptPath("prepare-commit-msg-dispatch.js")} --husky <dir> [<message-file> [<source> [<sha>]]]\n`;
	const parsed = parseOrCode(process.argv.slice(2), {
		usage,
		flags: { "--husky": "value" },
		max: 3,
	});
	if (typeof parsed === "number") return parsed;
	const husky = flagValue(parsed.flags, "--husky");
	if (husky === undefined) {
		writeFd(2, `--husky is required\n${usage}`);
		return 2;
	}
	return runPrepareCommitMsg(
		{ cwd: process.cwd(), env: process.env },
		{
			write: writeFd,
			husky,
			file: parsed.positionals[0] ?? "",
			interrupted: catchSignals(),
		},
	);
}

module.exports = { runPrepareCommitMsg };

if (require.main === module)
	require("./lib/hook-entry.js").exitWhenSettled(main, {
		hook: "prepare-commit-msg",
		said: "threw",
		exit: 2,
	});
