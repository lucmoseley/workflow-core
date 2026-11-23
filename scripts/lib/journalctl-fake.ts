import fs from "node:fs";
import path from "node:path";
import { shellQuote } from "./sh-quote.js";

const stamp = (ms: number) =>
	new Date(ms).toISOString().replace(/\.\d{3}Z$/, "+00:00");

export const buildEarlyoomReadingLine = (ms: number, avail = 776, swap = 0) =>
	`${stamp(ms)} Luctop earlyoom[180]: mem avail:   ${avail} of  9924 MiB ( 7.83%), swap free:    ${swap} of 2048 MiB ( 0.00%)`;

export const buildEarlyoomSignalLine = (
	ms: number,
	pid: number,
	name: string,
	{ rss = 983, sig = "SIGTERM" } = {},
) =>
	`${stamp(ms)} Luctop earlyoom[180]: sending ${sig} to process ${pid} uid 1000 "${name}": badness 741, VmRSS ${rss} MiB`;

export const buildEarlyoomBannerLine = (ms: number) =>
	`${stamp(ms)} Luctop earlyoom[180]: sending SIGTERM when mem <=  8.00% and swap <= 100.00%,`;

export const buildJournalLine = (ms: number, ident: string, msg: string) =>
	`${stamp(ms)} Luctop ${ident}: ${msg}`;

export const buildKernelLine = (ms: number, msg: string) =>
	buildJournalLine(ms, "kernel", msg);

export interface FakeBoot {
	id: string;
	from: number;
	to: number;
}

export const ONE_BOOT: FakeBoot = {
	id: "0123456789abcdef0123456789abcdef",
	from: 0,
	to: Date.parse("2100-01-01T00:00:00Z"),
};

export function writeJournalctl(
	dir: string,
	lines: string[],
	boots: FakeBoot[] | null = [ONE_BOOT],
): string {
	fs.mkdirSync(dir, { recursive: true });
	const journal = path.join(dir, "journal");
	// #4601
	const timed = lines.flatMap((l) => {
		const ms = Date.parse(l.split(" ")[0] ?? "");
		return l && !Number.isNaN(ms)
			? l
					.replace(/\n$/, "")
					.split("\n")
					.map((part, i) => `${ms}\t${i ? "+" : "-"}${part}\n`)
			: [];
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
	const listBootsReply =
		listed === null
			? "echo 'no boots' >&2; exit 1"
			: `printf '%s\\n' ${shellQuote(JSON.stringify(listed))}; exit 0`;
	fs.writeFileSync(
		bin,
		`#!/bin/sh
if [ $# -eq 0 ]; then printf '%s\\n' journalctl; else printf '%s\\n' "journalctl $*"; fi >> ${shellQuote(path.join(dir, "calls"))}
since=
boots=
cat=
next=
for x in "$@"; do
	case $next in since) since=$x ;; output) [ "$x" = cat ] && cat=1 || cat= ;; esac
	next=
	case $x in --list-boots) boots=1 ;; --since) next=since ;; -o | --output) next=output ;; --output=cat) cat=1 ;; --output=*) cat= ;; esac
done
if [ -n "$boots" ]; then ${listBootsReply}; fi
# As the real one: the last --since wins, and one not @<digits> is refused.
case $since in
'') ;;
@*[!0-9]* | @) echo "Failed to parse timestamp: $since" >&2; exit 1 ;;
@*) since=\${since#@} ;;
*) echo "journalctl fake: serves only --since @<s>, not $since" >&2; exit 1 ;;
esac
exec awk -v s="$since" -v cat="$cat" '{ if (s == "" || $1 + 0 >= s * 1000) { l = substr($0, index($0, "\\t") + 1); more = substr(l, 1, 1) == "+"; l = substr(l, 2); if (cat && !more) sub(/^[^ ]+ [^ ]+ [^ :]+: /, "", l); print l; n++ } } END { if (!n && !cat) print "-- No entries --" }' ${shellQuote(journal)}
`,
		{ mode: 0o755 },
	);
	return bin;
}

export function writeFailingJournalctl(dir: string): string {
	fs.mkdirSync(dir, { recursive: true });
	const bin = path.join(dir, "journalctl");
	fs.writeFileSync(bin, "#!/bin/sh\necho denied >&2\nexit 1\n", {
		mode: 0o755,
	});
	return bin;
}
