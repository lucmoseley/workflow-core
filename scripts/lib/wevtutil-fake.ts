/* #4081 #5497 */
import fs from "node:fs";
import path from "node:path";

const eventXml = (ms: number) =>
	`<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'><System><Provider Name='Microsoft-Windows-Kernel-General'/><EventID>12</EventID><TimeCreated SystemTime='${new Date(ms).toISOString()}'/><Channel>System</Channel></System></Event>`;

const resetText = (ms: number) =>
	`Event[0]:\r\n  Log Name: System\r\n  Source: Microsoft-Windows-Kernel-Power\r\n  Date: ${new Date(ms).toISOString().replace("Z", "0000Z")}\r\n  Event ID: 41\r\n`;

export function writeWevtutil(
	dir: string,
	boots: number[],
	{ fails = false, resets = [] as number[] } = {},
): string {
	fs.mkdirSync(dir, { recursive: true });
	const bin = path.join(dir, "wevtutil");
	const newest = resets.length > 0 ? resetText(Math.max(...resets)) : "";
	fs.writeFileSync(
		bin,
		`#!/usr/bin/env node
const fs = require("node:fs");
const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(path.join(dir, "calls"))}, ["wevtutil", ...a].join(" ") + "\\n");
if (${fails}) { process.stderr.write("Access is denied.\\n"); process.exit(5); }
if (a[0] !== "qe" || a[1] !== "System") process.exit(1);
if (a.includes("/f:xml")) process.stdout.write(${JSON.stringify(boots.map(eventXml).join(""))});
else if (a.includes("/f:text") && a.includes("/q:*[System[(EventID=41)]]")) process.stdout.write(${JSON.stringify(newest)});
else process.exit(1);
`,
		{ mode: 0o755 },
	);
	return bin;
}
