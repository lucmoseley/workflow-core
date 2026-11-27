const { caught } = require("./caught.js");
const { readStoredRuns } = require("./headless-runs.js");
const { heldUntil, readRunFiles } = require("./run-memory.js");
const { gateHeldUntil, readGatePids } = require("./gate-seat.js");
const { shortJobId } = require("./job-paths.js");
const {
	buildProcessSpan,
	localMinute,
	readTicketsByPrefix,
	utcMinute,
} = require("./incident-tickets.js");
const {
	bootKey,
	readBoots,
	runJournalctl,
	toSecond,
} = require("./journalctl.js");
const { requiredGroup } = require("./regex-group.js");
const { docPath } = require("./script-path.js");

// guess, workflow-core#3082
const INCIDENT_GAP_MS = 30 * 60 * 1000;

const LINE = /^(\S+) \S+ earlyoom\[\d+\]: (.*)$/;
const SIGNAL =
	/^sending (SIG\w+) to process (\d+) uid (\d+) "(.*)": badness (-?\d+), VmRSS (\d+) MiB$/;
const READING = /^mem avail:\s*(\d+) of\s*\d+ MiB .*swap free:\s*(\d+) of/;

/** workflow-core#3082, workflow-core#4122 */
const CLAUDE_HOST = /^\d+\.\d+\.\d+$/;
const CLAUDE_CLI = /^claude$/;
/** workflow-core#3759 */
const NODE_OR_PYTHON = /^(MainThread|node|python3?)$/;
const TEST_OR_BUILD = /^(npm|npx|tsc|vitest|esbuild|biome|pytest)$/;
/** workflow-core#5269 */
const CHROMIUM = /^(headless_shell|chrome|chromium)$/;

const KINDS = /** @type {const} */ ([
	"Claude host",
	"headless run",
	"test run",
	"gate run",
	"claude CLI",
	"node or python process",
	"test or build",
	"Chromium",
	"other",
]);
/** @typedef {typeof KINDS[number]} Kind */

/**
 * @typedef {object} Kill
 * @property {string} at
 * @property {number} pid
 * @property {number} uid
 * @property {string} name
 * @property {Kind} kind
 * @property {string|null} jobId
 * @property {TestRun|null} testRun
 * @property {GateRun|null} gateRun
 * @property {number} badness
 * @property {number} rssMiB
 * @property {number|null} availMiB
 * @property {number|null} swapFreeMiB
 * @property {number} signals
 * @typedef {Pick<import("./run-memory.js").RunLaunch, "session"|"kind"|"argv"|"files"|"fileCount"|"repo">
 *   & {role: import("./run-memory.js").Role}} TestRun
 * @typedef {Pick<import("./gate-seat.js").GatePids, "repo"|"command"|"session">} GateRun
 * @typedef {{kills: Kill[], first: string, last: string,
 *   unjoined: string|null}} Incident
 */

/** @param {string} name @returns {Kind} */
function kindOf(name) {
	if (CLAUDE_HOST.test(name)) return "Claude host";
	if (CLAUDE_CLI.test(name)) return "claude CLI";
	if (NODE_OR_PYTHON.test(name)) return "node or python process";
	if (TEST_OR_BUILD.test(name)) return "test or build";
	if (CHROMIUM.test(name)) return "Chromium";
	return "other";
}

/**
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
			testRun: null,
			gateRun: null,
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
 * @param {Kill[]} signals
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
 * @param {number} sinceMs
 * @returns {{text: string, why: string|null}}
 */
function readJournal(sinceMs) {
	const { stdout, why } = runJournalctl([
		"-u",
		"earlyoom",
		"--no-pager",
		"-o",
		"short-iso",
		"--since",
		`@${Math.floor(sinceMs / 1000)}`,
	]);
	return {
		text: stdout,
		why: why === null ? null : `journalctl -u earlyoom: ${why}`,
	};
}

/**
 * @template {{ bootId: string|null, started: number }} T
 * @param {T[]} items
 * @param {import("./journalctl.js").Boot|undefined} boot
 * @returns {T|null}
 */
function latestInBoot(items, boot) {
	return items
		.filter(
			(i) =>
				boot !== undefined &&
				i.bootId !== null &&
				bootKey(i.bootId) === boot.id,
		)
		.reduce(
			(a, i) => (a === null || i.started > a.started ? i : a),
			/** @type {T|null} */ (null),
		);
}

/** @param {string[]} runs @returns {string[]} */
const bootlessNote = (runs) =>
	runs.length === 0
		? []
		: [`${runs.join(", ")} on a victim's pid recorded no boot`];

/**
 * @template {{ at: string, bootId: string|null }} R
 * @template H
 * @param {Kill} k
 * @param {import("./journalctl.js").Boot|undefined} boot
 * @param {R[]} records
 * @param {{ label: string, holdOf: (r: R) => { until: number, hold: H }|null }} reading
 * @returns {{ latest: { record: R, hold: H }|null, bootless: string[] }}
 */
