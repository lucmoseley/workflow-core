/*
 * wsl-disk.js — the core of the monthly WSL disk compaction (#5044): reads
 * win-interop-watchdog/compact-disk.ps1's log, judges when a run is due and
 * when a quiet one should warn, judges the sparse watch, and runs one
 * compaction start. Every read and effect is a port.
 */

const { compareVersions } = require("./compare-versions.js");
const { docPath, scriptPath } = require("./script-path.js");

const DAY_MS = 86_400_000;

/** Untraced: the ruling's "monthly" (#5041 Q1). */
const DUE_DAYS = 30;

/** The ticket's figure (#5044): a month and a few days' grace for a deferral. */
const STALE_DAYS = 35;

/*
 * Untraced: about 8% of this laptop's 476 GB C:. The VM died at 7.7 GB free
 * (#5041), and rebuild-disk.ps1 stops at 15 GB.
 */
const LOW_FREE_GB = 40;

/** The ticket's figure (#5044): two missed weekly fstrim.timer runs. */
const TRIM_STALE_DAYS = 14;

/** Untraced: one listing read a poll, a few minutes apart. */
const POLL_MS = 5 * 60_000;

/** Untraced: the timer fires at 02:00, so a wait ends by morning. */
const MAX_WAIT_MS = 6 * 3_600_000;

/** Untraced: a listing that reads empty once may be a thin read, never twice. */
const ZERO_READINGS = 2;

/** A run's own result, which the WSL side's `trimfailed` and `watched` lines are not. */
const RUN_RESULTS = new Set(["ok", "failed", "deferred", "registered"]);

/*
 * microsoft/WSL issues on sparse safety (#5041's research): #41837 is the
 * one whose fix the ruling waits on; the other two are watched for a fix.
 */
const WATCHED_ISSUES = /** @type {const} */ ([41_837, 42_179, 10_609]);
const BLOCKING_ISSUE = 41_837;

/** Untraced: enough of a release's sparse lines for the ticket to quote. */
const QUOTED_LINES = 5;

const RUN_AGAIN = `\`node ${scriptPath("wsl-disk-compaction.js")} run --now\``;
const INSTALL = `\`bash ${scriptPath("install-interop-watchdog.sh")}\``;
const LOG_REMEDY = `read %LOCALAPPDATA%\\wsl-compact.log and \`journalctl --user -u wsl-disk-compaction\`, then ${RUN_AGAIN}`;

/**
 * @typedef {{at: number, result: string, fields: Record<string, string>, line: string}} Entry
 * @typedef {{number: number, state: string, state_reason: string | null}} IssueRow
 * @typedef {{tag_name: string, body: string | null, prerelease: boolean, draft: boolean}} ReleaseRow
 * @typedef {{key: string, title: string, line: string}} Trigger
 * @typedef {{why: string}} Failed
 * @typedef {import("./wsl-disk-host.js").LogRead} LogRead
 */

/**
 * @param {unknown} v
 * @returns {v is Failed}
 */
const isFailed = (v) => typeof v === "object" && v !== null && "why" in v;

/**
 * The log's lines, oldest first: `<local ISO time> <result> key=value…`.
 * A line that does not parse is skipped.
 * @param {string} text
 * @returns {Entry[]}
 */
function parseLog(text) {
	/** @type {Entry[]} */
	const entries = [];
	for (const raw of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
		const [stamp = "", result = "", ...tokens] = raw.trim().split(/\s+/);
		if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d$/.test(stamp)) continue;
		if (!/^[a-z]+$/.test(result)) continue;
		const at = Date.parse(stamp);
		if (Number.isNaN(at)) continue;
		/** @type {Record<string, string>} */
		const fields = {};
		for (const token of tokens) {
			const eq = token.indexOf("=");
			if (eq > 0) fields[token.slice(0, eq)] = token.slice(eq + 1);
		}
		entries.push({ at, result, fields, line: raw.trim() });
	}
	return entries;
}

