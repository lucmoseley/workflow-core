/* Starts one child by each node:child_process route, in a fixed order, each
 * with its own first argument, for call-cost.test.ts. */
const childProcess = require("node:child_process");
const path = require("node:path");
const { promisify } = require("node:util");

const node = process.execPath;
/** @type {{ stdio: "ignore" }} */
const quiet = { stdio: "ignore" };

/** @param {import("node:child_process").ChildProcess} child */
const ended = (child) =>
	new Promise((resolve) => {
		child.on("close", resolve);
	});

/** @param {(done: () => void) => void} start */
const settled = (start) =>
	new Promise((resolve) => {
		start(() => resolve(undefined));
	});

async function main() {
	childProcess.spawnSync(node, ["--version"], quiet);
	childProcess.execSync(`${node} -v`, quiet);
	childProcess.execFileSync(node, ["-e", "0"], quiet);
	await ended(childProcess.spawn(node, ["--eval", "0"], quiet));
	await settled((done) => childProcess.exec(`${node} -p 0`, done));
	await settled((done) => childProcess.execFile(node, ["--print", "0"], done));
	await promisify(childProcess.execFile)(node, ["-pe", "0"]);
	await ended(
		childProcess.fork(path.join(__dirname, "call-cost-child.js"), [], quiet),
	);
	return 0;
}

module.exports = { main };
if (require.main === module)
	main().then(
		(code) => {
			process.exitCode = code;
		},
		(e) => {
			console.error(e);
			process.exitCode = 1;
		},
	);