function latestHolding(k, boot, records, { label, holdOf }) {
	const at = Date.parse(k.at);
	const held = records.flatMap((record) => {
		const seen = holdOf(record);
		return seen !== null &&
			toSecond(Date.parse(record.at)) <= at &&
			at <= seen.until
			? [
					{
						record,
						hold: seen.hold,
						bootId: record.bootId,
						started: Date.parse(record.at),
					},
				]
			: [];
	});
	return {
		latest: latestInBoot(held, boot),
		bootless: held.flatMap(({ record }) =>
			record.bootId === null ? [`${label} from ${record.at}`] : [],
		),
	};
}

/**
 * @param {Kill} k
 * @param {import("./journalctl.js").Boot|undefined} boot
 * @param {import("./run-memory.js").RunFile[]} runs
 * @returns {{testRun: TestRun|null, bootless: string[]}}
 */
function findTestRun(k, boot, runs) {
	if (k.kind !== "node or python process")
		return { testRun: null, bootless: [] };
	const { latest, bootless } = latestHolding(k, boot, runs, {
		label: "test run",
		holdOf: (r) => {
			const seen = heldUntil(r, k.pid);
			return seen && { until: seen.until, hold: seen.role };
		},
	});
	if (latest === null) return { testRun: null, bootless };
	const { session, kind, argv, files, fileCount, repo } = latest.record;
	return {
		testRun: { role: latest.hold, session, kind, argv, files, fileCount, repo },
		bootless,
	};
}

/**
 * @param {Kill} k
 * @param {import("./journalctl.js").Boot|undefined} boot
 * @param {import("./gate-seat.js").GatePids[]} seats
 * @returns {{gateRun: GateRun|null, bootless: string[]}}
 */
function findGateRun(k, boot, seats) {
	const { latest, bootless } = latestHolding(k, boot, seats, {
		label: "gate run",
		holdOf: (seat) => {
			const until = gateHeldUntil(seat, k.pid);
			return until === null ? null : { until, hold: null };
		},
	});
	if (latest === null) return { gateRun: null, bootless };
	const { repo, command, session } = latest.record;
	return { gateRun: { repo, command, session }, bootless };
}

/**
 * @param {Kill} k
 * @param {import("./journalctl.js").Boot|undefined} boot
 * @param {{ runs: import("./run-memory.js").RunFile[],
 *   seats: import("./gate-seat.js").GatePids[] }} stores
 * @returns {{ kill: Kill, bootless: string[] }}
 */
function joinRecordedRun(k, boot, { runs, seats }) {
	const { testRun, bootless: testBootless } = findTestRun(k, boot, runs);
	const { gateRun, bootless: gateBootless } = findGateRun(k, boot, seats);
	const bootless = [...testBootless, ...gateBootless];
	if (testRun !== null)
		return { kill: { ...k, kind: "test run", testRun, gateRun }, bootless };
	if (gateRun !== null)
		return { kill: { ...k, kind: "gate run", gateRun }, bootless };
	return { kill: k, bootless };
}

/**
 * @param {Incident[]} incidents
 * @returns {Incident[]}
 */
function joinRuns(incidents) {
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
	const testRuns = readRunFiles();
	const gateSeats = readGatePids();
	return incidents.map((i) => {
		/** @type {string[]} */
		const bootless = [];
		/** @type {string[]} */
		const bootlessRuns = [];
		const kills = i.kills.map((k) => {
			const at = Date.parse(k.at);
			const boot = boots.find((b) => b.from <= at && at <= b.to);
			const onPid = runs.filter(
				(r) => r.pid === k.pid && toSecond(r.launchedAt) <= at,
			);
			for (const r of onPid) if (r.bootId === null) bootless.push(r.jobId);
			const run = latestInBoot(
				onPid.map((r) => ({ ...r, started: r.launchedAt })),
				boot,
			);
			if (run !== null)
				return {
					...k,
					kind: /** @type {Kind} */ ("headless run"),
					jobId: run.jobId,
				};
			const joined = joinRecordedRun(k, boot, {
				runs: testRuns.runs,
				seats: gateSeats.seats,
			});
			bootlessRuns.push(...joined.bootless);
			return joined.kill;
		});
		const unjoined = [
			...bootlessNote(
				bootless.length === 0
					? []
					: [
							`headless ${bootless.length === 1 ? "run" : "runs"} ${bootless.join(", ")}`,
						],
			),
			...bootlessNote(bootlessRuns),
			...(testRuns.why === null ? [] : [testRuns.why]),
			...(gateSeats.why === null || gateSeats.why === testRuns.why
				? []
				: [gateSeats.why]),
		];
		return {
			...i,
			kills,
			unjoined: unjoined.length === 0 ? null : unjoined.join("; "),
		};
	});
}

/**
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
		if (head && Date.parse(head.first) - start < INCIDENT_GAP_MS) {
			start = Date.parse(head.first) - INCIDENT_GAP_MS;
			continue;
		}
		return {
			incidents: joinRuns(all.filter((i) => Date.parse(i.last) > sinceMs)),
			why: null,
		};
	}
}

/** @param {Date} d */
const localTime = (d) =>
	[d.getHours(), d.getMinutes(), d.getSeconds()]
		.map((v) => String(v).padStart(2, "0"))
		.join(":");

