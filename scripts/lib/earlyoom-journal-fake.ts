/*
 * journalctl's `-o short-iso` output, for tests of lib/earlyoom-kills.js's
 * readers (#3094) and check-kernel-stall.js's kernel reader: the line builders
 * and a stub journalctl honouring `--since @<s>`, injected at WFC_JOURNALCTL.
 * Held to the real journalctl by earlyoom-journal.contract.test.ts (#3105).
 */
import fs from "node:fs";
import path from "node:path";
import { shellQuote } from "./sh-quote.js";

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

/** A boot as the fake lists it: journalctl's undashed id and its span, ms. */
export interface FakeBoot {
	id: string;
	from: number;
	to: number;
}

/** One boot spanning every line a test writes. */
export const ONE_BOOT: FakeBoot = {
	id: "0123456789abcdef0123456789abcdef",
	from: 0,
	to: Date.parse("2100-01-01T00:00:00Z"),
};

/**
 * A journalctl in `dir` serving `lines` from `--since` on, or all of them
 * without one, and `-- No entries --` where none is served, as the real one
 * does; `--list-boots -o json` serves `boots`, or refuses where `boots` is
 * null. It appends each call's `journalctl <args>` to `dir/calls`. Its path,
 * for WFC_JOURNALCTL.
 */
export function writeJournalctl(
	dir: string,
	lines: string[],
	boots: FakeBoot[] | null = [ONE_BOOT],
): string {
	fs.mkdirSync(dir, { recursive: true });
	const journal = path.join(dir, "journal");
	/* Each line's time, read once here, so the stub filters with awk and starts
	 * no node per call; a line with no readable time is never served. */
	const timed = lines.flatMap((l) => {
		const ms = Date.parse(l.split(" ")[0] ?? "");
		return l && !Number.isNaN(ms) ? [`${ms}\t${l}\n`] : [];
	});
	fs.writeFileSync(journal, timed.join(""));
	const listed =
		boots === null
			? null
			: boots.map((b, i) => ({
					index: i - boots.length + 1,
					boot_id: b.id,
					first_entry: b.from * 1000,
					last_entry: b.to * 1000,
				}));
	const bin = path.join(dir, "journalctl");
	const boots_ =
		listed === null
			? "echo 'no boots' >&2; exit 1"
			: `printf '%s\\n' ${shellQuote(JSON.stringify(listed))}; exit 0`;
	fs.writeFileSync(
		bin,
		`#!/bin/sh
if [ $# -eq 0 ]; then printf '%s\\n' journalctl; else printf '%s\\n' "journalctl $*"; fi >> ${shellQuote(path.join(dir, "calls"))}
since=
boots=
next=
for x in "$@"; do
	[ -n "$next" ] && since=\${x#@}
	next=
	case $x in --list-boots) boots=1 ;; --since) next=1 ;; esac
done
if [ -n "$boots" ]; then ${boots_}; fi
exec awk -v s="$since" '{ if (s == "" || $1 + 0 >= s * 1000) { print substr($0, index($0, "\\t") + 1); n++ } } END { if (!n) print "-- No entries --" }' ${shellQuote(journal)}
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
