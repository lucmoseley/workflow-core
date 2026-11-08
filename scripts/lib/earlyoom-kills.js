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
 * A HEADLESS RUN is a kill whose pid, boot and time match a run in
 * lib/headless-runs.js's store (#4143): same pid, the boot `journalctl
 * --list-boots` puts the kill in, launched at or before it, the latest such
 * run where two share them. A pid reused in another boot, or before the run's
 * launch, does not match. Within one boot a pid comes back only after
 * pid_max (4,194,304 here) forks, so the residual is a reuse of a dead run's
 * pid that late in the same boot.
 *
 * FAILS OPEN: journalctl absent, refused, timed out or printing nothing reads
 * as no kills, with `why` set so a caller can say so. A store or boot list
 * that will not read leaves the kills unjoined, with the incident's
 * `unjoined` saying why, never as no headless victims. WFC_JOURNALCTL injects
 * the binary (§N7), as check-kernel-stall.js takes it.
 */

const { spawnSync } = require("node:child_process");
const { caught } = require("./caught.js");
const { readStoredRuns } = require("./headless-runs.js");
const {
	buildProcessSpan,
	localMinute,
	readTicketsByPrefix,
	utcMinute,
} = require("./incident-tickets.js");
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

/** Hosts, pty hosts and spares read as their version (#3082, #4122). */
const CLAUDE_HOST = /^\d+\.\d+\.\d+$/;
/** The daemon, `claude agents` and `claude -p` read `claude` (#4122). */
const CLAUDE_CLI = /^claude$/;
/** Every node program's comm is `MainThread`: the refill loop, a test worker, a server (#3759). */
const NODE_OR_PYTHON = /^(MainThread|node|python3?)$/;
const TEST_OR_BUILD = /^(npm|npx|tsc|vitest|esbuild|biome|pytest)$/;

const KINDS = /** @type {const} */ ([
	"Claude host",
	"headless run",
	"claude CLI",
	"node or python process",
	"test or build",
	"other",
]);
/** @typedef {typeof KINDS[number]} Kind */

/**
 * @typedef {object} Kill
 * @property {string} at the first signal, ISO
 * @property {number} pid
 * @property {number} uid
 * @property {string} name comm, as earlyoom printed it
 * @property {Kind} kind
 * @property {string|null} jobId the headless run's, where the kill is one
 * @property {number} badness
 * @property {number} rssMiB
 * @property {number|null} availMiB MemAvailable before the first signal
 * @property {number|null} swapFreeMiB SwapFree then
 * @property {number} signals
 * @typedef {{kills: Kill[], first: string, last: string,
 *   unjoined: string|null}} Incident unjoined: why the kills were not joined
 *   to the headless runs
 */

/** @param {string} name @returns {Kind} */
function kindOf(name) {
	if (CLAUDE_HOST.test(name)) return "Claude host";
	if (CLAUDE_CLI.test(name)) return "claude CLI";
	if (NODE_OR_PYTHON.test(name)) return "node or python process";
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
			jobId: null,
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
		} else
			out.push({ kills: [{ ...s }], first: s.at, last: s.at, unjoined: null });
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

/** @typedef {{id: string, from: number, to: number}} Boot ms, to the second */

/**
 * The journal's boots, or why they could not be read.
 * @returns {{boots: Boot[], why: string|null}}
 */
function readBoots() {
	const r = spawnSync(
		process.env.WFC_JOURNALCTL || "journalctl",
		["--list-boots", "--no-pager", "-o", "json"],
		{
			encoding: "utf8",
			timeout: READ_TIMEOUT_MS,
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	const fail = (/** @type {string} */ why) => ({
		boots: [],
		why: `journalctl --list-boots: ${why}`,
	});
	if (r.error || r.status !== 0)
		return fail(r.error?.message ?? (r.stderr.trim() || `exit ${r.status}`));
	try {
		/* The kill's time is read to the second, so each boot's span is too. */
		const second = (/** @type {number} */ us) => Math.floor(us / 1e6) * 1000;
		const boots = /** @type {{boot_id: string, first_entry: number,
		 * last_entry: number}[]} */ (JSON.parse(r.stdout)).map((b) => ({
			id: b.boot_id,
			from: second(b.first_entry),
			to: second(b.last_entry),
		}));
		return { boots, why: null };
	} catch (err) {
		return fail(caught(err).message);
	}
}

/** /proc's boot_id carries dashes; journalctl's does not. */
const bootKey = (/** @type {string|null} */ id) =>
	id === null ? null : id.replace(/-/g, "");

/**
 * Each kill that is a stored headless run takes that kind and its job id; where
 * the store or the boots will not read, each incident says why instead.
 * @param {Incident[]} incidents
 * @returns {Incident[]}
 */
function joinHeadlessRuns(incidents) {
	if (incidents.length === 0) return incidents;
	/** @param {string} unjoined */
	const unread = (unjoined) => incidents.map((i) => ({ ...i, unjoined }));
	let runs;
	try {
		runs = readStoredRuns();
	} catch (err) {
		return unread(`the headless run store: ${caught(err).message}`);
	}
	const { boots, why } = readBoots();
	if (why !== null) return unread(why);
	return incidents.map((i) => ({
		...i,
		kills: i.kills.map((k) => {
			const at = Date.parse(k.at);
			const boot = boots.find((b) => b.from <= at && at <= b.to);
			const run = runs
				.filter(
					(r) =>
						r.pid === k.pid &&
						boot !== undefined &&
						bootKey(r.bootId) === boot.id &&
						Math.floor(r.launchedAt / 1000) * 1000 <= at,
				)
				.reduce(
					(a, r) => (a === null || r.launchedAt > a.launchedAt ? r : a),
					/** @type {import("./headless-runs.js").RunRecord|null} */ (null),
				);
			return run === null
				? k
				: {
						...k,
						kind: /** @type {Kind} */ ("headless run"),
						jobId: run.jobId,
					};
		}),
	}));
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
			incidents: joinHeadlessRuns(
				all.filter((i) => Date.parse(i.last) > sinceMs),
			),
			why: null,
		};
	}
}

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

/** @param {number|null} v */
const mib = (v) => (v === null ? "unread" : `${v} MiB`);

/**
 * Each kind that has a kill, with its count, and each headless run's job id.
 * @param {Kill[]} kills
 * @returns {string} `Claude host 2, headless run 1 (job 03998aa2), other 1`
 */
const byKind = (kills) =>
	KINDS.flatMap((kind) => {
		const of = kills.filter((x) => x.kind === kind);
		if (of.length === 0) return [];
		const jobs = of.flatMap((x) => (x.jobId === null ? [] : [x.jobId]));
		return [
			`${kind} ${of.length}${jobs.length > 0 ? ` (${jobs.length === 1 ? "job" : "jobs"} ${jobs.join(", ")})` : ""}`,
		];
	}).join(", ");

/** @param {Kill} k */
const kindCell = (k) =>
	k.jobId === null ? k.kind : `${k.kind} \`${k.jobId}\``;

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