/**
 * The newest `ok`, or the `registered` line the count starts from.
 * @param {Entry[]} entries
 * @returns {Entry | null}
 */
function lastSuccess(entries) {
	return (
		entries.findLast((e) => ["ok", "registered"].includes(e.result)) ?? null
	);
}

/**
 * Whether a run is due: DUE_DAYS since the last success, or none on record.
 * @param {Entry[]} entries
 * @param {number} now
 */
function isDue(entries, now) {
	const last = lastSuccess(entries);
	return last === null || now - last.at >= DUE_DAYS * DAY_MS;
}

/**
 * A WSL-side line in the ps1's shape, local time.
 * @param {number} at
 * @param {string} rest
 */
function buildLogLine(at, rest) {
	const d = new Date(at);
	const p = (/** @type {number} */ n) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} ${rest}`;
}

/** @param {string} text */
const asField = (text) => text.replace(/\s+/g, "_");

/**
 * The warnings a read log's entries carry.
 * @param {Entry[]} entries
 * @param {number} now
 */
function entryWarnings(entries, now) {
	const warnings = [];
	const last = lastSuccess(entries);
	const newest = entries.findLast((e) => RUN_RESULTS.has(e.result));
	const watch = entries.findLast((e) =>
		["watched", "watchfailed"].includes(e.result),
	);
	if (last === null || now - last.at > STALE_DAYS * DAY_MS)
		warnings.push({
			tag: "COMPACT-STALE",
			line: `${last === null ? "no compaction has succeeded" : `the last compaction succeeded ${Math.floor((now - last.at) / DAY_MS)} days ago`}, over ${STALE_DAYS}; newest log line: ${newest?.line ?? "none"}. A \`deferred\` line means sessions never drained by 08:00, or every live one waited on input; otherwise ${LOG_REMEDY}.`,
		});
	if (newest?.result === "failed")
		warnings.push({
			tag: "COMPACT-FAILED",
			line: `the last compaction run failed: ${newest.line}. ${LOG_REMEDY}.`,
		});
	const lastIndex = last === null ? -1 : entries.indexOf(last);
	const trim = entries
		.slice(0, lastIndex)
		.findLast((e) => e.result === "trimfailed" || RUN_RESULTS.has(e.result));
	if (last?.result === "ok" && trim?.result === "trimfailed")
		warnings.push({
			tag: "TRIM-FAILED",
			line: `the last compaction ran untrimmed, so it reclaimed little: ${trim.line}. Run \`wsl.exe -u root fstrim -av\` by hand to see why.`,
		});
	if (watch?.result === "watchfailed")
		warnings.push({
			tag: "WATCH-FAILED",
			line: `the sparse watch could not finish, so a reason to convert the disk to sparse may go unticketed: ${watch.line}. Read \`journalctl --user -u wsl-disk-compaction\`; the next due run watches again.`,
		});
	return warnings;
}

/**
 * fstrim.timer's warning: it keeps the disk's free blocks known between
 * compactions, and the stock unit never fires under WSL.
 * @param {number | null | Failed} lastTrim
 * @param {number} now
 */
function trimWarnings(lastTrim, now) {
	const remedy = `run \`sudo bash ${scriptPath("install-fstrim-wsl.sh")}\`, then \`systemctl list-timers fstrim.timer\``;
	if (isFailed(lastTrim))
		return [
			{
				tag: "TRIM-TIMER-UNREAD",
				line: `fstrim.timer's last run would not read: ${lastTrim.why}.`,
			},
		];
	if (lastTrim !== null && now - lastTrim <= TRIM_STALE_DAYS * DAY_MS)
		return [];
	return [
		{
			tag: "TRIM-TIMER-IDLE",
			line: `fstrim.timer ${lastTrim === null ? "has never fired" : `last fired ${Math.floor((now - lastTrim) / DAY_MS)} days ago, over ${TRIM_STALE_DAYS}`}: ${remedy}.`,
		},
	];
}

