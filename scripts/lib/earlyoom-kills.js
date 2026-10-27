/*
 * earlyoom-kills.js — earlyoom's kills on this machine, read from its own
 * journal lines, grouped into incidents (#3094, ruled at #3082): what the
 * incident filer tickets and the morning review lists.
 *
 * THE JOURNAL IS THE LOG. Debian's earlyoom.service runs with DynamicUser and
 * ProtectSystem=strict, so a `-N` script could write nowhere uid 1000 reads
 * (#3094's delegated decision); earlyoom already logs each signal as
 *   sending SIGTERM to process 658446 uid 1000 "MainThread": badness 741, VmRSS 983 MiB
 * after a `mem avail: … swap free: …` line, which this pairs with it.
 *
 * A KILL IS ONE PID: earlyoom re-signals a process that outlives SIGTERM
 * (25 Oct 2026: one 4 GB MainThread signalled four times over 43 s), so
 * repeated signals to one pid inside an incident are one kill, keeping the
 * first signal's readings and the count.
 *
 * AN INCIDENT is kills no more than INCIDENT_GAP_MS apart. It is OVER once
 * INCIDENT_GAP_MS has passed since its last kill: before then a later kill may
 * still join it, so the filer waits.
 *
 * FAILS OPEN: journalctl absent, refused, timed out or printing nothing reads
 * as no kills, with `why` set so a caller can say so. WFC_JOURNALCTL injects
 * the binary (§N7), as check-kernel-stall.js takes it.
 */

const { spawnSync } = require("node:child_process");
const { ghIssueListAll } = require("./gh.js");
const { requiredGroup } = require("./regex-group.js");
const { docPath } = require("./script-path.js");

/** Ruled at #3082 (Q1 → B); untraced. */
const INCIDENT_GAP_MS = 30 * 60 * 1000;

/* Both as check-kernel-stall.js's journal reader, whose comments derive them:
 * a read is well under 1 s, and an overflow is a failed read, never "no
 * kills". The whole earlyoom journal, 11 Sep to 26 Oct 2026, read 0.8 MB. */
const READ_TIMEOUT_MS = 5000;
const MAX_BUFFER = 64 * 1024 * 1024;

const LINE = /^(\S+) \S+ earlyoom\[\d+\]: (.*)$/;
const SIGNAL =
	/^sending (SIG\w+) to process (\d+) uid (\d+) "(.*)": badness (-?\d+), VmRSS (\d+) MiB$/;
const READING = /^mem avail:\s*(\d+) of\s*\d+ MiB .*swap free:\s*(\d+) of/;

/** Claude hosts, pty hosts and spares are named by version (#3082). */
const CLAUDE_HOST = /^(\d+\.\d+\.\d+|claude)$/;
/** Every node process's comm is `MainThread`, so it counts as a test or build. */
const TEST_OR_BUILD =
	/^(MainThread|node|npm|npx|tsc|vitest|esbuild|biome|python3?|pytest)$/;

const KINDS = /** @type {const} */ (["Claude host", "test or build", "other"]);
/** @typedef {typeof KINDS[number]} Kind */

/**
 * @typedef {object} Kill
 * @property {string} at the first signal, ISO
 * @property {number} pid
 * @property {number} uid
 * @property {string} name comm, as earlyoom printed it
 * @property {Kind} kind
 * @property {number} badness
 * @property {number} rssMiB
 * @property {number|null} availMiB MemAvailable before the first signal
 * @property {number|null} swapFreeMiB SwapFree then
 * @property {number} signals
 * @typedef {{kills: Kill[], first: string, last: string}} Incident
 */

/** @param {string} name @returns {Kind} */
function kindOf(name) {
	if (CLAUDE_HOST.test(name)) return "Claude host";
	if (TEST_OR_BUILD.test(name)) return "test or build";
	return "other";
}

/**
 * Kills from journalctl's short-iso lines, oldest first, a pid's repeated
 * signals not yet merged.
 * @param {string} text
 * @returns {Kill[]}
 */