By kind: ${byKind(i.kills)}. A headless run is a \`claude -p\` in the headless run store, matched on pid, boot and launch time; claude CLI is the daemon, \`claude agents\` or a \`-p\` the store has none for; a node or python process is any such program, the refill loop and test workers included.${i.unjoined === null ? "" : `\n\nNot joined to the headless runs, so a claude CLI kill may be one: ${i.unjoined}.`}

Lowest MemAvailable before a kill: ${lowest === null ? "unread" : `${lowest.availMiB} MiB, SwapFree ${mib(lowest.swapFreeMiB)}`}.

| Time | Kind | Name | PID | UID | VmRSS | Badness | MemAvailable | SwapFree | Signals |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
${i.kills
	.map(
		(k) =>
			`| ${localTime(new Date(k.at))} | ${kindCell(k)} | ${buildProcessSpan(k.name)} | ${k.pid} | ${k.uid} | ${k.rssMiB} MiB | ${k.badness} | ${mib(k.availMiB)} | ${mib(k.swapFreeMiB)} | ${k.signals} |`,
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
	return readTicketsByPrefix(repo, "memory kill tickets", TITLE_PREFIX);
}

module.exports = {
	buildIncidentBody,
	byKind,
	incidentTitle,
	isOver,
	readBoots,
	readIncidentTickets,
	readIncidents,
};