/**
 * The status check's verdict.
 * @param {{log: LogRead, now: number, freeGB: number | Failed,
 *   lastTrim: number | null | Failed}} input  lastTrim: fstrim.timer's last
 *   firing, null where it never has
 * @returns {{warnings: {tag: string, line: string}[], okLine: string}}
 */
function judgeDisk({ log, now, freeGB, lastTrim }) {
	const warnings = [...trimWarnings(lastTrim, now)];
	const free = isFailed(freeGB)
		? `C: free unread (${freeGB.why})`
		: `C: free ${freeGB.toFixed(1)} GB`;
	if (isFailed(freeGB))
		warnings.push({ tag: "C-UNREAD", line: `${free}; is C: mounted?` });
	else if (freeGB < LOW_FREE_GB)
		warnings.push({
			tag: "C-LOW",
			line: `${free}, under ${LOW_FREE_GB} GB. Run ${RUN_AGAIN}, and look for what is filling it (${docPath("environment.md")} §1).`,
		});
	if (log.state === "unreadable") {
		warnings.push({
			tag: "COMPACT-UNREAD",
			line: `the compaction log would not read, so whether the monthly run happens is unknown: ${log.why}.`,
		});
		return { warnings, okLine: "" };
	}
	if (log.state === "absent") {
		warnings.push({
			tag: "COMPACT-UNINSTALLED",
			line: `no wsl-compact.log in %LOCALAPPDATA%, so the monthly compaction is not installed: run ${INSTALL}.`,
		});
		return { warnings, okLine: "" };
	}
	const entries = parseLog(log.text);
	warnings.push(...entryWarnings(entries, now));
	const last = lastSuccess(entries);
	const shown =
		last === null
			? ""
			: `last compaction ${last.line.slice(0, 10)}${last.fields.after_gb ? ` (${last.fields.before_gb} to ${last.fields.after_gb} GB)` : ` (${last.result})`}, `;
	return { warnings, okLine: `${shown}${free}` };
}

/**
 * A watched issue's trigger: #41837 closed for any reason, another closed as
 * completed.
 * @param {IssueRow} i
 * @returns {Trigger[]}
 */
function issueTrigger(i) {
	if (i.state !== "closed") return [];
	const blocking = i.number === BLOCKING_ISSUE;
	if (!blocking && i.state_reason !== "completed") return [];
	return [
		{
			key: `issue-${i.number}`,
			title: `Convert the WSL disk to sparse? microsoft/WSL#${i.number} closed`,
			line: `microsoft/WSL#${i.number} closed (${i.state_reason ?? "no reason given"})${blocking ? ", the corruption after a full host disk that #5041 Q1 waits on" : ""}.`,
		},
	];
}

/**
 * A release's trigger: stable, newer than `installed`, its notes naming sparse.
 * @param {ReleaseRow} r
 * @param {number[]} installed
 * @returns {Trigger[]}
 */
function releaseTrigger(r, installed) {
	const tag = /^\d+(?:\.\d+)*$/.test(r.tag_name)
		? r.tag_name.split(".").map(Number)
		: null;
	if (r.draft || r.prerelease || tag === null) return [];
	if (compareVersions(tag, installed) <= 0) return [];
	const hits = (r.body ?? "")
		.split(/\r?\n/)
		.filter((l) => /sparse/i.test(l))
		.map((l) => l.trim());
	if (hits.length === 0) return [];
	return [
		{
			key: `release-${r.tag_name}`,
			title: `Convert the WSL disk to sparse? WSL ${r.tag_name} names sparse`,
			line: `WSL ${r.tag_name}'s notes name sparse: ${hits.slice(0, QUOTED_LINES).join(" / ")}`,
		},
	];
}

/**
 * The sparse watch's triggers (#5041 Q1 (B)): what would make converting to
 * sparse worth asking about again. Each title is unique to its trigger, so a
 * filing is deduped on the title.
 * @param {{issues: IssueRow[], releases: ReleaseRow[], installed: number[]}} input
 * @returns {Trigger[]}
 */
