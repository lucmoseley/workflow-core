#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const { parseOrCode } = require("./lib/cli-args.js");
const { hostRoot } = require("./lib/host-root.js");
const { readRunsAt } = require("./lib/local-tester.js");
const { coreRoot } = require("./lib/script-path.js");
const { writeFd } = require("./lib/write-fd.js");

const SHARD = /^(\d+)\/(\d+)$/;

/**
 * @param {import("./lib/local-tester.js").Run[]} runs
 * @param {string} root
 * @returns {string[]}
 */
function runAll(runs, root) {
	/** @type {string[]} */
	const failed = [];
	for (const { command, args, label, env } of runs) {
		const title = label ?? command;
		writeFd(1, `::group::${title}\n`);
		const r = spawnSync("sh", ["-c", `${command} "$@"`, "lander-ci", ...args], {
			cwd: root,
			stdio: "inherit",
			env: { ...process.env, ...env },
		});
		writeFd(1, "::endgroup::\n");
		if (r.error) writeFd(2, `${title}: ${r.error.message}\n`);
		if (r.status !== 0) failed.push(title);
	}
	return failed;
}

/**
 * @param {string} root
 * @param {"group" | "files"} command
 * @param {string[]} positionals
 * @returns {import("./lib/local-tester.js").Run[] | string}
 */
function readRuns(root, command, positionals) {
	const pytest = path.join(coreRoot(), "scripts", "run-pytest.js");
	if (command === "files") {
		const plan = readRunsAt(root, pytest, positionals, () => null);
		return typeof plan === "string" ? plan : plan.flat();
	}
	const m = SHARD.exec(positionals[0] ?? "");
	const k = Number(m?.[1]);
	const n = Number(m?.[2]);
	if (!m || k < 1 || k > n)
		return `"${positionals[0]}" is no group k/n with 1 <= k <= n`;
	const plan = readRunsAt(root, pytest, [], () => null);
	if (typeof plan === "string") return plan;
	if (plan.length === 0) return [];
	if (plan.length !== n)
		return `the workflow runs ${n} group(s), but the config here plans ${plan.length} — the next workflow-core upgrade rewrites the workflow to match`;
	return plan[k - 1] ?? [];
}

/** @param {string[]} [argv] @returns {number} */
function main(argv = process.argv.slice(2)) {
	const usage = `usage: node scripts/lander-ci.js group <k>/<n>
       node scripts/lander-ci.js files <file>…`;
	const parsed = parseOrCode(argv, {
		usage,
		commands: {
			group: { usage, min: 1 },
			files: { usage, min: 1, max: Number.POSITIVE_INFINITY },
		},
	});
	if (typeof parsed === "number") return parsed;
	const root = hostRoot();
	const runs = readRuns(
		root,
		/** @type {"group" | "files"} */ (parsed.command),
		parsed.positionals,
	);
	if (typeof runs === "string") {
		writeFd(2, `lander-ci: ${runs}\n`);
		return 1;
	}
	if (runs.length === 0) {
		writeFd(1, "lander-ci: nothing to run here\n");
		return 0;
	}
	const failed = runAll(runs, root);
	if (failed.length === 0) return 0;
	writeFd(2, `lander-ci: ${failed.join(", ")} failed\n`);
	return 1;
}

process.exitCode = main();
