#!/usr/bin/env node
// #5857

const { spawnSync } = require("node:child_process");
const path = require("node:path");
const { listedSessionIds } = require("./lib/agent-liveness.js");
const {
	listIssueClaims,
	releaseIssue,
} = require("./lib/arbiter-issue-claims.js");
const { caught, orFallback } = require("./lib/caught.js");
const { CHILD_MAX_BUFFER } = require("./lib/child-buffer.js");
const { now: clockNow } = require("./lib/clock.js");
const { parseOrExit } = require("./lib/cli-args.js");
const { readHistory } = require("./lib/gate-projection.js");
const { recordJudged, runCheckGates } = require("./lib/gate-sweep.js");
const { gh, ghApiSlurp, ghJson } = require("./lib/gh.js");
const { hostRoot } = require("./lib/host-root.js");
const { asObject, stringMembers } = require("./lib/json-shape.js");
const { gateRefsOf } = require("./lib/issue-gate.js");
const { refKey } = require("./lib/issue-ref.js");
const { readLinksMany } = require("./lib/link-batch.js");
const { ORIGIN_LABELS, originLabel } = require("./lib/issue-origin.js");
const { readParkMarkers } = require("./lib/parked.js");
const { findPin, isCoreHost, readJsonSafe } = require("./lib/plugin-state.js");
const { readShortlist } = require("./lib/refill-frontier.js");
const { readControlChecked, loopFiles } = require("./lib/refill-files.js");
const { scopeRoots } = require("./lib/refill-loop.js");
const {
	buildCheckoutEnv,
	homeDir,
	readAdopterCheckouts,
	readExclusionWhy,
} = require("./lib/refill-repos.js");
const { labelPin } = require("./lib/release-lag.js");
const { scriptPath } = require("./lib/script-path.js");
const plan = require("./lib/stale-run-plan.js");
const record = require("./lib/stale-run-record.js");
const { DAY_MS } = record;
const { fileOrRefresh, refresh } = require("./lib/tracking-issue.js");
const { WATCH_CLOSED_LABEL } = require("./lib/watch-label.js");
const { loops } = require("./lib/wait-graph.js");
const { readConfig, resolveKey } = require("./lib/workflow-core-config.js");
const { writeFd } = require("./lib/write-fd.js");

const USAGE = `usage: node ${scriptPath("stale-ticket-run.js")} [--dry-run]`;
const PLUGIN = "workflow-core";
const BUMP_TITLE = "Bump workflow-core to ";
// guess, #5857
const CHECK_TIMEOUT_MS = 10 * 60 * 1000;
const FINDING_CHECKS = [
	"check-issue-labels.js",
	"check-open-maps.js",
	"check-issue-orphans.js",
];

/** @typedef {import("./lib/stale-run-plan.js").SnapRepo} SnapRepo */
/** @typedef {import("./lib/stale-run-plan.js").SnapIssue} SnapIssue */
/** @typedef {import("./lib/stale-run-plan.js").Act} Act */

/**
 * @param {string} script
 */
const childScript = (script) =>
	path.join(process.env.WFC_STALE_RUN_CHILDREN || __dirname, script);

/** @param {string} line */
const say = (line) => writeFd(1, `${line}\n`);
/** @param {string} line */
const warn = (line) => writeFd(2, `${line}\n`);

/**
 * @param {string} script
 * @param {string[]} args
 * @param {string} root
 * @returns {Record<string, unknown>|null}
 */
function runJson(script, args, root) {
	const r = spawnSync(process.execPath, [childScript(script), ...args], {
		cwd: root,
		env: buildCheckoutEnv(root),
		encoding: "utf8",
		maxBuffer: CHILD_MAX_BUFFER,
		timeout: CHECK_TIMEOUT_MS,
	});
	const out = asObject(orFallback(() => JSON.parse(r.stdout), null));
	if (out === null)
		warn(
			`${script} in ${root}: no --json envelope (exit ${r.status ?? r.signal})`,
		);
	return out;
}

