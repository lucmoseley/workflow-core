#!/usr/bin/env node

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { listedSessionIds } = require("./lib/agent-liveness.js");
const { listIssueClaims } = require("./lib/arbiter-issue-claims.js");
const core = require("./lib/arbiter-core.js");
const { caught } = require("./lib/caught.js");
const { CHILD_MAX_BUFFER } = require("./lib/child-buffer.js");
const { parseOrExit } = require("./lib/cli-args.js");
const { recordJudged, runCheckGates } = require("./lib/gate-sweep.js");
const { gh, ghApiSlurp, ghJson } = require("./lib/gh.js");
const { hostRoot } = require("./lib/host-root.js");
const { gateRefsOf } = require("./lib/issue-gate.js");
const { refKey } = require("./lib/issue-ref.js");
const { readLinksMany } = require("./lib/link-batch.js");
const { originLabel } = require("./lib/issue-origin.js");
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
const { fileOrRefresh, refresh } = require("./lib/tracking-issue.js");
const { WATCH_CLOSED_LABEL } = require("./lib/watch-label.js");
const { loops } = require("./lib/wait-graph.js");
const { readConfig, resolveKey } = require("./lib/workflow-core-config.js");
const { writeFd } = require("./lib/write-fd.js");

const USAGE = `usage: node ${scriptPath("stale-ticket-run.js")} [--dry-run]`;
const PLUGIN = "workflow-core";
const BUMP_TITLE = "Bump workflow-core to ";
const DAY_MS = 24 * 60 * 60 * 1000;
// guess, #5857
const CHECK_TIMEOUT_MS = 10 * 60 * 1000;

/** @typedef {import("./lib/stale-run-plan.js").SnapRepo} SnapRepo */
/** @typedef {import("./lib/stale-run-plan.js").SnapIssue} SnapIssue */
/** @typedef {import("./lib/stale-run-plan.js").Act} Act */

/** @param {string} line */
const say = (line) => writeFd(1, `${line}\n`);
/** @param {string} line */
const warn = (line) => writeFd(2, `${line}\n`);

/**
 * @param {string} script
 * @param {string[]} args
 * @param {string} root
 * @returns {any}
 */
function runJson(script, args, root) {
	const r = spawnSync(
		process.execPath,
		[path.join(__dirname, script), ...args],
		{
			cwd: root,
			env: buildCheckoutEnv(root),
			encoding: "utf8",
			maxBuffer: CHILD_MAX_BUFFER,
			timeout: CHECK_TIMEOUT_MS,
		},
	);
	try {
		return JSON.parse(r.stdout);
	} catch {
		warn(
			`${script} in ${root}: no --json envelope (exit ${r.status ?? r.signal})`,
		);
		return null;
	}
}

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

/** @param {any} raw @returns {SnapIssue} */
const issueOf = (raw) => ({
	number: raw.number,
	title: raw.title,
	labels: (raw.labels ?? []).map((/** @type {any} */ l) =>
		typeof l === "string" ? l : l.name,
	),
	body: raw.body ?? "",
	createdAt: raw.created_at,
	updatedAt: raw.updated_at,
	assignees: (raw.assignees ?? []).map((/** @type {any} */ a) => a.login),
	blockedBy: [],
	subIssues: [],
	timeline: [],
});

/** @param {string} tracker @param {string} root @returns {SnapIssue[]} */
function readOpenIssues(tracker, root) {
	return ghApiSlurp([`repos/${tracker}/issues?state=open&per_page=100`], {
		cwd: root,
	})
		.filter((i) => !i.pull_request)
		.map(issueOf);
}

/** @param {string} tracker @param {SnapIssue[]} issues */
async function readEdges(tracker, issues) {
	const reads = await readLinksMany(tracker, issues, {
		want: ["blockedBy", "subIssues"],
	});
	for (const { item, read } of reads) {
		if (!read.ok) continue;
		/** @param {import("./lib/link-batch.js").LinkRow} l */
		const edge = (l) => ({
			repo: l.repo,
			number: l.number,
			state: String(l.state).toLowerCase(),
		});
		item.blockedBy = (read.links.blockedBy ?? []).map(edge);
		item.subIssues = (read.links.subIssues ?? []).map(edge);
	}
}

/** @param {string} tracker @param {SnapIssue[]} issues @param {number} now */
function readTimelines(tracker, issues, now) {
	for (const iss of issues) {
		if (now - Date.parse(iss.createdAt) <= plan.FLOOR_DAYS * DAY_MS) continue;
		try {
			iss.timeline = ghApiSlurp([
				`repos/${tracker}/issues/${iss.number}/timeline?per_page=100`,
			]).map((e) => ({
				event: e.event,
				created_at: e.created_at,
				body: e.body,
				label: e.label,
			}));
		} catch (e) {
			warn(`${tracker}#${iss.number}: timeline unread (${caught(e).message})`);
		}
	}
}

