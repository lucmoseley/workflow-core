/*
 * dmesg's `-T` output, for tests of check-kernel-stall.js's dmesg reader: the
 * line builder and a stub dmesg honouring `-T`, injected at WFC_DMESG. Held to
 * the real dmesg by dmesg.contract.test.ts (#3362).
 */
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

/**
 * A kernel line, as `dmesg -T` prints it: `[Wed Oct  7 22:43:24 2026] <msg>`,
 * the stamp in UTC where the real one is local time.
 */
export function dmesgLine(ms: number, msg: string): string {
	const d = new Date(ms);
	const day = String(d.getUTCDate()).padStart(2, " ");
	const time = [d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()]
		.map(pad)
		.join(":");
	return `[${DAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${day} ${time} ${d.getUTCFullYear()}] ${msg}`;
}

/** What the real dmesg prints, exiting 1, where kernel.dmesg_restrict holds it. */
export const RESTRICTED_REFUSAL =
	"dmesg: read kernel buffer failed: Operation not permitted";

/**
 * A dmesg in `dir` serving `lines` (dmesgLine's) under `-T`, and without it
 * stamped in seconds since the first, as the real one stamps time since boot,
 * so a reader that drops `-T` reads no wall time.
 * Restricted, it serves nothing and refuses as the real one does. It appends
 * each call's `dmesg <args>` to `dir/calls`. Its path, for WFC_DMESG.
 */
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