/**
 * @template T
 * @param {string} what
 * @param {unknown[]} raw
 * @param {(row: unknown) => T[]} narrow
 * @returns {T[]}
 */
function narrowRows(what, raw, narrow) {
	const rows = raw.flatMap(narrow);
	if (rows.length < raw.length)
		warn(`${what}: ${raw.length - rows.length} malformed row(s) dropped`);
	return rows;
}

/** @param {string} script @param {Record<string, unknown>|null} envelope @returns {{tag: string, number: number}[]} */
const findingsOf = (script, envelope) =>
	narrowRows(
		`${script} findings`,
		Array.isArray(envelope?.findings) ? envelope.findings : [],
		(raw) => {
			const f = asObject(raw);
			return typeof f?.tag === "string" && typeof f.number === "number"
				? [{ tag: f.tag, number: f.number }]
				: [];
		},
	);

/** @param {string} root @returns {{tracker: string|null, fault: string|null}} */
function readTracker(root) {
	try {
		const fault = readConfig({ root, quiet: true }).faults[0];
		if (fault) return { tracker: null, fault: fault.text };
		const tracker = resolveKey("tracker", { root });
		return typeof tracker === "string" && tracker
			? { tracker, fault: null }
			: { tracker: null, fault: "no tracker resolves" };
	} catch (e) {
		return { tracker: null, fault: caught(e).message };
	}
}

/**
 * @typedef {{number: number, title: string, labels?: (string|{name: string})[],
 *   body?: string|null, created_at: string, updated_at?: string,
 *   assignees?: {login: string}[], parent_issue_url?: string|null,
 *   pull_request?: unknown}} RestIssue
 */

/** @param {string|null|undefined} url @returns {{repo: string, number: number}|null} */
function parentOf(url) {
	const m = /repos\/([^/]+\/[^/]+)\/issues\/(\d+)$/.exec(url ?? "");
	return m ? { repo: String(m[1]), number: Number(m[2]) } : null;
}

/** @param {RestIssue} raw @returns {SnapIssue} */
const issueOf = (raw) => ({
	number: raw.number,
	title: raw.title,
	labels: (raw.labels ?? []).map((l) => (typeof l === "string" ? l : l.name)),
	body: raw.body ?? "",
	createdAt: raw.created_at,
	updatedAt: raw.updated_at,
	assignees: (raw.assignees ?? []).map((a) => a.login),
	parent: parentOf(raw.parent_issue_url),
	blockedBy: [],
	subIssues: [],
	timeline: [],
});

/** @param {string[]} api @param {string} root @returns {SnapIssue[]} */
const readIssues = (api, root) =>
	/** @type {RestIssue[]} */ (ghApiSlurp(api, { cwd: root }))
		.filter((i) => !i.pull_request)
		.map(issueOf);

/**
 * @param {string} tracker
 * @param {SnapIssue[]} issues
 * @returns {Promise<Map<number, Pick<SnapIssue, "blockedBy" | "subIssues">>>}
 */
async function readEdges(tracker, issues) {
	const reads = await readLinksMany(tracker, issues, {
		want: ["blockedBy", "subIssues"],
	});
	/** @param {import("./lib/link-batch.js").LinkRow} l */
	const edge = (l) => ({
		repo: l.repo,
		number: l.number,
		state: String(l.state).toLowerCase(),
	});
	return new Map(
		reads.flatMap(({ item, read }) =>
			read.ok
				? [
						[
							item.number,
							{
								blockedBy: (read.links.blockedBy ?? []).map(edge),
								subIssues: (read.links.subIssues ?? []).map(edge),
							},
						],
					]
				: [],
		),
	);
}

/**
 * @param {string} tracker
 * @param {SnapIssue[]} issues
 * @param {number} now
 * @returns {Map<number, import("./lib/stale-run-plan.js").TimelineRow[]>}
 */
