#!/usr/bin/env node
// cli-args-exempt: workflow-core#5086

const { runCli } = require("./lib/link-writer.js");

const main = () => runCli("blocker", process.argv.slice(2));

module.exports = { main };

if (require.main === module)
	main().catch((e) => {
		process.stderr.write(`link-blocker: ${e}\n`);
		process.exitCode = 1;
	});
