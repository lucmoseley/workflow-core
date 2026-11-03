/*
 * wevtutil's `qe … /f:xml` output for the Windows boots, for tests of
 * check-kernel-stall.js's Windows reader: a stub injected at WFC_WEVTUTIL.
 * Held to the real wevtutil.exe by wevtutil.contract.test.ts (#4081).
 */
import fs from "node:fs";
import path from "node:path";

const eventXml = (ms: number) =>
	`<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'><System><Provider Name='Microsoft-Windows-Kernel-General'/><EventID>12</EventID><TimeCreated SystemTime='${new Date(ms).toISOString()}'/><Channel>System</Channel></System></Event>`;

/**
 * A wevtutil in `dir` serving one Event 12 for each of `boots` (ms) under
 * `qe System … /f:xml`. Failing, or asked anything else, it exits 1. It appends
 * each call's `wevtutil <args>` to `dir/calls`. Its path, for WFC_WEVTUTIL.
 */
export function writeWevtutil(
	dir: string,
	boots: number[],
	{ fails = false } = {},
): string {
	fs.mkdirSync(dir, { recursive: true });
	const bin = path.join(dir, "wevtutil");
	fs.writeFileSync(
		bin,
		`#!/usr/bin/env node
const fs = require("node:fs");
const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(path.join(dir, "calls"))}, ["wevtutil", ...a].join(" ") + "\\n");
if (${fails} || a[0] !== "qe" || a[1] !== "System" || !a.includes("/f:xml")) process.exit(1);
process.stdout.write(${JSON.stringify(boots.map(eventXml).join(""))});
`,
		{ mode: 0o755 },
	);
	return bin;
}