function parseSignals(text) {
	/** @type {Kill[]} */
	const out = [];
	/** @type {{availMiB: number, swapFreeMiB: number}|null} */
	let reading = null;
	for (const line of text.split("\n")) {
		const m = line.match(LINE);
		if (!m) continue;
		const msg = requiredGroup(m, 2, LINE);
		const r = msg.match(READING);
		if (r) {
			reading = {
				availMiB: Number(requiredGroup(r, 1, READING)),
				swapFreeMiB: Number(requiredGroup(r, 2, READING)),
			};
			continue;
		}
		const s = msg.match(SIGNAL);
		const at = Date.parse(requiredGroup(m, 1, LINE));
		if (!s || Number.isNaN(at)) continue;
		const group = (/** @type {number} */ n) => requiredGroup(s, n, SIGNAL);
		const name = group(4);
		out.push({
			at: new Date(at).toISOString(),
			pid: Number(group(2)),
			uid: Number(group(3)),
			name,
			kind: kindOf(name),
			badness: Number(group(5)),
			rssMiB: Number(group(6)),
			availMiB: reading?.availMiB ?? null,
			swapFreeMiB: reading?.swapFreeMiB ?? null,
			signals: 1,
		});
	}
	return out;
}

/**
 * @param {Kill[]} signals oldest first
 * @returns {Incident[]}
 */
function groupIncidents(signals) {
	/** @type {Incident[]} */
	const out = [];
	for (const s of signals) {
		const open = out.at(-1);
		if (open && Date.parse(s.at) - Date.parse(open.last) <= INCIDENT_GAP_MS) {
			open.last = s.at;
			const same = open.kills.find((k) => k.pid === s.pid);
			if (same) same.signals += 1;
			else open.kills.push({ ...s });
		} else out.push({ kills: [{ ...s }], first: s.at, last: s.at });
	}
	return out;
}

/** @param {Incident} i @param {number} now */
const isOver = (i, now) => now - Date.parse(i.last) > INCIDENT_GAP_MS;

/**
 * earlyoom's journal since `sinceMs`. A read that failed is no kills, with why.
 * @param {number} sinceMs
 * @returns {{text: string, why: string|null}}
 */
function readJournal(sinceMs) {
	const r = spawnSync(
		process.env.WFC_JOURNALCTL || "journalctl",
		[
			"-u",
			"earlyoom",
			"--no-pager",
			"-o",
			"short-iso",
			"--since",
			`@${Math.floor(sinceMs / 1000)}`,
		],
		{
			encoding: "utf8",
			timeout: READ_TIMEOUT_MS,
			stdio: ["ignore", "pipe", "pipe"],
			maxBuffer: MAX_BUFFER,
		},
	);
	if (r.error || r.status !== 0)
		return {
			text: "",
			why: `journalctl -u earlyoom: ${r.error?.message ?? (r.stderr.trim() || `exit ${r.status}`)}`,
		};
	return { text: r.stdout, why: null };
}

/**
 * The incidents with a kill after `sinceMs`, each read whole: where the
 * first incident read starts within INCIDENT_GAP_MS of the read's start, an
 * earlier kill may belong to it, so the journal is read again from further
 * back. Its first kill names its ticket, so it is never cut.
 * @param {number} sinceMs
 * @returns {{incidents: Incident[], why: string|null}}
 */
function readIncidents(sinceMs) {
	let start = sinceMs - INCIDENT_GAP_MS;
	for (;;) {
		const { text, why } = readJournal(start);
		if (why !== null) return { incidents: [], why };
		const all = groupIncidents(parseSignals(text));
		const head = all[0];
		/* Each re-read starts strictly earlier, as head.first only moves back. */
		if (head && Date.parse(head.first) - start < INCIDENT_GAP_MS) {
			start = Date.parse(head.first) - INCIDENT_GAP_MS;
			continue;
		}
		return {
			incidents: all.filter((i) => Date.parse(i.last) > sinceMs),
			why: null,
		};
	}
}

/** @param {Date} d UTC `YYYY-MM-DD HH:MM` */
const utcMinute = (d) => d.toISOString().slice(0, 16).replace("T", " ");

/** @param {Date} d machine-local `YYYY-MM-DD HH:MM` */
const localMinute = (d) =>
	`${[d.getFullYear(), d.getMonth() + 1, d.getDate()]
		.map((v) => String(v).padStart(2, "0"))
		.join("-")} ${[d.getHours(), d.getMinutes()]
		.map((v) => String(v).padStart(2, "0"))
		.join(":")}`;