const TITLE_PREFIX = "Memory kill incident from ";

const incidentTitle = (/** @type {Incident} */ i) =>
	`${TITLE_PREFIX}${utcMinute(new Date(i.first))} UTC`;

/** @param {number|null} v */
const mib = (v) => (v === null ? "unread" : `${v} MiB`);

/**
 * @param {Kill[]} kills
 * @returns {string}
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

/** @param {TestRun} t */
const filesOf = (t) => {
	if (t.fileCount === 0)
		return t.argv.length === 0 ? "no files" : `argv \`${t.argv.join(" ")}\``;
	if (t.fileCount > t.files.length) return `${t.fileCount} files`;
	return t.files.map((f) => `\`${f}\``).join(", ");
};

/** @param {TestRun} t */
const testRunCell = (t) => {
	const files = filesOf(t);
	const by = t.session === null ? "" : ` by \`${shortJobId(t.session)}\``;
	return `${t.role} of a ${t.kind} run${by} in ${t.repo}: ${files}`;
};

/** @param {GateRun} g */
const gateRunCell = (g) => {
	const by = g.session === null ? "" : ` by \`${shortJobId(g.session)}\``;
	return `\`${g.command}\`${by} in ${g.repo ?? "an unnamed repo"}`;
};

/** @param {Kill} k */
const kindCell = (k) => {
	if (k.testRun !== null)
		return `${k.kind}: ${testRunCell(k.testRun)}${k.gateRun === null ? "" : `, under gate run ${gateRunCell(k.gateRun)}`}`;
	if (k.gateRun !== null) return `${k.kind}: ${gateRunCell(k.gateRun)}`;
	return k.jobId === null ? k.kind : `${k.kind} \`${k.jobId}\``;
};

/**
 * @typedef {{ trip: { at: string, pid: number }|null,
 *   rearm: { status: string, arm: string } }} TripwireNote
 */

/**
 * @param {Incident} i
 * @param {TripwireNote["trip"]} trip
 */
const isTrippedBy = (i, trip) =>
	trip !== null && i.kills.some((k) => k.pid === trip.pid && k.at === trip.at);

/**
 * @param {Incident} i
 * @param {TripwireNote} [tripwire]
 */
function buildIncidentBody(i, tripwire) {
	const rearm =
		tripwire !== undefined && isTrippedBy(i, tripwire.trip)
			? tripwire.rearm
			: null;
	const first = new Date(i.first);
	const last = new Date(i.last);
	const lowest = i.kills.reduce(
		(lo, k) =>
			k.availMiB !== null && (lo === null || k.availMiB < lo.availMiB)
				? /** @type {Kill & {availMiB: number}} */ (k)
				: lo,
		/** @type {(Kill & {availMiB: number})|null} */ (null),
	);
	const from = Math.floor(first.getTime() / 1000) - 600;
	const to = Math.floor(last.getTime() / 1000) + 60;
	return `## What happened

earlyoom killed ${i.kills.length} ${i.kills.length === 1 ? "process" : "processes"} between ${localMinute(first)} and ${localMinute(last)} machine time, one incident: kills no more than ${INCIDENT_GAP_MS / 60_000} min apart (workflow-core#3094).

By kind: ${byKind(i.kills)}. A headless run is a \`claude -p\` in the headless run store; a test run is a test launch's wrapper, main process or worker, matched by pid to its memory record (\`.test-run-memory\`); a gate run is any other process in a commit gate's tree, matched by pid to its gate seat's record; claude CLI is the daemon, \`claude agents\` or a \`-p\` the store has none for; a node or python process is any such program, the refill loop and test workers included; Chromium is a browser process (\`headless_shell\`, \`chrome\`, \`chromium\`) no record claims.${i.unjoined === null ? "" : `\n\nNot joined to the headless, test or gate runs, so a kill named by its process may be one: ${i.unjoined}.`}

${rearm === null ? "" : `**This incident tripped the peak tripwire** (workflow-core#5367): its test-run kill came while a part-suite admitted on its own measured peak was live, so every part-suite is judged on the ladder until a session re-arms it. Read the kill with \`${rearm.status}\`, then re-arm with \`${rearm.arm}\` once its cause is understood.\n\n`}Lowest MemAvailable before a kill: ${lowest === null ? "unread" : `${lowest.availMiB} MiB, SwapFree ${mib(lowest.swapFreeMiB)}`}.

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
${rearm === null ? "" : `- [ ] The peak tripwire is re-armed (\`${rearm.arm}\`), or left tripped with the reason on this ticket.\n`}`;
}

/**
 * @param {string} repo
 * @param {Parameters<typeof readTicketsByPrefix>[3]} [run]
 * @returns {Map<string, number>}
 */
function readIncidentTickets(repo, run) {
	return readTicketsByPrefix(repo, "memory kill tickets", TITLE_PREFIX, run);
}

module.exports = {
	buildIncidentBody,
	byKind,
	incidentTitle,
	isOver,
	readIncidentTickets,
	readIncidents,
};