function readTimelines(tracker, issues, now) {
	return new Map(
		issues.flatMap((iss) => {
			if (now - Date.parse(iss.createdAt) <= plan.FLOOR_DAYS * DAY_MS)
				return [];
			try {
				const rows =
					/** @type {import("./lib/stale-run-plan.js").TimelineRow[]} */ (
						ghApiSlurp([
							`repos/${tracker}/issues/${iss.number}/timeline?per_page=100`,
						])
					);
				return [
					[
						iss.number,
						rows.map((e) => ({
							event: e.event,
							created_at: e.created_at,
							body: e.body,
							label: e.label,
						})),
					],
				];
			} catch (e) {
				warn(
					`${tracker}#${iss.number}: timeline unread (${caught(e).message})`,
				);
				return [];
			}
		}),
	);
}

/** @param {string} tracker @param {SnapIssue[]} issues @returns {string[]} */
function readClosedRefs(tracker, issues) {
	const open = new Set(
		issues.map((i) => refKey({ repo: tracker, number: i.number })),
	);
	const refs = new Map(
		issues
			.flatMap((i) => [
				...gateRefsOf(i.body, tracker),
				...(i.parent ? [i.parent] : []),
			])
			.map((r) => [refKey(r), r]),
	);
	return [...refs].flatMap(([k, r]) => {
		if (open.has(k)) return [];
		try {
			const state = gh([
				"api",
				`repos/${r.repo}/issues/${r.number}`,
				"--jq",
				".state",
			]).trim();
			return state === "closed" ? [k] : [];
		} catch (e) {
			warn(
				`${k}: state unread, so neither a gate on it is stripped nor a child under it listed (${caught(e).message})`,
			);
			return [];
		}
	});
}

/** @param {string} tracker @param {SnapIssue[]} issues */
async function readCycles(tracker, issues) {
	const seeds = issues
		.filter(
			(i) =>
				i.blockedBy.some((b) => b.state === "open") ||
				gateRefsOf(i.body, tracker).length > 0,
		)
		.map((i) => ({ repo: tracker, number: i.number }));
	if (seeds.length === 0) return [];
	try {
		const { cycles } = await loops(seeds, { home: tracker });
		return cycles.map((c) => ({ members: c.members }));
	} catch (e) {
		warn(`${tracker}: wait graph unread (${caught(e).message})`);
		return [];
	}
}

/**
 * @param {string} tracker
 * @param {number} number
 * @param {unknown} command
 */
function readGateHistory(tracker, number, command) {
	try {
		return readHistory({
			repo: tracker,
			issue: number,
			command: typeof command === "string" ? command : null,
		});
	} catch (e) {
		warn(`${tracker}#${number}: gate history unread (${caught(e).message})`);
		return [];
	}
}

/**
 * @param {string} root
 * @param {string} tracker
 * @param {{stdout: string} | {error: string}} run
 * @returns {import("./lib/stale-run-plan.js").GateRow[]}
 */
function readGateRows(root, tracker, run) {
	const rows =
		"error" in run
			? undefined
			: orFallback(() => asObject(JSON.parse(run.stdout))?.rows, undefined);
	if (Array.isArray(rows))
		return narrowRows("check-gates.js rows", rows, (raw) => {
			const g = asObject(raw);
			return g &&
				typeof g.number === "number" &&
				typeof g.state === "string" &&
				typeof g.reading === "string"
				? [
						{
							number: g.number,
							state: g.state,
							reading: g.reading,
							closed: g.closed === true,
							detail: typeof g.detail === "string" ? g.detail : null,
							history: readGateHistory(tracker, g.number, g.command),
						},
					]
				: [];
		});
	warn(
		`check-gates.js in ${root}: no rows read, so no gate is judged (${"error" in run ? run.error : "no --json rows"})`,
	);
	return [];
}

/** @param {string} root @returns {string|null} */
function readPin(root) {
	if (isCoreHost(root)) return null;
	const settings = asObject(
		readJsonSafe(path.join(root, ".claude", "settings.json")),
	);
	return labelPin(findPin(settings ?? {}, PLUGIN));
}

/**
 * @param {string} root
 * @param {{served: Set<string>, now: number}} at
 * @returns {Promise<SnapRepo>}
 */