function judgeSparse({ issues, releases, installed }) {
	return [
		...issues.flatMap(issueTrigger),
		...releases.flatMap((r) => releaseTrigger(r, installed)),
	];
}

/** @param {Trigger} t */
const buildTicketBody = (t) =>
	`${t.line}\n\n## Question\n\nShould \`ext4.vhdx\` be converted to sparse now (\`wsl --manage Ubuntu --set-sparse true\`, with \`sparseVhd=true\` in \`.wslconfig\`)? #5041 Q1 ruled (A), monthly compaction, and kept (B) waiting on microsoft/WSL#41837's fix. Re-read #41837, #42179 and #10609, and the release notes, before pricing it.\n\nFiled by \`scripts/wsl-disk-compaction.js\`'s sparse watch (#5044).\n`;

/**
 * @typedef {{
 *   readInstalled: () => {version: string} | Failed,
 *   readIssue: (n: number) => IssueRow | Failed,
 *   readReleases: () => ReleaseRow[] | Failed,
 *   findFiled: (title: string) => number | null | Failed,
 *   file: (title: string, body: string) => string | Failed,
 * }} SparsePorts
 */

/**
 * The sparse watch: one line per outcome, filing a ticket per new trigger,
 * and whether any read or filing failed. A failure never stops the run.
 * @param {SparsePorts} ports
 * @returns {{lines: string[], failed: boolean}}
 */
function runSparseWatch(ports) {
	const installed = ports.readInstalled();
	if (isFailed(installed))
		return {
			lines: [`not read: wsl.exe --version: ${installed.why}`],
			failed: true,
		};
	const issues = WATCHED_ISSUES.map((n) => ports.readIssue(n));
	const releases = ports.readReleases();
	const unread = [...issues, releases].filter(isFailed);
	if (unread.length > 0 || isFailed(releases))
		return { lines: unread.map((f) => `not read: ${f.why}`), failed: true };
	const triggers = judgeSparse({
		issues: /** @type {IssueRow[]} */ (issues),
		releases,
		installed: installed.version.split(".").map(Number),
	});
	if (triggers.length === 0) return { lines: ["no trigger"], failed: false };
	const outcomes = triggers.map((t) => fileTrigger(ports, t));
	return {
		lines: outcomes.map((o) => o.line),
		failed: outcomes.some((o) => o.failed),
	};
}

/**
 * @param {SparsePorts} ports
 * @param {Trigger} t
 * @returns {{line: string, failed: boolean}}
 */
function fileTrigger(ports, t) {
	const found = ports.findFiled(t.title);
	if (isFailed(found))
		return { line: `${t.line} Not filed: ${found.why}`, failed: true };
	if (found !== null)
		return { line: `${t.line} Already ticketed: #${found}.`, failed: false };
	const filed = ports.file(t.title, buildTicketBody(t));
	return isFailed(filed)
		? { line: `${t.line} Not filed: ${filed.why}`, failed: true }
		: { line: `${t.line} Filed: ${filed}`, failed: false };
}

/**
 * @typedef {{
 *   now: () => number,
 *   readKernelRelease: () => string | Failed,
 *   readLog: () => LogRead,
 *   appendLine: (path: string, line: string) => void,
 *   sparseWatch: () => {lines: string[], failed: boolean},
 *   readLiveSessions: () => {live: number, waiting: number} | Failed,
 *   hold: () => string | null,
 *   release: () => string | null,
 *   sleep: (ms: number) => void,
 *   trim: () => {out: string, error: string | null},
 *   startTask: () => string | null,
 *   say: (line: string) => void,
 * }} RunPorts
 */

/**
 * One run: 0 started, not due or not WSL; 1 deferred, not installed or a
 * step failed.
 * @param {RunPorts} ports
 * @param {{force: boolean}} opts
 * @returns {number}
 */
