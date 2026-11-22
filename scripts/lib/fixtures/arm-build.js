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