async function gatherRepo(root, { served, now }) {
	const { tracker, fault } = readTracker(root);
	/** @type {SnapRepo} */
	const base = {
		root,
		tracker,
		fault,
		served: served.has(root),
		pin: null,
		bumps: [],
		frontier: [],
		issues: [],
		gates: [],
		checkFindings: [],
		containerRetags: [],
		staleClaims: [],
		claims: [],
		parkMarkers: [],
		closedRefs: [],
		watched: [],
		cycles: [],
	};
	if (tracker === null) return base;
	try {
		return { ...base, ...(await gatherTracked(root, tracker, now)) };
	} catch (e) {
		return { ...base, fault: `tracker unread: ${caught(e).message}` };
	}
}

/** @param {string} root @param {string} tracker @param {number} now */
async function gatherTracked(root, tracker, now) {
	const listed = readIssues(
		[`repos/${tracker}/issues?state=open&per_page=100`],
		root,
	);
	const edges = await readEdges(tracker, listed);
	const timelines = readTimelines(tracker, listed, now);
	const issues = listed.map((i) => ({
		...i,
		...edges.get(i.number),
		timeline: timelines.get(i.number) ?? [],
	}));
	const shortlist = await readShortlist(
		root,
		null,
		childScript("pick-next.js"),
	);
	const env = buildCheckoutEnv(root);
	const gateRun = await runCheckGates(root, {
		env,
		script: childScript("check-gates.js"),
	});
	const containers = runJson(
		"retire-stale-containers.js",
		["--dry-run", "--json"],
		root,
	);
	const claims = runJson("check-stale-claims.js", ["--json"], root);
	const store = listIssueClaims(root);
	return {
		pin: readPin(root),
		bumps: issues
			.filter((i) => i.title.startsWith(BUMP_TITLE))
			.map((i) => ({ number: i.number, assigned: i.assignees.length > 0 })),
		frontier:
			"error" in shortlist ? shortlist : shortlist.rows.map((r) => r.number),
		issues,
		watched: readIssues(
			[
				`repos/${tracker}/issues?state=closed&labels=${WATCH_CLOSED_LABEL}&per_page=100`,
			],
			root,
		),
		gates: readGateRows(root, tracker, gateRun),
		checkFindings: FINDING_CHECKS.flatMap((script) =>
			findingsOf(script, runJson(script, ["--json"], root)),
		),
		containerRetags: narrowRows(
			"retire-stale-containers.js stale",
			Array.isArray(containers?.stale) ? containers.stale : [],
			(n) => (typeof n === "number" ? [n] : []),
		),
		staleClaims: narrowRows(
			"check-stale-claims.js stale",
			Array.isArray(claims?.stale) ? claims.stale : [],
			(raw) => {
				const c = asObject(raw);
				return typeof c?.number === "number" && typeof c.ageDays === "number"
					? [
							{
								number: c.number,
								ageDays: c.ageDays,
								assignees: stringMembers(c.assignees),
							},
						]
					: [];
			},
		),
		claims: store && !store.why ? store.claims : null,
		parkMarkers: readParkMarkers(root).map((m) => ({
			sessionId: m.sessionId,
			issues: m.issues,
			...(m.cause ? { cause: m.cause } : {}),
		})),
		closedRefs: readClosedRefs(tracker, issues),
		cycles: await readCycles(tracker, issues),
	};
}

/** @returns {Set<string>} */
function readServed() {
	const control = readControlChecked(warn).control;
	return new Set(
		control ? scopeRoots(control.scope, readExclusionWhy).roots : [],
	);
}

/** @param {string} coreRoot */
function readLatestRelease(coreRoot) {
	try {
		const { readReleaseTags } = require("./lib/release-tags.js");
		return readReleaseTags(coreRoot).at(-1) ?? null;
	} catch (e) {
		warn(`release tags unread, so no pin reads behind (${caught(e).message})`);
		return null;
	}
}

/** @param {number|null} n @param {string} tracker */
function readHub(n, tracker) {
	if (n === null) return null;
	try {
		const { state } = ghJson([
			"issue",
			"view",
			String(n),
			"--repo",
			tracker,
			"--json",
			"state",
		]);
		return {
			number: n,
			state: /** @type {"open"|"closed"} */ (String(state).toLowerCase()),
		};
	} catch (e) {
		warn(
			`${tracker}#${n}: hub state unread, so no close disposes its keys (${caught(e).message})`,
		);
		return null;
	}
}