function runCompaction(ports, { force }) {
	const log = readyLog(ports, force);
	if (typeof log === "number") return log;
	const append = (/** @type {string} */ rest) =>
		ports.appendLine(log, buildLogLine(ports.now(), rest));
	const watch = ports.sparseWatch();
	for (const line of watch.lines) ports.say(`sparse watch: ${line}`);
	append(watch.failed ? "watchfailed" : "watched");
	const drained = drain(ports, append);
	if (drained !== null) return drained;
	const trimmed = ports.trim();
	if (trimmed.error === null)
		ports.say(`trimmed: ${trimmed.out.replace(/\s+/g, " ")}`);
	else {
		// Compacting untrimmed still drops what an earlier trim freed.
		append(`trimfailed error=${asField(trimmed.error)}`);
		ports.say(`fstrim failed, compacting untrimmed: ${trimmed.error}`);
	}
	const started = ports.startTask();
	if (started !== null) return fail(ports, append, "schtasks", started);
	ports.say('started "WSL Disk Compaction"; WSL shuts down now.');
	return 0;
}

/**
 * The log's path where the run goes ahead, else its exit.
 * @param {RunPorts} ports
 * @param {boolean} force
 * @returns {string | number}
 */
function readyLog(ports, force) {
	const kernel = ports.readKernelRelease();
	if (isFailed(kernel)) {
		ports.say(`the kernel release would not read: ${kernel.why}.`);
		return 1;
	}
	if (!/microsoft/i.test(kernel)) {
		ports.say("not WSL; nothing to compact.");
		return 0;
	}
	const log = ports.readLog();
	if (log.state !== "read") {
		ports.say(
			log.state === "absent"
				? `no wsl-compact.log on the Windows side, so the task is not registered: run ${INSTALL}.`
				: `the compaction log would not read: ${log.why}.`,
		);
		return 1;
	}
	const entries = parseLog(log.text);
	if (force || isDue(entries, ports.now())) return log.path;
	ports.say(`not due: last success ${lastSuccess(entries)?.line}.`);
	return 0;
}

/**
 * Holds launches until no session is live on ZERO_READINGS polls running,
 * renewing the hold each poll: null once none is, else the exit, the hold
 * released. A listing that will not read counts as live. Where every live
 * session waits on input, none will end by morning, so it defers at once.
 * @param {RunPorts} ports
 * @param {(rest: string) => void} append
 * @returns {number | null}
 */
function drain(ports, append) {
	const start = ports.now();
	let zeros = 0;
	for (;;) {
		const held = ports.hold();
		if (held !== null) return fail(ports, append, "hold", held);
		const read = ports.readLiveSessions();
		zeros = !isFailed(read) && read.live === 0 ? zeros + 1 : 0;
		if (zeros >= ZERO_READINGS) return null;
		const shown = isFailed(read)
			? read.why
			: `${read.live} live, ${read.waiting} waiting on input`;
		const stuck =
			!isFailed(read) && read.live > 0 && read.waiting === read.live;
		if (stuck || ports.now() - start >= MAX_WAIT_MS)
			return defer(ports, append, shown);
		ports.say(`waiting: ${shown}; launches held.`);
		ports.sleep(POLL_MS);
	}
}

/**
 * @param {RunPorts} ports
 * @param {(rest: string) => void} append
 * @param {string} shown
 */
function defer(ports, append, shown) {
	const released = ports.release();
	append(`deferred sessions=${asField(shown)}`);
	ports.say(
		`deferred: sessions still live (${shown})${released ? `; the hold did not release: ${released}` : ""}. The next night's timer tries again.`,
	);
	return 1;
}

/**
 * @param {RunPorts} ports
 * @param {(rest: string) => void} append
 * @param {string} step
 * @param {string} why
 */
function fail(ports, append, step, why) {
	const released = ports.release();
	append(`failed step=${step} error=${asField(why)}`);
	ports.say(
		`${step} failed: ${why}${released ? `; release failed: ${released}` : ""}`,
	);
	return 1;
}

module.exports = {
	judgeDisk,
	judgeSparse,
	parseLog,
	runCompaction,
	runSparseWatch,
};
