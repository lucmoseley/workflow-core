/*
 * earlyoom's journal as `journalctl -u earlyoom -o short-iso` prints it, for
 * tests of lib/earlyoom-kills.js's readers (#3094): the line builders and a
 * stub journalctl honouring `--since @<s>`, injected at WFC_JOURNALCTL.
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

/**
 * A journalctl in `dir` serving `lines` from `--since` on, logging each
 * read's start to `dir/reads`. Its path, for WFC_JOURNALCTL.
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
const since = Number(a[a.indexOf("--since") + 1].slice(1)) * 1000;
fs.appendFileSync(${JSON.stringify(path.join(dir, "reads"))}, since + "\\n");
for (const l of fs.readFileSync(${JSON.stringify(journal)}, "utf8").split("\\n"))
	if (l && Date.parse(l.split(" ")[0]) >= since) process.stdout.write(l + "\\n");
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