/** @param {string} tracker @param {SnapIssue[]} issues @returns {string[]} */
function readClosedRefs(tracker, issues) {
	const open = new Set(
		issues.map((i) => refKey({ repo: tracker, number: i.number })),
	);
	const refs = new Map(
		issues
			.flatMap((i) => gateRefsOf(i.body, tracker))
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
		} catch {
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

/** @param {string} stdout @returns {any[]} */
function readGateRows(stdout) {
	try {
		const rows = JSON.parse(stdout).rows;
		return Array.isArray(rows) ? rows : [];
	} catch {
		return [];
	}
}

/** @param {string} root @returns {string|null} */
function readPin(root) {
	if (isCoreHost(root)) return null;
	const settings = readJsonSafe(path.join(root, ".claude", "settings.json"));
	return labelPin(findPin(/** @type {any} */ (settings), PLUGIN));
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
		labelFindings: [],
		containerRetags: [],
		staleClaims: [],
		claims: [],
		parkMarkers: [],
		closedRefs: [],
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
	const issues = readOpenIssues(tracker, root);
	await readEdges(tracker, issues);
	readTimelines(tracker, issues, now);
	const shortlist = await readShortlist(root, null);
	const env = buildCheckoutEnv(root);
	const gateRun = await runCheckGates(root, { env });
	const labels = runJson("check-issue-labels.js", ["--json"], root);
	const containers = runJson(
		"retire-stale-containers.js",
		["--dry-run", "--json"],
		root,
	);
	const claims = runJson("check-stale-claims.js", ["--json"], root);
	const listed = listIssueClaims(root);
	return {
		pin: readPin(root),
		bumps: issues
			.filter((i) => i.title.startsWith(BUMP_TITLE))
			.map((i) => ({ number: i.number, assigned: i.assignees.length > 0 })),
		frontier:
			"error" in shortlist ? shortlist : shortlist.rows.map((r) => r.number),
		issues,
		gates: "error" in gateRun ? [] : readGateRows(gateRun.stdout),
		labelFindings: (labels?.findings ?? []).flatMap((/** @type {any} */ f) =>
			typeof f.data?.number === "number"
				? [{ tag: f.tag, number: f.data.number }]
				: [],
		),
		containerRetags: containers?.stale ?? [],
		staleClaims: (claims?.stale ?? []).map((/** @type {any} */ c) => ({
			number: c.number,
			ageDays: c.ageDays,
			assignees: c.assignees,
		})),
		claims: listed && !listed.why ? listed.claims : null,
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
	const control = readControlChecked(() => undefined).control;
	return new Set(
		control ? scopeRoots(control.scope, readExclusionWhy).roots : [],
	);
}

/** @param {string} coreRoot */
function readLatestRelease(coreRoot) {
	try {
		const { readReleaseTags } = require("./lib/release-tags.js");
		return readReleaseTags(coreRoot).at(-1) ?? null;
	} catch {
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
	} catch {
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
	const now =
		ghJson(["issue", "view", String(n), "--repo", repo, "--json", "body"])
			.body ?? "";
	if (now.trim() !== was.trim()) return false;
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

/** @param {string} repo @param {number} n @param {string} text */
const comment = (repo, n, text) => issue(repo, n, ["comment", "--body", text]);

const KEPT =
	"The issue's body changed after this run read it, so the marker is left for a session to strip.";

/** @type {{[K in Act["kind"]]: (a: Extract<Act, {kind: K}>) => void}} */
const APPLY = {
	discharge(a) {
		if (a.closed) {
			issue(a.repo, a.number, ["reopen"]);
			issue(a.repo, a.number, ["edit", "--remove-label", WATCH_CLOSED_LABEL]);
		}
		const stripped = replaceBody(a.repo, a.number, a.wasBody, a.body);
		comment(
			a.repo,
			a.number,
			`Discharged by the daily stale-ticket run: the gate's \`check:\` reads met — \`${a.reading}\`. ${stripped ? "The `**Gated on:**` marker is stripped." : KEPT}`,
		);
		recordJudged(
			loopFiles().gates,
			{ root: a.root, number: a.number, seen: a.seen, now: Date.now() },
			warn,
		);
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
		comment(
			a.repo,
			a.number,
			`Cleared by the daily stale-ticket run: blocker ${a.blocker.repo}#${a.blocker.number} has closed, so its \`blocked_by\` edge is removed.`,
		);
	},
	"strip-gate"(a) {
		if (!replaceBody(a.repo, a.number, a.wasBody, a.body)) return;
		comment(
			a.repo,
			a.number,
			`Cleared by the daily stale-ticket run: ${a.blocker} has closed, so the \`**Gated on:**\` marker waiting on it is stripped.`,
		);
	},
	release(a) {
		issue(a.repo, a.number, [
			"edit",
			...a.assignees.flatMap((l) => ["--remove-assignee", l]),
		]);
		const file = path.join(
			core.paths.issueClaimsDir(a.root),
			`${a.number}${core.pairSuffix(a.sessionId)}`,
		);
		fs.rmSync(file, { force: true });
	},
	retag(a) {
		runJson("retire-stale-containers.js", ["--json"], a.root);
	},
};

/** @param {Act} a */
function applyAct(a) {
	try {
		/** @type {(a: Act) => void} */ (APPLY[a.kind])(a);
		return plan.actText(a);
	} catch (e) {
		warn(`${plan.actText(a)} — failed: ${caught(e).message}`);
		return null;
	}
}

/** @param {{title: string, body: string, repo: string}} f */
const file = ({ title, body, repo }) =>
	fileOrRefresh({
		title,
		labels: [originLabel("stale-run")],
		takes: plan.HUB_TAKES,
		body,
		repo,
	});

/** @param {string} out */
const filedNumber = (out) => {
	const m = /issues\/(\d+)|#(\d+)/.exec(out);
	return m ? Number(m[1] ?? m[2]) : null;
};

/**
 * @param {import("./lib/stale-run-plan.js").Plan} p
 * @param {{coreTracker: string, hubBefore: number|null}} at
 */
function applyHub(p, { coreTracker, hubBefore }) {
	if (p.hub.action === "close") {
		issue(coreTracker, p.hub.number, ["close"]);
		return null;
	}
	if (p.hub.action === "none") return null;
	const out = file({
		title: plan.HUB_TITLE,
		body: p.hub.body,
		repo: coreTracker,
	});
	say(out);
	return filedNumber(out) ?? hubBefore;
}

/**
 * @param {import("./lib/stale-run-plan.js").Plan} p
 * @param {import("./lib/stale-run-plan.js").Snapshot} snap
 */
function apply(p, snap) {
	const acts = p.acts.flatMap((a) => applyAct(a) ?? []);
	const filings = p.filings.flatMap((f) => {
		try {
			return [
				`${f.title}: ${file({ title: f.title, body: f.body, repo: f.tracker })}`,
			];
		} catch (e) {
			warn(`${f.title} — not filed: ${caught(e).message}`);
			return [];
		}
	});
	const hub = applyHub(p, {
		coreTracker: snap.coreTracker,
		hubBefore: snap.hub?.state === "open" ? snap.hub.number : null,
	});
	return { acts, filings, hub };
}

/**
 * @param {import("./lib/stale-run-plan.js").Plan} p
 * @param {import("./lib/stale-run-plan.js").Snapshot} snap
 * @param {{acts: string[], filings: string[], hub: number|null}} done
 * @returns {import("./lib/stale-run-plan.js").RunRow}
 */
function buildRow(p, snap, done) {
	const first = new Map(
		(snap.previous?.listed ?? []).map((l) => [l.key, l.firstListed]),
	);
	return {
		date: snap.now,
		repoLines: p.repoLines,
		listed: p.lines.map((l) => ({
			key: l.key,
			cls: l.cls,
			firstListed: first.get(l.key) ?? snap.now,
		})),
		owed: p.owed,
		acts: done.acts,
		filings: done.filings,
		hub: { number: done.hub, keys: p.hubKeys },
		disposed: p.disposed,
		gates: p.gates,
	};
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

/** @param {string[]} argv */
async function main(argv = process.argv.slice(2)) {
	const { flags } = parseOrExit(argv, {
		usage: USAGE,
		flags: { "--dry-run": "boolean" },
	});
	const coreRoot = hostRoot();
	const snap = await gather({ home: homeDir(), coreRoot, now: new Date() });
	const p = plan.planStaleRun(snap);
	printPlan(p);
	if (flags["--dry-run"] === true) {
		say("--dry-run: nothing written.");
		return 0;
	}
	record.appendRow(record.recordPath(), buildRow(p, snap, apply(p, snap)));
	return 0;
}

module.exports = { main };

if (require.main === module)
	main().then(
		(code) => {
			process.exitCode = code;
		},
		(e) => {
			warn(`stale-ticket run: ${caught(e).message}`);
			process.exitCode = 1;
		},
	);
