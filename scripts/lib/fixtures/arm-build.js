/*
 * The fake of `arm-tasks.js build <task> … --to <dir>` that
 * scripts/run-arm-test.js's tests stand in at WFC_ARM_TASKS_CLI (#5149): it
 * makes `<dir>/repo` and `<dir>/bin` and prints the task record
 * lib/run-arm.js reads, `prompt` and `sandbox.repo`. A sandbox whose name
 * ends in `-<WFC_STUB_FAIL_ARM>`, or any where WFC_STUB_FAIL_ARM is `*`,
 * fails to build instead. scripts/arm-tasks.test.ts holds its record to the
 * real builder's.
 */

const fs = require("node:fs");
const path = require("node:path");

const args = process.argv.slice(2);
const to = args[args.indexOf("--to") + 1] ?? "";
const fail = process.env.WFC_STUB_FAIL_ARM;
if (fail === "*" || (fail && to.endsWith(`-${fail}`))) {
	process.stderr.write("stub build failure\n");
	process.exit(1);
}
fs.mkdirSync(path.join(to, "repo"), { recursive: true });
fs.mkdirSync(path.join(to, "bin"), { recursive: true });
process.stdout.write(
	JSON.stringify({
		prompt: "/implement 1",
		sandbox: { repo: path.join(to, "repo"), root: to },
	}),
);