/**
 * @param {{home: string, coreRoot: string, now: Date}} at
 * @returns {Promise<import("./lib/stale-run-plan.js").Snapshot>}
 */
async function gather({ home, coreRoot, now }) {
	const coreTracker = readTracker(coreRoot).tracker;
	if (coreTracker === null)
		throw new Error(`no tracker resolves for ${coreRoot}`);
	const previous = record.readNewestRow(record.recordPath());
	const served = readServed();
	const live = listedSessionIds();
	const repos = [];
	for (const root of readAdopterCheckouts(home).included)
		repos.push(await gatherRepo(root, { served, now: now.getTime() }));
	return {
		now: now.toISOString(),
		coreTracker,
		latestRelease: readLatestRelease(coreRoot),
		liveSessions: live.ids ? [...live.ids] : null,
		previous,
		hub: readHub(previous?.hub.number ?? null, coreTracker),
		repos,
	};
}

/**
 * @param {string} repo
 * @param {number} n
 * @param {string} was
 * @param {string} body
 */
function replaceBody(repo, n, was, body) {
	const live = asObject(
		ghJson(["issue", "view", String(n), "--repo", repo, "--json", "body"]),
	)?.body;
	if (!plan.bodyUnchanged(typeof live === "string" ? live : "", was))
		return false;
	refresh(n, body, { repo });
	return true;
}

/** @param {string} repo @param {number} n @param {string[]} args */
const issue = (repo, n, args) =>
	gh([
		"issue",
		...args.slice(0, 1),
		String(n),
		"--repo",
		repo,
		...args.slice(1),
	]);

/** @type {{[K in Act["kind"]]: (a: Extract<Act, {kind: K}>) => boolean|void}} */
const APPLY = {
	discharge(a) {
		for (const step of plan.reopenSteps(a)) issue(a.repo, a.number, step);
		const stripped = replaceBody(a.repo, a.number, a.wasBody, a.body);
		recordJudged(
			loopFiles().gates,
			{ root: a.root, number: a.number, seen: a.seen, now: clockNow() },
			warn,
		);
		return stripped;
	},
	unblock(a) {
		const id = gh([
			"api",
			`repos/${a.blocker.repo}/issues/${a.blocker.number}`,
			"--jq",
			".id",
		]).trim();
		gh([
			"api",
			"-X",
			"DELETE",
			`repos/${a.repo}/issues/${a.number}/dependencies/blocked_by/${id}`,
		]);
	},
	"strip-gate"(a) {
		return replaceBody(a.repo, a.number, a.wasBody, a.body);
	},
	release(a) {
		issue(a.repo, a.number, [
			"edit",
			...a.assignees.flatMap((l) => ["--remove-assignee", l]),
		]);
		const r = releaseIssue(a.number, { sessionId: a.sessionId }, a.root);
		if (r.status === "failed")
			throw new Error(`arbiter claim not released: ${caught(r.error).message}`);
	},
	retag(a) {
		runJson("retire-stale-containers.js", ["--json"], a.root);
	},
};

/** @param {Act} a @returns {{done: string} | {failed: string}} */
function applyAct(a) {
	try {
		const stripped = /** @type {(a: Act) => boolean|void} */ (APPLY[a.kind])(a);
		const note = plan.actComment(a, { stripped: stripped === true });
		if (note) issue(a.repo, note.number, ["comment", "--body", note.text]);
		return { done: plan.actText(a) };
	} catch (e) {
		const text = `${plan.actText(a)} — failed: ${caught(e).message}`;
		warn(text);
		return { failed: text };
	}
}

const ORIGIN = originLabel("stale-run");