/** @param {Date} d machine-local `HH:MM:SS` */
const localTime = (d) =>
	[d.getHours(), d.getMinutes(), d.getSeconds()]
		.map((v) => String(v).padStart(2, "0"))
		.join(":");

const TITLE_PREFIX = "Memory kill incident from ";

/**
 * UTC, so a run under another TZ names the incident the same. Two incidents
 * cannot start in one minute: they are over INCIDENT_GAP_MS apart.
 */
const incidentTitle = (/** @type {Incident} */ i) =>
	`${TITLE_PREFIX}${utcMinute(new Date(i.first))} UTC`;

/**
 * A name earlyoom copied from comm, as a code span: comm is the process's own
 * to set, so a backtick, a pipe or a control character is replaced.
 * @param {string} name
 */
const nameSpan = (name) =>
	`\`${name.replace(/[`|\p{Cc}]/gu, "?") || "(empty)"}\``;

/** @param {number|null} v */
const mib = (v) => (v === null ? "unread" : `${v} MiB`);

/** @param {Kill[]} kills @returns {string} `Claude host 2, test or build 1, other 0` */
const byKind = (kills) =>
	KINDS.map((k) => `${k} ${kills.filter((x) => x.kind === k).length}`).join(
		", ",
	);

/**
 * The incident ticket's body.
 * @param {Incident} i
 */
function buildIncidentBody(i) {
	const first = new Date(i.first);
	const last = new Date(i.last);
	const lowest = i.kills.reduce(
		(lo, k) =>
			k.availMiB !== null && (lo === null || k.availMiB < lo.availMiB)
				? /** @type {Kill & {availMiB: number}} */ (k)
				: lo,
		/** @type {(Kill & {availMiB: number})|null} */ (null),
	);
	/* Untraced: ten minutes before the first kill shows the readings leading
	 * in, one after the last its exit line. */
	const from = Math.floor(first.getTime() / 1000) - 600;
	const to = Math.floor(last.getTime() / 1000) + 60;
	return `## What happened

earlyoom killed ${i.kills.length} ${i.kills.length === 1 ? "process" : "processes"} between ${localMinute(first)} and ${localMinute(last)} machine time, one incident: kills no more than ${INCIDENT_GAP_MS / 60_000} min apart (#3094).

By kind: ${byKind(i.kills)}. A \`MainThread\` is any node process; a test or build is the likeliest.

Lowest MemAvailable before a kill: ${lowest === null ? "unread" : `${lowest.availMiB} MiB, SwapFree ${mib(lowest.swapFreeMiB)}`}.

| Time | Kind | Name | PID | UID | VmRSS | Badness | MemAvailable | SwapFree | Signals |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
${i.kills
	.map(
		(k) =>
			`| ${localTime(new Date(k.at))} | ${k.kind} | ${nameSpan(k.name)} | ${k.pid} | ${k.uid} | ${k.rssMiB} MiB | ${k.badness} | ${mib(k.availMiB)} | ${mib(k.swapFreeMiB)} | ${k.signals} |`,
	)
	.join("\n")}

## What to find

Why admission let memory run out. Start from \`journalctl -u earlyoom --since @${from} --until @${to}\`, then \`~/memwatch.log\` and \`~/memwatch-archive.log\` around ${localMinute(first)}: which sessions and suites were running, and what admitted them (\`${docPath("environment.md")}\` §8).

## Acceptance criteria

- [ ] The cause is named, and fixed or ticketed.
`;
}

/**
 * The incident tickets on `repo`, open or closed, by title; throws where the
 * tracker cannot be read.
 * @param {string} repo
 * @returns {Map<string, number>}
 */
function readIncidentTickets(repo) {
	/** @type {{number: number, title: string}[]} */
	const found = ghIssueListAll("memory kill tickets", [
		"--repo",
		repo,
		"--state",
		"all",
		"--search",
		`in:title "${TITLE_PREFIX.trim()}"`,
		"--json",
		"number,title",
	]);
	return new Map(
		found
			.filter((i) => i.title.startsWith(TITLE_PREFIX))
			.map((i) => [i.title, i.number]),
	);
}

module.exports = {
	buildIncidentBody,
	byKind,
	incidentTitle,
	isOver,
	readIncidentTickets,
	readIncidents,
};
