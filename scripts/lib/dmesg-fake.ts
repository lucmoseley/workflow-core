import fs from "node:fs";
import path from "node:path";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = [
	"Jan",
	"Feb",
	"Mar",
	"Apr",
	"May",
	"Jun",
	"Jul",
	"Aug",
	"Sep",
	"Oct",
	"Nov",
	"Dec",
];
const pad = (n: number) => String(n).padStart(2, "0");

export function buildDmesgLine(ms: number, msg: string): string {
	const d = new Date(ms);
	const day = String(d.getUTCDate()).padStart(2, " ");
	const time = [d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()]
		.map(pad)
		.join(":");
	return `[${DAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${day} ${time} ${d.getUTCFullYear()}] ${msg}`;
}

export const RESTRICTED_REFUSAL =
	"dmesg: read kernel buffer failed: Operation not permitted";

export function writeDmesg(
	dir: string,
	lines: string[],
	{ restricted = false } = {},
): string {
	fs.mkdirSync(dir, { recursive: true });
	const ring = path.join(dir, "dmesg.ring");
	fs.writeFileSync(ring, lines.map((l) => `${l}\n`).join(""));
	const bin = path.join(dir, "dmesg");
	fs.writeFileSync(
		bin,
		`#!/usr/bin/env node
const fs = require("node:fs");
const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(path.join(dir, "calls"))}, ["dmesg", ...a].join(" ") + "\\n");
const bad = a.find((x) => x !== "-T");
if (bad !== undefined) {
	process.stderr.write("dmesg: invalid option -- '" + bad.replace(/^-+/, "") + "'\\n");
	process.exit(1);
}
if (${restricted}) {
	process.stderr.write(${JSON.stringify(`${RESTRICTED_REFUSAL}\n`)});
	process.exit(1);
}
const text = fs.readFileSync(${JSON.stringify(ring)}, "utf8");
if (a.includes("-T")) process.stdout.write(text);
else {
	const at = (l) => Date.parse(l.slice(1, l.indexOf("]")) + " UTC");
	const boot = at(text);
	process.stdout.write(
		text.replace(/^\\[[^\\]]+\\]/gm, (s) =>
			"[" + ((at(s) - boot) / 1000).toFixed(6).padStart(12) + "]",
		),
	);
}
`,
		{ mode: 0o755 },
	);
	return bin;
}