/** @param {string} repo */
function ensureOriginLabel(repo) {
	const label = ORIGIN_LABELS.find((l) => l.name === ORIGIN);
	if (!label) throw new Error(`${ORIGIN} is not in the origin label plan`);
	gh([
		"label",
		"create",
		label.name,
		"--repo",
		repo,
		"--color",
		label.color,
		"--description",
		label.description,
		"--force",
	]);
}

/**
 * @param {Set<string>} labelled
 * @param {{title: string, body: string, repo: string}} f
 */
function file(labelled, { title, body, repo }) {
	if (!labelled.has(repo)) {
		ensureOriginLabel(repo);
		labelled.add(repo);
	}
	return fileOrRefresh({
		title,
		labels: [ORIGIN],
		takes: plan.HUB_TAKES,
		body,
		repo,
	});
}

/**
 * @param {import("./lib/stale-run-plan.js").Plan} p
 * @param {string} coreTracker
 * @param {Set<string>} labelled
 * @param {{done: string[], failed: string[]}} acts
 * @returns {number|null}
 */
function applyHub(p, coreTracker, labelled, acts) {
	if (p.hub.action === "close") issue(coreTracker, p.hub.number, ["close"]);
	if (p.hub.action !== "refresh") return null;
	const { number, text } = file(labelled, {
		title: plan.HUB_TITLE,
		body: plan.buildHubBody(p.hub.parts, acts),
		repo: coreTracker,
	});
	say(text);
	return number;
}

/**
 * @param {import("./lib/stale-run-plan.js").Plan} p
 * @param {import("./lib/stale-run-plan.js").Snapshot} snap
 */
function apply(p, snap) {
	const outcomes = p.acts.map(applyAct);
	const acts = {
		done: outcomes.flatMap((o) => ("done" in o ? [o.done] : [])),
		failed: outcomes.flatMap((o) => ("failed" in o ? [o.failed] : [])),
	};
	/** @type {Set<string>} */
	const labelled = new Set();
	const filings = p.filings.flatMap((f) => {
		try {
			return [
				`${f.title}: ${file(labelled, { title: f.title, body: f.body, repo: f.tracker }).text}`,
			];
		} catch (e) {
			warn(`${f.title} — not filed: ${caught(e).message}`);
			return [];
		}
	});
	const hub = plan.hubAfter(p.hub, {
		filed: applyHub(p, snap.coreTracker, labelled, acts),
		before: snap.hub?.state === "open" ? snap.hub.number : null,
	});
	return { acts: acts.done, filings, hub };
}

/** @param {import("./lib/stale-run-plan.js").Plan} p */
function printPlan(p) {
	for (const l of p.repoLines) say(l);
	for (const l of p.lines) say(`${l.cls}  ${l.text}`);
	for (const o of p.owed) say(`owed  ${o.text}`);
	for (const a of p.acts) say(`would: ${plan.actText(a)}`);
	for (const f of p.filings) say(`would file or refresh: ${f.title}`);
	say(`hub: ${p.hub.action}`);
}

/** @param {{dryRun: boolean}} opts @returns {Promise<number>} */
async function runStaleTicket({ dryRun }) {
	const coreRoot = hostRoot();
	const snap = await gather({
		home: homeDir(),
		coreRoot,
		now: new Date(clockNow()),
	});
	const p = plan.planStaleRun(snap);
	printPlan(p);
	if (dryRun) {
		say("--dry-run: nothing written.");
		return 0;
	}
	record.appendRow(
		record.recordPath(),
		plan.buildRunRow(p, snap, apply(p, snap)),
	);
	return 0;
}

/** @param {string[]} argv @returns {Promise<number>} */
async function main(argv = process.argv.slice(2)) {
	const { flags } = parseOrExit(argv, {
		usage: USAGE,
		flags: { "--dry-run": "boolean" },
	});
	return runStaleTicket({ dryRun: flags["--dry-run"] === true }).catch(failed);
}

/** @param {unknown} e */
function failed(e) {
	warn(`stale-ticket run: ${caught(e).message}`);
	return 1;
}

module.exports = { main };

if (require.main === module)
	main().then(
		(code) => {
			process.exitCode = code;
		},
		(e) => {
			process.exitCode = failed(e);
		},
	);
