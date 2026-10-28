/*
 * journalctl's `-o short-iso` output, for tests of lib/earlyoom-kills.js's
 * readers (#3094) and check-kernel-stall.js's kernel reader: the line builders
 * and a stub journalctl honouring `--since @<s>`, injected at WFC_JOURNALCTL.
 * Held to the real journalctl by earlyoom-journal.contract.test.ts (#3105).
 */
import fs from "node:fs";
import path from "node:path";

const stamp = (ms: number) =>
	new Date(ms).toISOString().replace(/\.\d{3}Z$/, "+00:00");

/** The `mem avail … swap free …` line earlyoom prints before a signal. */
export const readingLine = (ms: number, avail = 776, swap = 0) =>
	`${stamp(ms)} Luctop earlyoom[180]: mem avail:   ${avail} of  9924 MiB ( 7.83%), swap free:    ${swap} of 2048 MiB ( 0.00%)`;

export const signalLine = (
	ms: number,
	pid: number,
	name: string,
	{ rss = 983, sig = "SIGTERM" } = {},
) =>
	`${stamp(ms)} Luctop earlyoom[180]: sending ${sig} to process ${pid} uid 1000 "${name}": badness 741, VmRSS ${rss} MiB`;

/** A line earlyoom prints that is neither: its startup banner's. */
export const otherLine = (ms: number) =>
	`${stamp(ms)} Luctop earlyoom[180]: sending SIGTERM when mem <=  8.00% and swap <= 100.00%,`;

/** A kernel line, as `journalctl -k` prints it. */
export const kernelLine = (ms: number, msg: string) =>
	`${stamp(ms)} Luctop kernel: ${msg}`;

/**
 * A journalctl in `dir` serving `lines` from `--since` on, or all of them
 * without one, and `-- No entries --` where none is served, as the real one
 * does. It appends each call's `journalctl <args>` to `dir/calls`. Its path,
 * for WFC_JOURNALCTL.
 */
export function writeJournalctl(dir: string, lines: string[]): string {
	fs.mkdirSync(dir, { recursive: true });
	const journal = path.join(dir, "journal");
	fs.writeFileSync(journal, `${lines.join("\n")}\n`);
	const bin = path.join(dir, "journalctl");
	fs.writeFileSync(
		bin,
		`#!/usr/bin/env node
const fs = require("node:fs");
const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(path.join(dir, "calls"))}, ["journalctl", ...a].join(" ") + "\\n");
const at = a.indexOf("--since");
const since = at < 0 ? -Infinity : Number(a[at + 1].slice(1)) * 1000;
const out = fs
	.readFileSync(${JSON.stringify(journal)}, "utf8")
	.split("\\n")
	.filter((l) => l && Date.parse(l.split(" ")[0]) >= since);
process.stdout.write((out.length ? out : ["-- No entries --"]).join("\\n") + "\\n");
`,
		{ mode: 0o755 },
	);
	return bin;
}

/** A journalctl in `dir` that refuses, as one without permission does. */
export function writeFailingJournalctl(dir: string): string {
	fs.mkdirSync(dir, { recursive: true });
	const bin = path.join(dir, "journalctl");
	fs.writeFileSync(bin, "#!/bin/sh\necho denied >&2\nexit 1\n", {
		mode: 0o755,
	});
	return bin;
}
