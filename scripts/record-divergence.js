#!/usr/bin/env node
// #5865

const path = require("node:path");

function main() {
	/** @type {(what: string, detail?: string) => void} */
	let log = () => undefined;
	try {
		const { logger, readPayload } = require("./lib/entry-input.js");
		log = logger(path.basename(__filename));
		const { divergenceRow } = require("./lib/divergence-row.js");
		const {
			appendRow,
			buildHostPorts,
		} = require("./lib/divergence-row-host.js");
		appendRow(
			divergenceRow(
				readPayload("a refused pull or push", log),
				buildHostPorts(process.env),
			),
		);
	} catch (e) {
		log(`recorder threw — no divergence row written: ${String(e)}`);
	}
}

main();
