// @vitest-environment node
/*
 * Pins the selection shortlist: which open issues are ready and count as
 * work, their order, the collision, admission and write-set annotations
 * beneath it, and that the script only ever reads the tracker (mantahostels#102,
 * mantahostels#105, mantahostels#106).
 *
 * Runs with a stub `gh` injected via WFC_GH: no network, no auth,
 * and no dependence on this repo's own issue state — which is the thing the
 * script reports on and so cannot also be its fixture.
 *
 * `run()` goes through `runInProcessAsync` (mantahostels#1944), which patches process
 * globals for the duration of one call — no `it.concurrent` or
 * `describe.concurrent` in this file, and none of the `it()`s below may
 * overlap. Vitest runs a file's tests sequentially by default; this file
 * relies on that rather than opting out of concurrency itself.
 *
 * `/pick-next` launches work off this output: loosen a case and it can
 * dispatch a blocked or already-claimed issue, pair two that collide on a
 * file, or admit a session the machine has no memory for.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from "vitest";
import {
	writeAdopterCheckout,
	writeIssueClaim,
	writeTornClaim,
} from "./lib/claim-store-testkit";
import {
	BLOCKED_BY_GRAPHQL_FAKE,
	GH_GRAPHQL_NO_REPO,
	GH_LOGGED_OUT,
	GH_NOT_FOUND,
	GH_PARENT_NOT_FOUND,
	RECORDED_SHAPES,
} from "./lib/gh-fake";
import { type GhStubServer, serveGhStub, stubGhScript } from "./lib/gh-stub";
import { loadavgLine, writeCwd, writeSmapsRollup } from "./lib/proc-fake";
import { writePsStub } from "./lib/ps-stub";
import { runInProcess, runInProcessAsync } from "./lib/run-in-process";

const writeSetCache = require("./lib/write-set-cache.js");
const warmFractionLog = require("./lib/warm-fraction-log.js");
const selectionMarker = require("./lib/selection-marker.js");
/* WITA, UTC+8 with no DST: the clock a date gate is written and read on. */
const WITA_OFFSET_MS = 8 * 3_600_000;
const { issuesIn, commandOf } = require("./lib/dispatch-ledger.js");
const { RETRO_BUNDLE_MODEL } = require("./lib/retro-bundles.js");

import type { RetroLaunch } from "./lib/retro-bundles.js";

const SCRIPT = path.resolve(__dirname, "pick-next.js");

let dir: string;

interface Issue {
	number: number;
	title?: string;
	body?: string;
	createdAt?: string;
	labels?: string[];
	assignees?: string[];
	parent?: number | null;
	/** A full parent URL, for a parent in another repo; wins over `parent`. */
	parentUrl?: string;
	repoUrl?: string;
	pull_request?: object;
	summaryBlockedBy?: number;
}

interface Fixture {
	issues: Issue[];
	/** issue number -> its canonical blocked_by list; `repo` names another */
	deps?: Record<
		number,
		{ number: number; state: "open" | "closed"; repo?: string }[]
	>;
	/** `owner/name#n` in another repo -> its blocked_by list (#2427) */
	foreignDeps?: Record<
		string,
		{ number: number; state: "open" | "closed"; repo?: string }[]
	>;
	/** issue number -> timeline events */
	timeline?: Record<
		number,
		{ label: string; created_at: string; actor: string }[]
	>;
	/** issue numbers whose blocked_by call always fails */
	failDeps?: number[];
	/** issue numbers whose timeline call always fails */
	failTimeline?: number[];
	/** issue numbers whose blocked_by call fails once, then succeeds */
	failDepsOnce?: number[];
	/** the batched GraphQL blockers read itself fails, every time */
	failGraphql?: boolean;
	/** it fails once, then succeeds */
	failGraphqlOnce?: boolean;
	/** it exits 0 having printed `empty` nothing, or `noRepo` answers gh's
	 *  missing repository: a null `repository` and its NOT_FOUND error */
	graphqlAnswers?: "empty" | "noRepo";
	/** the issues list call itself fails */
	failList?: boolean;
	/** The repo read's `open_issues_count`; the fixture's issue count by default. */
	openCount?: number;
	/**
	 * Issue number -> the session id whose arbiter claim records it (mantahostels#645). An
	 * assignee excludes only where one of these names a session the oracle lists,
	 * so a fixture that assigns without claiming is the fail-open case.
	 */
	claims?: Record<number, string>;
	/** Drops one extra, unparsable record into the issue-claims store (mantahostels#1186). */
	corruptClaim?: boolean;
	/**
	 * Repo path -> the session id whose arbiter claim holds it, for the
	 * substrate-conflict graph (mantahostels#1002). Liveness is the same oracle the issue
	 * claims use, so a path claimed by a session `oracleSessions` omits is a
	 * finished session's leftover and holds nothing up.
	 */
	heldFiles?: Record<string, string>;
	/**
	 * Extra file-claim locks, keyed by an arbitrary label (not the repo path,
	 * which `heldFiles` already keys on): for the stranded-claim count (mantahostels#1206),
	 * which needs a claim whose age and holder are set independently of the
	 * fresh, listed-holder claims `heldFiles` writes.
	 */
	staleFiles?: Record<
		string,
		{ path: string; sessionId: string; hoursAgo: number }
	>;
	/**
	 * Issue number -> what its `issues/<n>/parent` answers, for a parent in
	 * another repo (#2310); an issue it omits answers GitHub's 404.
	 */
	parents?: Record<number, { url: string; labels: string[] }>;
	/** Debt-store entries for the owed-work count (mantahostels#1206). */
	debts?: Array<{ path: string; issue?: number; gist?: string }>;
	/**
	 * Lines in `.pick-next/dispatched.jsonl`, the ledger
	 * `scripts/dispatch-sessions.sh` appends to as it launches (mantahostels#1528).
	 * `hoursAgo` defaults to 0.5, inside the 1-hour window the launcher drops on.
	 */
	dispatched?: Array<{
		issues: number[];
		prompt?: string;
		hoursAgo?: number;
		/** The launched job's own short id (mantahostels#3488) — absent reproduces a
		 * pre-mantahostels#3488 entry, which `dispatchLiveness` reads as unknown. */
		jobId?: string;
		/** Follows the entry with a release row for its `jobId` (#2744). */
		released?: boolean;
	}>;
	/** Makes the ledger path a directory, so the read throws EISDIR (mantahostels#1528). */
	dispatchLedgerUnreadable?: boolean;
	/** Locks the debts dir to 0o000, simulating a store that will not read (mantahostels#1206). */
	debtsUnreadable?: boolean;
}

/* The stub `gh`'s files in each test's sandbox, named once for the handler and the test. */
const FIXTURE_FILE = "fixture.json";
const CALL_LOG_FILE = "calls.log";
const CALL_LOG = () => path.join(dir, CALL_LOG_FILE);

/** The calls other than the batched blockers read, whose query text names
 *  `labels` and `issue` as fields it reads. */
const restCalls = (calls: string[]) =>
	calls.filter((c) => !c.startsWith("api graphql "));

/** Every GraphQL call is a `query`, never a `mutation`. */
const expectGraphqlReadsOnly = (calls: string[]) => {
	for (const call of calls.filter((c) => c.startsWith("api graphql "))) {
		expect(call).toMatch(/ -f query=query\(/);
		expect(call).not.toMatch(/mutation/);
	}
};

/*
 * The `gh` every run calls: one stub server for the whole file (#2878), so a
 * call costs a bash start rather than a node start. Each run names its own
 * sandbox in GH_STUB_DIR, where the handler reads the fixture and keeps its
 * call log and retry counts.
 *
 * It routes by path and counts retries across calls, which the shared gh
 * fake's answers, each a function of one call, cannot, so each REST answer
 * goes through `asRecorded`, which holds it to the fixture gh.contract.test.ts
 * holds to the real gh.
 */
const GH_HANDLER = `const fs = require("node:fs");
const path = require("node:path");
const fx = JSON.parse(fs.readFileSync(path.join(env.GH_STUB_DIR, ${JSON.stringify(FIXTURE_FILE)}), "utf8"));
fs.appendFileSync(path.join(env.GH_STUB_DIR, ${JSON.stringify(CALL_LOG_FILE)}), argv.join(" ") + "\\n");

const p = argv[1] || "";
const num = (re) => { const m = p.match(re); return m ? Number(m[1]) : null; };
const die = (msg) => { err("gh: " + msg + "\\n"); exit(1); };
// --slurp wraps each page's array; one page is enough for every fixture here.
const page = (kind, rows) => out(asRecorded(kind, [rows]) + "\\n");

const seen = path.join(env.GH_STUB_DIR, "seen.json");
const bump = (k) => {
  const s = fs.existsSync(seen) ? JSON.parse(fs.readFileSync(seen, "utf8")) : {};
  s[k] = (s[k] || 0) + 1;
  fs.writeFileSync(seen, JSON.stringify(s));
  return s[k];
};

const edges = (rows) => rows.map((e) => ({
  number: e.number,
  state: e.state,
  title: "issue " + (e.repo ? e.repo + "#" : "") + e.number,
  repository_url: e.repo ? "https://api.github.com/repos/" + e.repo : undefined,
}));
// The run's own repo is \`--repo o/r\`, or gh's \`{owner}/{repo}\`.
const foreign = (p.match(/^repos\\/([^{][^/]*\\/[^/]+)\\/issues\\/(\\d+)/) || []).slice(1);
if (foreign.length && foreign[0] !== "o/r" && /dependencies\\/blocked_by/.test(p))
  return page("blockedByPage", edges((fx.foreignDeps || {})[foreign[0] + "#" + foreign[1]] || []));
// The batched read answers null for an issue whose REST read the fixture
// fails, so that issue takes the REST path and meets the failure there.
${BLOCKED_BY_GRAPHQL_FAKE}
${RECORDED_SHAPES}
// The embedded serveAnswer calls process.exit, which here ends the server.
const answer = (a) => { out(a.stdout); err(a.stderr); exit(a.status); };
const fail = () => answer(${JSON.stringify(GH_NOT_FOUND)});
if (p === "graphql") {
  if (fx.failGraphql) return fail();
  if (fx.failGraphqlOnce && bump("graphql") === 1) return fail();
  if (fx.graphqlAnswers === "empty") return;
  if (fx.graphqlAnswers === "noRepo") return answer(${JSON.stringify(GH_GRAPHQL_NO_REPO)});
  const failing = [...(fx.failDeps || []), ...(fx.failDepsOnce || [])];
  return answer(answerBlockedBy(argv, (n) =>
    failing.includes(n) ? null : (fx.deps || {})[n] || []));
}
if (/dependencies\\/blocked_by/.test(p)) {
  const n = num(/issues\\/(\\d+)\\/dependencies/);
  if ((fx.failDeps || []).includes(n)) return fail();
  if ((fx.failDepsOnce || []).includes(n) && bump("deps" + n) === 1) return fail();
  return page("blockedByPage", edges((fx.deps || {})[n] || []));
}
if (/\\/parent$/.test(p)) {
  const parent = (fx.parents || {})[num(/issues\\/(\\d+)\\/parent/)];
  if (!parent) return answer(${JSON.stringify(GH_PARENT_NOT_FOUND)});
  return page("parentPage", { url: parent.url, labels: parent.labels.map((name) => ({ name })) });
}
if (/\\/timeline/.test(p)) {
  const n = num(/issues\\/(\\d+)\\/timeline/);
  if ((fx.failTimeline || []).includes(n)) return fail();
  return page("timelinePage", ((fx.timeline || {})[n] || []).map((e) => ({
    event: "labeled",
    label: { name: e.label },
    created_at: e.created_at,
    actor: { login: e.actor },
  })));
}
if (/^repos\\/[^/]+\\/[^/]+$/.test(p))
  return out(asRecorded("repo", { open_issues_count: fx.openCount ?? fx.issues.length }) + "\\n");
if (/issues\\?state=open/.test(p)) {
  if (fx.failList) return answer(${JSON.stringify(GH_LOGGED_OUT)});
  return page("issuesPage", fx.issues.map((i) => ({
    number: i.number,
    title: i.title || ("issue " + i.number),
    body: i.body || "",
    html_url: "http://example/" + i.number,
    created_at: i.createdAt,
    assignees: (i.assignees || []).map((login) => ({ login })),
    labels: (i.labels || []).map((name) => ({ name })),
    parent_issue_url: i.parentUrl || (i.parent ? "http://api/issues/" + i.parent : null),
    repository_url: i.repoUrl,
    pull_request: i.pull_request,
    issue_dependencies_summary: { blocked_by: i.summaryBlockedBy || 0 },
  })));
}
die("unexpected path: " + p);
`;

let ghServer: GhStubServer;
beforeAll(async () => {
	ghServer = await serveGhStub(GH_HANDLER);
});
afterAll(() => ghServer.close());

/** Points the stub server at `fx` for this run. */
const stubGh = (fx: Fixture) => {
	fs.writeFileSync(path.join(dir, FIXTURE_FILE), JSON.stringify(fx));
	return stubGhScript(dir, ghServer.script);
};

/*
 * The machine admission measures (mantahostels#384). Hermetic by default, like the tree
 * below: a quiet box with nothing of ours running, so no test reads the real
 * `/proc/meminfo` or the sessions that happen to be live while it runs.
 */
let psOut = "";
let psFails = false;
let memAvailableKb: number | null = 4096 * 1024;
/** Replaces the whole `/proc/meminfo` where set. */
let meminfoText: string | null = null;
/** load1 for the stand-in `/proc/loadavg`, against a ceiling of 48 (#830). */
let load1 = 0.5;
/** WFC_SESSION_CEILING (#2141); off unless set, so the runner's core count never holds a slot. */
let sessionCeiling = "0";
/** WFC_SESSION_FLOOR (#2501); empty is no floor, so the host's ~/.claude/session-floor is never read. */
let sessionFloor = "";
/** A `ps` line as the real one prints it: comm, then the full argv. */
const buildPsLine = (comm: string, args: string) => `${comm} ${args}`;
/** The two processes one live session is (docs/environment.md). */
const sessionProcs = (id: string, exe = "claude") => [
	buildPsLine(
		"2.1.233",
		`${exe} bg-pty-host --bg-pty-host /tmp/${id}.pty.sock 200`,
	),
	buildPsLine("2.1.233", `${exe} bg-spare --bg-spare /tmp/${id}.claim.sock`),
];

/** The tree the path annotation resolves backticked tokens against. */
let repoRoot: string | null = null;
const roots: string[] = [];
const stubRepo = (files: string[]) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pick-next-repo-"));
	roots.push(root);
	for (const f of files) {
		fs.mkdirSync(path.join(root, path.dirname(f)), { recursive: true });
		fs.writeFileSync(path.join(root, f), "");
	}
	spawnSync("git", ["init", "-q"], { cwd: root });
	spawnSync("git", ["add", "-A"], { cwd: root });
	repoRoot = root;
};
/** A directory that is no git repository at all, so `git ls-files` fails. */
const stubBrokenRepo = () => {
	repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pick-next-norepo-"));
	roots.push(repoRoot);
};

/*
 * The sessions `claude agents --json` lists. This run's own session is always
 * one of them — the shared reader refuses a list that omits it — so the count
 * admission prints is one fewer than the length here.
 *
 * An entry may carry `@<pid>` to say which pid that session is, so its
 * processes are paired with it (mantahostels#1295).
 */
let oracleSessions: string[] = ["self"];
let oracleFails = false;
/** Session id -> the display name `claude agents --json` reports, where it has one. */
let oracleNames: Record<string, string> = {};
/*
 * The listed sessions the oracle reports FINISHED but still resident — the
 * reclaimable pool. Members must also appear in `oracleSessions`; this only
 * says which of them carry `kind: background` / `state: done`.
 */
let oracleFinished: string[] = [];
/** The listed sessions the oracle reads `state: working`, which the session floor counts (#2505). */
let oracleWorking: string[] = [];
/* Pair PSS in kB by pid, written under the stub /proc. */
let procPssKb: Record<string, number> = {};
/* Each pid's cwd, a `cwd` symlink under the stub /proc: a `bg-spare` in its
 * claim socket's directory is an idle spare (#2502). */
let procCwds: Record<string, string> = {};
/* The draw the admission cases' arithmetic is written at, declared in each
 * fixture repo, so a re-measured DEFAULT_SESSION_DRAW moves none of them
 * (#2231). */
const FIXTURE_DRAW = { sessionMeanMb: 429, sessionSigmaMb: 154 };
/* A working session's pair, above FIXTURE_DRAW's mean. */
const WORKING_PAIR_KB = 640 * 1024;
/* The one spare pair admission reserves where no pair is idle (#2223):
 * `IDLE_PAIR_MB` in lib/admission.js. */
const IDLE_PAIR_MB = 106;
/** Settable to "", as a cron run or a subshell that does not propagate it leaves it. */
let oracleSelfId = "self";
/** A fake `claude` whose `agents --json` lists `oracleSessions`. */
const stubOracle = () => {
	const bin = path.join(dir, "claude");
	fs.writeFileSync(
		bin,
		oracleFails
			? '#!/bin/sh\necho "claude: no daemon" >&2\nexit 1\n'
			: `#!/bin/sh\ncat ${JSON.stringify(path.join(dir, "agents.json"))}\n`,
		{ mode: 0o755 },
	);
	fs.writeFileSync(
		path.join(dir, "agents.json"),
		JSON.stringify(
			oracleSessions.map((entry) => {
				const [id, pid] = entry.split("@");
				return {
					sessionId: id,
					...(pid ? { pid: Number(pid) } : {}),
					/* In the fixture repo, which declares no draw, so each is
					 * charged the default and no problem is printed (#2221). */
					...(repoRoot ? { cwd: repoRoot } : {}),
					...(oracleNames[id] ? { name: oracleNames[id] } : {}),
					/*
					 * `status: busy` deliberately: that is the real `shell` session's
					 * pairing (https://github.com/lucmoseley/workflow-core-tracker/blob/0a69e0d4be03/docs/research/session-state-status-skew.md), so a `status` limb re-added to either
					 * reader would drop these and fail the tests below.
					 */
					...(oracleFinished.includes(id)
						? { kind: "background", state: "done", status: "busy" }
						: {}),
					...(oracleWorking.includes(id) ? { state: "working" } : {}),
				};
			}),
		),
	);
	return { WFC_CLAUDE_BIN: bin, CLAUDE_CODE_SESSION_ID: oracleSelfId };
};

/*
 * The arbiter's issue-claim store (mantahostels#645), in a throwaway CLAUDE_CONFIG_DIR.
 *
 * Both vars are set on every run, claims or none: without them the store
 * resolves to the founder's real ~/.claude keyed on this very repo, and the
 * suite would read whichever issues live sessions happen to be holding.
 *
 * CLAUDE_PROJECT_DIR names the SAME tree WFC_REPO_ROOT pins, unless a test
 * asks otherwise.
 */
let claimsRepo: string | null = null;
/*
 * Production sets NEITHER variable — the Bash tool's environment leaves
 * CLAUDE_PROJECT_DIR unset (measured at mantahostels#741; .claude/skills/pick-next/SKILL.md), and
 * nothing sets WFC_REPO_ROOT at all — so the store falls back to `git
 * rev-parse` of the working directory. Opt in to that shape with
 * `noProjectDir`, and say from where with `runCwd`.
 *
 * mantahostels#183 is NOT authority for this, though it reads as though it were: it is the
 * cd-to-a-variable-path guard ticket, and it records the near-opposite — Claude
 * Code injects both variables per tool invocation, so hooks DO receive them.
 */
let noProjectDir = false;
let runCwd: string | null = null;
const stubClaims = (fx: Fixture) => {
	const home = path.join(dir, "home", ".claude");
	const repo = claimsRepo ?? repoRoot ?? path.join(dir, "claims-repo");
	fs.mkdirSync(repo, { recursive: true });
	const config = path.join(repo, ".claude", "workflow-core.json");
	if (!fs.existsSync(config)) {
		fs.mkdirSync(path.dirname(config), { recursive: true });
		fs.writeFileSync(config, JSON.stringify(FIXTURE_DRAW));
	}
	const claimsDir = path.join(
		home,
		"projects",
		repo.replace(/[^a-zA-Z0-9]/g, "-"),
		"issue-claims",
	);
	// Cleared, not merely topped up: a test that runs twice in one sandbox would
	// otherwise carry the first run's claims into the second.
	fs.rmSync(claimsDir, { recursive: true, force: true });
	fs.mkdirSync(claimsDir, { recursive: true });
	for (const [n, sessionId] of Object.entries(fx.claims ?? {}))
		fs.writeFileSync(
			path.join(claimsDir, `${n}-${sessionId}.json`),
			JSON.stringify({ issue: Number(n), sessionId, claimedAt: daysAgo(1) }),
		);
	if (fx.corruptClaim)
		fs.writeFileSync(path.join(claimsDir, "bogus.json"), "not json");
	const locksDir = path.join(
		home,
		"projects",
		repo.replace(/[^a-zA-Z0-9]/g, "-"),
		"locks",
	);
	fs.rmSync(locksDir, { recursive: true, force: true });
	fs.mkdirSync(locksDir, { recursive: true });
	for (const [rel, sessionId] of Object.entries(fx.heldFiles ?? {})) {
		const key = createHash("sha256").update(rel).digest("hex").slice(0, 16);
		fs.writeFileSync(
			path.join(locksDir, `${key}.json`),
			JSON.stringify({ path: rel, sessionId, claimedAt: daysAgo(0) }),
		);
	}
	for (const [label, s] of Object.entries(fx.staleFiles ?? {})) {
		const key = createHash("sha256")
			.update(`${s.path}:${label}`)
			.digest("hex")
			.slice(0, 16);
		fs.writeFileSync(
			path.join(locksDir, `${key}.json`),
			JSON.stringify({
				path: s.path,
				sessionId: s.sessionId,
				claimedAt: new Date(Date.now() - s.hoursAgo * 3_600_000).toISOString(),
			}),
		);
	}

	const debtsDir = path.join(
		home,
		"projects",
		repo.replace(/[^a-zA-Z0-9]/g, "-"),
		"debts",
	);
	fs.rmSync(debtsDir, { recursive: true, force: true });
	fs.mkdirSync(debtsDir, { recursive: true });
	(fx.debts ?? []).forEach((d, i) => {
		fs.writeFileSync(
			path.join(debtsDir, `debt-${i}.json`),
			JSON.stringify({
				path: d.path,
				issue: d.issue ?? null,
				gist: d.gist ?? null,
				createdAt: daysAgo(1),
			}),
		);
	});
	if (fx.debtsUnreadable) fs.chmodSync(debtsDir, 0o000);

	return { CLAUDE_CONFIG_DIR: home, CLAUDE_PROJECT_DIR: repo };
};

/**
 * One dispatched job's own local `state.json`, under the same throwaway
 * `CLAUDE_CONFIG_DIR` `stubClaims` points every run at (mantahostels#3488) — the path
 * `dispatchLiveness` reads via `lib/hung-jobs.js#readJobs`.
 */
const writeJobState = (
	jobId: string,
	rec: { state: string; sessionId?: string },
) => {
	const home = path.join(dir, "home", ".claude");
	const jobDir = path.join(home, "jobs", jobId);
	fs.mkdirSync(jobDir, { recursive: true });
	fs.writeFileSync(path.join(jobDir, "state.json"), JSON.stringify(rec));
};

/**
 * The launcher's dispatch ledger, under the tree WFC_REPO_ROOT names — the
 * same directory the write-set cache and the warm-fraction log live in, so a
 * test that sets no `dispatched` leaves it genuinely absent.
 */
const stubDispatchLedger = (fx: Fixture) => {
	const root = repoRoot ?? dir;
	const file = path.join(
		root,
		".claude",
		"tmp",
		"markers",
		".pick-next",
		"dispatched.jsonl",
	);
	// The LEDGER ONLY: `.pick-next/` also holds the write-set cache and the
	// last-run snapshot, and clearing the directory would empty both.
	fs.rmSync(file, { recursive: true, force: true });
	if (fx.dispatchLedgerUnreadable) {
		fs.mkdirSync(file, { recursive: true });
		return;
	}
	if (!fx.dispatched || fx.dispatched.length === 0) return;
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(
		file,
		`${fx.dispatched
			.flatMap((d) => {
				const ts = new Date(
					Date.now() - (d.hoursAgo ?? 0.5) * 3_600_000,
				).toISOString();
				const launch = JSON.stringify({
					ts,
					issues: d.issues,
					model: "opus",
					prompt: d.prompt ?? `/implement ${d.issues.join(" ")}`,
					session: "gone",
					jobId: d.jobId ?? null,
				});
				return d.released
					? [launch, JSON.stringify({ ts, released: d.jobId })]
					: [launch];
			})
			.join("\n")}\n`,
	);
};

/** A fake `ps` printing `psOut`, and a `/proc/meminfo` holding `memAvailableKb`. */
const stubMachine = () => {
	const ps = writePsStub(dir, psOut ? psOut.split("\n") : [], {
		fails: psFails,
	});
	const meminfo = path.join(dir, "meminfo");
	fs.writeFileSync(
		meminfo,
		meminfoText ??
			`MemTotal:        8114464 kB\nMemFree:          554820 kB\n${
				memAvailableKb === null ? "" : `MemAvailable: ${memAvailableKb} kB\n`
			}`,
	);
	/*
	 * A directory with no numbered subdirs, so `daemonSpareOverheadMb`'s
	 * `readPssKb(pid)` reads never resolve against this host's real /proc — a
	 * fixture pid (111, say) could otherwise coincide with a live process here
	 * and read a real smaps_rollup, making the reservation figure non-hermetic
	 * (mantahostels#1295).
	 */
	const proc = path.join(dir, "proc");
	fs.mkdirSync(proc, { recursive: true });
	for (const [pid, kb] of Object.entries(procPssKb))
		writeSmapsRollup(proc, pid, kb);
	for (const [pid, cwd] of Object.entries(procCwds)) writeCwd(proc, pid, cwd);
	const loadavg = path.join(dir, "loadavg");
	fs.writeFileSync(loadavg, loadavgLine(load1));
	return {
		WFC_PS: ps,
		WFC_MEMINFO: meminfo,
		WFC_PROC: proc,
		WFC_LOADAVG: loadavg,
		WFC_LOAD_CEILING: "48",
		WFC_SESSION_CEILING: sessionCeiling,
		WFC_SESSION_FLOOR: sessionFloor,
		// The suite queue's dir, so no live lander's marker here holds memory (#2416).
		TMPDIR: dir,
	};
};

/*
 * `ownRepo` drops the `--repo` flag, so the run reads as this tree's own
 * repository. The write-set cache is keyed on the tree alone, so it serves only
 * that case — see "skips the store entirely against another repository".
 */
const run = async (
	fx: Fixture,
	args: string[] = [],
	opts: {
		ownRepo?: boolean;
		oracleCache?: boolean;
		env?: Record<string, string>;
	} = {},
) => {
	const stub = stubGh(fx);
	stubDispatchLedger(fx);
	const repoArgs = opts.ownRepo ? [] : ["--repo", "o/r"];
	const env: NodeJS.ProcessEnv = {
		...process.env,
		...stub.env,
		GH_STUB_DIR: dir,
		...stubMachine(),
		...stubOracle(),
		...stubClaims(fx),
		...(repoRoot ? { WFC_REPO_ROOT: repoRoot } : {}),
		/*
		 * Off for run cost and determinism, not for correctness: mantahostels#1960 removed the
		 * plain aged-cache hit `readListing()` served, so nothing in this seam can
		 * answer a second call with a first call's cached success (mantahostels#1946). One test
		 * below opts back in: "reflects a live failure on the second read rather
		 * than the first read's cached success".
		 */
		WFC_ORACLE_CACHE: opts.oracleCache ? "1" : "0",
		...opts.env,
	};
	if (noProjectDir) delete env.CLAUDE_PROJECT_DIR;
	const r = await runInProcessAsync(SCRIPT, [...repoArgs, ...args], {
		env,
		...(runCwd ? { cwd: runCwd } : {}),
	});
	const out = `${r.stdout}${r.stderr}`;
	return {
		status: r.status,
		out,
		json: () => JSON.parse(r.stdout || "{}"),
		/** The frontier's issue numbers, in printed order. */
		order: () =>
			(out.split("\nEXCLUDED")[0].match(/^#(\d+) /gm) ?? []).map((s) =>
				Number(s.slice(1)),
			),
		calls: () =>
			fs.existsSync(CALL_LOG())
				? fs.readFileSync(CALL_LOG(), "utf8").trim().split("\n")
				: [],
	};
};

const daysAgo = (n: number) =>
	new Date(Date.now() - n * 86_400_000).toISOString();

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "pick-next-test-"));
	// Hermetic by default: an empty tree tracks no file, so no body resolves.
	stubRepo([]);
	psOut = "";
	psFails = false;
	oracleSessions = ["self"];
	oracleFails = false;
	oracleNames = {};
	oracleFinished = [];
	oracleWorking = [];
	procPssKb = {};
	procCwds = {};
	oracleSelfId = "self";
	memAvailableKb = 4096 * 1024;
	meminfoText = null;
	load1 = 0.5;
	sessionCeiling = "0";
	sessionFloor = "";
	claimsRepo = null;
	noProjectDir = false;
	runCwd = null;
});
afterEach(() => {
	// A permission-locked debts dir (debtsUnreadable) would otherwise survive
	// rmSync and leak into the next mkdtemp.
	try {
		execFileSync("chmod", ["-R", "u+rwx", dir]);
	} catch {
		/* dir may not exist if a test failed before creating it */
	}
	fs.rmSync(dir, { recursive: true, force: true });
	for (const r of roots.splice(0))
		fs.rmSync(r, { recursive: true, force: true });
	repoRoot = null;
});

describe("readiness", () => {
	it("drops an issue with an open blocker and keeps one whose blocker closed", async () => {
		const r = await run({
			issues: [{ number: 1 }, { number: 2 }, { number: 3 }],
			deps: {
				2: [{ number: 1, state: "open" }],
				3: [{ number: 99, state: "closed" }],
			},
		});
		expect(r.order()).toContain(3);
		expect(r.order()).not.toContain(2);
		expect(r.out).toMatch(/#2\s+.*blocked by #1/);
	});

	it("ignores issue_dependencies_summary.blocked_by — the mantahostels#19 staleness trap", async () => {
		const r = await run({
			issues: [{ number: 18 }, { number: 19, summaryBlockedBy: 0 }],
			deps: { 19: [{ number: 18, state: "open" }] },
		});
		expect(r.order()).not.toContain(19);
		expect(r.out).toMatch(/#19\s+.*blocked by #18/);
	});

	it("honours a blocker that is also the blocked issue's own child", async () => {
		// The live cross-group edge mantahostels#105 found: mantahostels#93 blocks mantahostels#79 while being mantahostels#79's
		// child. A query assuming edges run parent-downward drops it.
		const r = await run({
			issues: [{ number: 79 }, { number: 93, parent: 79 }],
			deps: { 79: [{ number: 93, state: "open" }] },
		});
		expect(r.order()).toEqual([93]);
		expect(r.out).toMatch(/#79\s+.*blocked by #93/);
	});

	it("excludes an issue whose prose `**Blocked on**` names a still-open issue (mantahostels#1289)", async () => {
		const r = await run({
			issues: [{ number: 831 }, { number: 832, body: "**Blocked on** #831." }],
		});
		expect(r.order()).not.toContain(832);
		expect(r.out).toMatch(/#832\s+.*blocked by #831 \(prose only\)/);
	});

	it("resolves a prose blocker naming a closed issue for free, no second call", async () => {
		// mantahostels#831 closed; mantahostels#832/mantahostels#833/mantahostels#835 named it and were takeable all along
		// (the real shape measured 24 August 2026).
		const r = await run({
			issues: [{ number: 832, body: "**Blocked on** #831." }],
		});
		expect(r.order()).toContain(832);
		for (const call of r.calls()) expect(call).not.toMatch(/issues\/831\b/);
	});

	it("merges a prose blocker with a native one rather than doubling it", async () => {
		const r = await run({
			issues: [{ number: 1 }, { number: 2, body: "**Blocked on** #1." }],
			deps: { 2: [{ number: 1, state: "open" }] },
		});
		expect(r.out).toMatch(/#2\s+.*blocked by #1(?!.*#1)/);
	});

	it("carries a blocker naming no issue number, and excludes nothing on it", async () => {
		// mantahostels#927's shape: the marker names a roadmap card, mid-sentence, so there
		// is no number to resolve against the open list.
		const r = await run(
			{
				issues: [
					{
						number: 9,
						body: "Standalone work. **Blocked on the `seed-listings` roadmap card** — meaningless against an empty table.",
					},
				],
			},
			["--json"],
		);
		const entry = r
			.json()
			.proseBlocked.find((p: { number: number }) => p.number === 9) as {
			named: string[];
			unparsed: string[];
		};
		expect(entry.named).toEqual([]);
		expect(entry.unparsed).toEqual([
			"**Blocked on the `seed-listings` roadmap card** — meaningless against an empty table.",
		]);
		expect(
			r.json().frontier.map((f: { number: number }) => f.number),
		).toContain(9);
	});

	it("carries every prose blocker in --json, resolved or not", async () => {
		const r = await run(
			{
				issues: [
					{ number: 1 },
					{ number: 2, body: "**Blocked on** #1." },
					{ number: 3, body: "**Blocked on** #831." },
				],
			},
			["--json"],
		);
		expect(r.json().proseBlocked).toEqual([
			{
				number: 2,
				title: "issue 2",
				named: ["#1"],
				open: ["#1"],
				closed: [],
				unreadable: [],
				unparsed: [],
			},
			{
				number: 3,
				title: "issue 3",
				named: ["#831"],
				open: [],
				closed: ["#831"],
				unreadable: [],
				unparsed: [],
			},
		]);
	});

	it("judges a marker naming this repo as `owner/name#n` against the open list (#3277)", async () => {
		const r = await run({
			issues: [
				{ number: 1 },
				{ number: 2, body: "**Blocked on** o/r#1." },
				{ number: 3, body: "**Blocked on** O/R#831." },
			],
		});
		expect(r.out).toMatch(/#2\s+names #1 — still blocked by #1/);
		expect(r.out).toMatch(
			/#3\s+names #831 — every named issue is closed, resolved/,
		);
		for (const call of r.calls()) expect(call).not.toMatch(/issues\/(1|831)\b/);
	});

	it("reports a marker in another repo whose read fails as unreadable, and holds it", async () => {
		const fx = { issues: [{ number: 2, body: "**Blocked on** o/x#5." }] };
		const text = await run(fx);
		expect(text.out).toMatch(/#2\s+names o\/x#5 — o\/x#5 unreadable, held \(/);
		const r = await run(fx, ["--json"]);
		const row = r.json().proseBlocked[0];
		expect(row.named).toEqual(["o/x#5"]);
		expect(row.closed).toEqual([]);
		expect(row.unreadable).toEqual([
			{ ref: "o/x#5", error: expect.any(String) },
		]);
		expect(
			r.json().frontier.map((f: { number: number }) => f.number),
		).not.toContain(2);
	});

	it("prints the prose self-gate block, split by still-open and resolved", async () => {
		const r = await run({
			issues: [
				{ number: 1 },
				{ number: 2, body: "**Blocked on** #1." },
				{ number: 3, body: "**Blocked on** #831." },
			],
		});
		expect(r.out).toMatch(/PROSE SELF-GATES/);
		expect(r.out).toMatch(/#2\s+names #1 — still blocked by #1/);
		expect(r.out).toMatch(
			/#3\s+names #831 — every named issue is closed, resolved/,
		);
	});

	it("says nothing about prose self-gates when no body carries one", async () => {
		const r = await run({ issues: [{ number: 1 }] });
		expect(r.out).not.toMatch(/PROSE SELF-GATES/);
	});

	it("names a blocker in another repo as owner/name#n, crediting nothing to the issue here sharing its number (#2427)", async () => {
		const r = await run(
			{
				issues: [{ number: 1 }, { number: 5 }],
				deps: { 1: [{ number: 5, state: "open", repo: "o/there" }] },
			},
			["--json"],
		);
		const j = r.json();
		expect(j.frontier.map((f: { number: number }) => f.number)).toEqual([5]);
		expect(j.frontier[0].reach).toBe(0);
		const home = path.join(dir, "no-adopters");
		fs.mkdirSync(home);
		const text = await run(
			{
				issues: [{ number: 1 }, { number: 5 }],
				deps: { 1: [{ number: 5, state: "open", repo: "o/there" }] },
			},
			[],
			{ env: { HOME: home } },
		);
		expect(text.out).toMatch(/#1\s+.*blocked by o\/there#5/);
	});

	it("pulls in the open end of a foreign chain, held where no checkout tracks its repo (#2427)", async () => {
		const home = path.join(dir, "adopters");
		fs.mkdirSync(home);
		const fx = {
			issues: [{ number: 1 }],
			deps: { 1: [{ number: 10, state: "open" as const, repo: "o/y" }] },
			foreignDeps: {
				"o/y#10": [{ number: 20, state: "open" as const, repo: "o/z" }],
			},
		};
		const r = await run(fx, ["--json"], { env: { HOME: home } });
		expect(r.json().pulledIn).toEqual([
			expect.objectContaining({
				repo: "o/z",
				number: 20,
				reach: 1,
				holds: ["o/r#1"],
				root: null,
				held: `no checkout under ${home} tracks o/z`,
			}),
		]);
		const text = await run(fx, [], { env: { HOME: home } });
		expect(text.out).toMatch(
			/PULLED IN FROM OTHER REPOS[\s\S]*o\/z#20\s+depth 1\s+reach 1\s+holds o\/r#1\s+HELD OUTSIDE THE LOOP: no checkout under \S+ tracks o\/z/,
		);
	});

	it("offers a pulled-in blocker from its checkout, refillLoop: false or not (#2427, #3281)", async () => {
		const home = path.join(dir, "adopters");
		const z = path.join(home, "z");
		writeAdopterCheckout(z, "o/z");
		const fx = {
			issues: [{ number: 1 }],
			deps: { 1: [{ number: 20, state: "open" as const, repo: "o/z" }] },
		};
		const r = await run(fx, ["--json"], { env: { HOME: home } });
		expect(r.json().pulledIn[0]).toMatchObject({ root: z, held: null });
		fs.writeFileSync(
			path.join(z, ".claude", "workflow-core.json"),
			JSON.stringify({ tracker: "o/z", refillLoop: false }),
		);
		const off = await run(fx, ["--json"], { env: { HOME: home } });
		expect(off.json().pulledIn[0]).toMatchObject({ root: z, held: null });
	});

	it("never calls the /dependencies/blocking endpoint", async () => {
		const r = await run({ issues: [{ number: 1 }, { number: 2 }] });
		expect(r.calls().join("\n")).not.toMatch(/dependencies\/blocking/);
	});
});

describe("what counts as work", () => {
	it("excludes an open issue with an open child, whatever its labels", async () => {
		// mantahostels#40 has four open children and no `wayfinder:map` label. The label-based
		// container test let it into the frontier; the structural test drops it.
		const r = await run({
			issues: [
				{ number: 40 },
				{ number: 78, parent: 40 },
				{ number: 83, parent: 40 },
			],
		});
		expect(r.order()).toEqual([78, 83]);
		expect(r.out).toMatch(/#40\s+.*container — 2 open children/);
	});

	it("re-admits a parent once its last child closes", async () => {
		const r = await run({ issues: [{ number: 40 }] });
		expect(r.order()).toEqual([40]);
	});

	it("treats an assignee as the claim and drops the issue", async () => {
		const r = await run({
			issues: [{ number: 1, assignees: ["owner"] }, { number: 2 }],
			claims: { 1: "self" },
		});
		expect(r.order()).toEqual([2]);
		expect(r.out).toMatch(/#1\s+.*claimed by owner/);
	});

	it("never filters on a readiness label, since no close clears one", async () => {
		const r = await run({
			issues: [{ number: 1 }, { number: 2, labels: ["takes:implement"] }],
		});
		expect(r.order()).toEqual([1, 2]);
	});

	it("drops pull requests, which share the issue number space", async () => {
		const r = await run({
			issues: [{ number: 1 }, { number: 2, pull_request: { url: "x" } }],
		});
		expect(r.order()).toEqual([1]);
		expect(r.out).toMatch(/OPEN ISSUES: 1/);
	});
});

describe("ordering", () => {
	it("counts reach transitively over open descendants", async () => {
		// 1 <- 2 <- 3 <- 4: only mantahostels#1 is takeable, and its reach is 3, not 1 — mantahostels#101
		// (what defines urgency) made reach transitive.
		const r = await run({
			issues: [{ number: 1 }, { number: 2 }, { number: 3 }, { number: 4 }],
			deps: {
				2: [{ number: 1, state: "open" }],
				3: [{ number: 2, state: "open" }],
				4: [{ number: 3, state: "open" }],
			},
		});
		expect(r.out).toMatch(/#1\s+3\s/);
	});

	it("sorts an urgent above every non-bug, and reports who applied it", async () => {
		const r = await run({
			issues: [{ number: 1 }, { number: 2 }, { number: 3, labels: ["urgent"] }],
			deps: { 2: [] },
			timeline: {
				3: [{ label: "urgent", created_at: daysAgo(2), actor: "owner" }],
			},
			// mantahostels#1 and mantahostels#2 have reach 0 too, so only urgency can lift mantahostels#3 to the top.
		});
		expect(r.order()[0]).toBe(3);
		expect(r.out).toMatch(/#3\s+applied by owner 2d ago/);
	});

	it("keeps an urgent applied 9 days ago in the urgent band — it never expires (#2664)", async () => {
		const r = await run({
			issues: [{ number: 1 }, { number: 3, labels: ["urgent"] }],
			timeline: {
				3: [{ label: "urgent", created_at: daysAgo(9), actor: "owner" }],
			},
		});
		expect(r.order()).toEqual([3, 1]);
		expect(r.out).toMatch(/#3\s+applied by owner 9d ago/);
	});

	it("ranks a descendant of an urgent map as urgent, with no label of its own (#2664)", async () => {
		const fx = {
			issues: [
				{ number: 1 },
				{ number: 10, labels: ["wayfinder:map", "urgent"] },
				{ number: 11, parent: 10 },
				{ number: 12, parent: 11 },
			],
			timeline: {
				10: [{ label: "urgent", created_at: daysAgo(10), actor: "owner" }],
			},
		};
		const rows = (await run(fx, ["--json"])).json().frontier;
		expect(rows.map((f: { number: number }) => f.number)).toEqual([12, 1]);
		expect(rows[0]).toMatchObject({
			urgent: true,
			urgentVia: { number: 10, path: ["#11", "#10"] },
			bug: false,
		});
		const text = await run(fx);
		expect(text.out).toMatch(
			/^ {2}#12 {2}urgent via #10 \(holds #11 → #10\)$/m,
		);
		expect(text.out).toMatch(/#12\s+via\s/);
	});

	it("passes urgency down from a parent that is not a map (#3250)", async () => {
		const r = await run({
			issues: [
				{ number: 1 },
				{ number: 10, labels: ["kind:spec", "urgent"] },
				{ number: 11, parent: 10 },
			],
			timeline: {
				10: [{ label: "urgent", created_at: daysAgo(1), actor: "owner" }],
			},
		});
		expect(r.order()).toEqual([11, 1]);
	});

	it("passes a plain ticket's urgency down its child, to that child's blocker, and on to the blocker's child (#3250)", async () => {
		// #10 urgent, a plain ticket, parent of #11; #20 blocks #11; #21 is
		// #20's child, so #20 is a heading and #21 the work.
		const fx = {
			issues: [
				{ number: 1 },
				{ number: 10, labels: ["urgent"] },
				{ number: 11, parent: 10 },
				{ number: 20 },
				{ number: 21, parent: 20 },
			],
			deps: { 11: [{ number: 20, state: "open" as const }] },
			timeline: {
				10: [{ label: "urgent", created_at: daysAgo(1), actor: "owner" }],
			},
		};
		const rows = (await run(fx, ["--json"])).json().frontier;
		expect(rows.map((f: { number: number }) => f.number)).toEqual([21, 1]);
		expect(rows[0]).toMatchObject({
			urgent: true,
			urgentVia: { number: 10, path: ["#20", "#11", "#10"] },
		});
	});

	it("passes an urgent map's tier through its child to that child's blocker (#3222)", async () => {
		// #10 urgent map, its child #11, which #20 blocks. #1 outranks #20 on
		// reach, so only the inherited tier can lift #20 above it.
		const fx = {
			issues: [
				{ number: 1 },
				{ number: 2 },
				{ number: 3 },
				{ number: 10, labels: ["wayfinder:map", "urgent"] },
				{ number: 11, parent: 10 },
				{ number: 20 },
			],
			deps: {
				2: [{ number: 1, state: "open" as const }],
				3: [{ number: 1, state: "open" as const }],
				11: [{ number: 20, state: "open" as const }],
			},
			timeline: {
				10: [{ label: "urgent", created_at: daysAgo(1), actor: "owner" }],
			},
		};
		const rows = (await run(fx, ["--json"])).json().frontier;
		expect(rows.map((f: { number: number }) => f.number)).toEqual([20, 1]);
		expect(rows[0]).toMatchObject({
			urgent: true,
			urgentVia: { number: 10, path: ["#11", "#10"] },
			depth: 1,
			reach: 1,
		});
		const text = await run(fx);
		expect(text.out).toMatch(
			/^ {2}#20 {2}urgent via #10 \(holds #11 → #10\)$/m,
		);
	});

	it("ranks the deeper blocker of an urgent issue above the wider one (#3222)", async () => {
		// #30 urgent, blocked by #31 and #32; #33 blocks #31. #32 also holds
		// #40 and #41, so it leads on reach (3 to 2); depth (2 to 1) must win.
		const fx = {
			issues: [30, 31, 32, 33, 40, 41].map((number) => ({
				number,
				...(number === 30 ? { labels: ["urgent"] } : {}),
			})),
			deps: {
				30: [
					{ number: 31, state: "open" as const },
					{ number: 32, state: "open" as const },
				],
				31: [{ number: 33, state: "open" as const }],
				40: [{ number: 32, state: "open" as const }],
				41: [{ number: 32, state: "open" as const }],
			},
			timeline: {
				30: [{ label: "urgent", created_at: daysAgo(1), actor: "owner" }],
			},
		};
		const rows = (await run(fx, ["--json"])).json().frontier;
		expect(rows.map((f: { number: number }) => f.number)).toEqual([33, 32]);
		expect(rows[0]).toMatchObject({ urgent: true, depth: 2, reach: 2 });
		expect(rows[1]).toMatchObject({ urgent: true, depth: 1, reach: 3 });
	});

	it("passes goal-set membership to every issue holding a member out (#3222)", async () => {
		// #2 blocks #3, whose parent #5 is the goal; #1 holds nothing.
		const r = await run(
			{
				issues: [
					{ number: 1 },
					{ number: 2 },
					{ number: 3, parent: 5 },
					{ number: 5 },
				],
				deps: { 3: [{ number: 2, state: "open" as const }] },
			},
			["--goal", "5", "--json"],
		);
		const rows = r.json().frontier;
		expect(rows.map((f: { number: number }) => f.number)).toEqual([2, 1]);
		expect(rows[0]).toMatchObject({
			goal: true,
			goalVia: { number: 5, path: ["#3", "#5"] },
		});
		expect(rows[1]).toMatchObject({ goal: false, goalVia: null, depth: 0 });
	});

	it("ranks an unlabelled bug above an urgent non-bug (#2664)", async () => {
		const r = await run(
			{
				issues: [
					{ number: 1 },
					{ number: 2, labels: ["urgent"] },
					{ number: 3, labels: ["bug"] },
				],
				timeline: {
					2: [{ label: "urgent", created_at: daysAgo(1), actor: "owner" }],
				},
			},
			["--json"],
		);
		const rows = r.json().frontier;
		expect(rows.map((f: { number: number }) => f.number)).toEqual([3, 2, 1]);
		expect(rows[0]).toMatchObject({ bug: true, urgent: true, urgentVia: null });
	});

	it("flags an empty or whitespace-only body on the frontier under EMPTY BODY, naming each issue in text and JSON, excluding nothing (mantahostels#3443)", async () => {
		const fx = {
			issues: [
				{ number: 1, body: "Real work." },
				{ number: 2 },
				{ number: 3, body: " \n\t\n" },
			],
		};
		const text = await run(fx);
		expect(text.out).toMatch(/EMPTY BODY/);
		expect(text.out).toMatch(/^ {2}#2 {2}issue 2$/m);
		expect(text.out).toMatch(/^ {2}#3 {2}issue 3$/m);
		expect(text.out).not.toMatch(/^ {2}#1 {2}issue 1$/m);
		expect(text.order()).toEqual([1, 2, 3]);

		const json = (await run(fx, ["--json"])).json();
		expect(json.emptyBody).toEqual([
			{ number: 2, title: "issue 2" },
			{ number: 3, title: "issue 3" },
		]);
	});

	it("prints no EMPTY BODY block when every frontier body has text", async () => {
		const r = await run({ issues: [{ number: 1, body: "Real work." }] });
		expect(r.out).not.toMatch(/EMPTY BODY/);
	});

	it("ranks an urgent whose timeline is unreachable, saying its start is unrecorded", async () => {
		const r = await run({
			issues: [{ number: 1 }, { number: 3, labels: ["urgent"] }],
			failTimeline: [3],
		});
		expect(r.order()).toEqual([3, 1]);
		expect(r.out).toMatch(/^ {2}#3 {2}URGENT — start unrecorded$/m);
	});

	it("puts the goal band above reach, keeping the high-reach issue on screen", async () => {
		// mantahostels#106 (how a stated goal reweights the queue) accepted this consequence:
		// draining a goal set lifts a reach-0 member above the most load-bearing
		// issue on the tracker, which must still print beneath the band.
		const r = await run(
			{
				issues: [{ number: 22 }, { number: 25 }, { number: 116 }],
				deps: { 25: [{ number: 22, state: "open" }] },
			},
			["--goal", "116"],
		);
		expect(r.order()).toEqual([116, 22]);
		expect(r.out).toMatch(/GOAL SET \(1\): #116/);
	});

	it("breaks a tie within each ticket-type band toward the ticket that writes no repo file", async () => {
		const r = await run({
			issues: [
				{ number: 1, labels: ["kind:ticket"] },
				{ number: 2, labels: ["wayfinder:grilling", "takes:wayfinder"] },
				{ number: 3, labels: ["wayfinder:research"] },
				{ number: 4, labels: ["takes:wayfinder"] },
			],
		});
		// All four tie at reach 0; within each type band only collision orders them.
		expect(r.order()).toEqual([2, 4, 3, 1]);
	});

	/* #2001. */
	it("puts a question-asking ticket above an implement ticket with higher reach", async () => {
		// Issue 2 outranks every other on reach; delete the type level and it leads.
		const r = await run(
			{
				issues: [
					{ number: 1, labels: ["wayfinder:grilling", "takes:wayfinder"] },
					{ number: 2, labels: ["kind:ticket", "takes:implement"] },
					{ number: 3 },
					{ number: 4, labels: ["wayfinder:prototype", "takes:wayfinder"] },
					{ number: 5, labels: ["takes:wayfinder"] },
					{ number: 6, labels: ["wayfinder:map", "takes:wayfinder"] },
					{ number: 7, labels: ["wayfinder:grilling", "takes:implement"] },
				],
				deps: { 3: [{ number: 2, state: "open" }] },
			},
			["--json"],
		);
		const frontier = r.json().frontier;
		expect(frontier.map((i: { number: number }) => i.number)).toEqual([
			1, 4, 5, 2, 7, 6,
		]);
		expect(frontier[0].asksQuestions).toBe(true);
		expect(frontier[3].reach).toBe(1);
		expect(frontier[3].asksQuestions).toBe(false);
		// A `takes:` value overrides the type label that disagrees with it.
		expect(frontier[4].asksQuestions).toBe(false);
		// A map asks nothing by itself, though it takes /wayfinder.
		expect(frontier[5].asksQuestions).toBe(false);
	});

	it("keeps an urgent, the goal set and a stalled wait above the type level", async () => {
		const r = await run(
			{
				issues: [
					{ number: 1, labels: ["wayfinder:grilling", "takes:wayfinder"] },
					{ number: 4, labels: ["takes:implement"] },
					{ number: 2, labels: ["urgent", "takes:implement"] },
					{ number: 3, labels: ["waiting:external", "takes:implement"] },
				],
				timeline: {
					2: [{ label: "urgent", created_at: daysAgo(1), actor: "owner" }],
					3: [
						{
							label: "waiting:external",
							created_at: daysAgo(30),
							actor: "owner",
						},
					],
				},
			},
			["--goal", "4"],
		);
		expect(r.order()).toEqual([2, 4, 3, 1]);
	});

	it("falls back to issue number when every other level ties", async () => {
		const r = await run({
			issues: [{ number: 9 }, { number: 4 }, { number: 7 }],
		});
		expect(r.order()).toEqual([4, 7, 9]);
	});

	it("hands each frontier row's creation date to the merge across repos", async () => {
		const r = await run(
			{ issues: [{ number: 4, createdAt: "2026-01-02T03:04:05Z" }] },
			["--json"],
		);
		expect(r.json().frontier[0].createdAt).toBe("2026-01-02T03:04:05Z");
	});
});

/* mantahostels#227, which gave the `takes:` label its first reader. */
describe("the takes: column", () => {
	it("shows each shortlisted issue's takes: value", async () => {
		const r = await run({
			issues: [
				{ number: 1, labels: ["takes:implement"] },
				{ number: 2, labels: ["takes:wayfinder"] },
			],
		});
		expect(r.out).toMatch(/^#1\s.*\simplement\s/m);
		expect(r.out).toMatch(/^#2\s.*\swayfinder\s/m);
		expect(r.out).toMatch(/TAKES/);
	});

	it("prints `none` rather than a blank when the label is missing", async () => {
		// Every open issue carries exactly one, so absence is a fault to see, not
		// a state.
		const r = await run({ issues: [{ number: 1 }] });
		expect(r.out).toMatch(/^#1\s.*\snone\s/m);
	});

	it("shows both when an issue wrongly carries two", async () => {
		const r = await run({
			issues: [{ number: 1, labels: ["takes:implement", "takes:triage"] }],
		});
		expect(r.out).toMatch(/implement\+triage/);
	});

	it("never lets the label reach the ordering", async () => {
		// Display only: mantahostels#111 rejected selection writing `takes:`.
		const r = await run({
			issues: [
				{ number: 9, labels: ["takes:human"] },
				{ number: 4 },
				{ number: 7, labels: ["takes:implement"] },
			],
		});
		expect(r.order()).toEqual([4, 7, 9]);
	});

	it("carries the value into --json", async () => {
		const r = await run(
			{ issues: [{ number: 1, labels: ["takes:to-spec"] }] },
			["--json"],
		);
		expect(r.json().frontier[0].takes).toEqual(["to-spec"]);
	});
});

/*
 * mantahostels#259: the shape `waiting:external` defends against is mantahostels#85 (no working channel
 * to an outside partner), whose request stalled with nothing surfacing the
 * silence.
 */
describe("the waiting:external escalation", () => {
	const waiting = (n: number, days: number) => ({
		[n]: [
			{
				label: "waiting:external",
				created_at: daysAgo(days),
				actor: "owner",
			},
		],
	});

	it("lifts a stalled wait above a higher-reach issue, and prints the days", async () => {
		// Delete the stall level from the sort and mantahostels#2 wins on reach.
		const r = await run({
			issues: [
				{ number: 1, labels: ["waiting:external"] },
				{ number: 2 },
				{ number: 3 },
			],
			deps: { 3: [{ number: 2, state: "open" }] },
			timeline: waiting(1, 40),
		});
		expect(r.order()).toEqual([1, 2]);
		expect(r.out).toMatch(/^#1\s+40d!\s/m);
		expect(r.out).toMatch(/#1\s+40d, since .* by owner — STALLED, ranked up/);
	});

	it("puts a longer stall above a shorter one", async () => {
		const r = await run({
			issues: [
				{ number: 1, labels: ["waiting:external"] },
				{ number: 2, labels: ["waiting:external"] },
			],
			timeline: { ...waiting(1, 20), ...waiting(2, 60) },
		});
		expect(r.order()).toEqual([2, 1]);
	});

	it("leaves a wait under the threshold ranked exactly as an unlabelled one", async () => {
		const r = await run({
			issues: [
				{ number: 1, labels: ["waiting:external"] },
				{ number: 2 },
				{ number: 3 },
			],
			deps: { 3: [{ number: 2, state: "open" }] },
			timeline: waiting(1, 3),
		});
		expect(r.order()).toEqual([2, 1]);
		expect(r.out).toMatch(/^#1\s+3d\s/m);
	});

	it("escalates on either side of the 7-day threshold", async () => {
		// `daysAgo(7)` drifts by the milliseconds between building the fixture
		// and reading the clock, so asserting on exactly 7 is a coin toss.
		// mantahostels#2 outranks mantahostels#1 on reach, so only a firing stall can invert the pair.
		const pair = [
			{ number: 1, labels: ["waiting:external"] },
			{ number: 2 },
			{ number: 3 },
		];
		const deps = { 3: [{ number: 2, state: "open" as const }] };

		const under = await run({ issues: pair, deps, timeline: waiting(1, 6.9) });
		expect(under.order()).toEqual([2, 1]);
		expect(under.out).toMatch(/^#1\s+6d\s/m);

		const over = await run({ issues: pair, deps, timeline: waiting(1, 7.1) });
		expect(over.order()).toEqual([1, 2]);
		expect(over.out).toMatch(/^#1\s+7d!\s/m);
	});

	it("keeps an urgent and the goal set above even a long stall", async () => {
		// Both are what a human just said matters; the stall is inferred.
		const r = await run(
			{
				issues: [
					{ number: 1, labels: ["waiting:external"] },
					{ number: 2, labels: ["urgent"] },
					{ number: 3 },
				],
				timeline: {
					...waiting(1, 60),
					2: [{ label: "urgent", created_at: daysAgo(1), actor: "owner" }],
				},
			},
			["--goal", "3"],
		);
		expect(r.order()).toEqual([2, 3, 1]);
	});

	it("keeps a waiting issue in the shortlist", async () => {
		const r = await run({
			issues: [{ number: 1, labels: ["waiting:external"] }, { number: 2 }],
			timeline: waiting(1, 60),
		});
		expect(r.order()).toContain(1);
	});

	it("still shows the wait on an issue the shortlist excludes", async () => {
		// mantahostels#85 was claimed while its silence ran, so the rank level cannot reach it.
		const r = await run({
			issues: [
				{ number: 85, labels: ["waiting:external"], assignees: ["owner"] },
				{ number: 2 },
			],
			claims: { 85: "self" },
			timeline: waiting(85, 44),
		});
		expect(r.order()).not.toContain(85);
		expect(r.out).toMatch(/#85\s+44d, since/);
		expect(r.out).toMatch(/not in the shortlist: claimed by owner/);
	});

	it("leaves the rank untouched when the label's start is unreadable", async () => {
		const r = await run({
			issues: [
				{ number: 1, labels: ["waiting:external"] },
				{ number: 2 },
				{ number: 3 },
			],
			deps: { 3: [{ number: 2, state: "open" }] },
			failTimeline: [1],
		});
		expect(r.order()).toEqual([2, 1]);
		expect(r.out).toMatch(/^#1\s+\?\s/m);
		expect(r.out).toMatch(/#1\s+age unknown \(.*\) — rank untouched/);
	});

	it("reads the timeline once for an issue carrying both age-sensitive labels", async () => {
		const r = await run({
			issues: [{ number: 1, labels: ["waiting:external", "urgent"] }],
			timeline: {
				1: [
					{ label: "waiting:external", created_at: daysAgo(40), actor: "a" },
					{ label: "urgent", created_at: daysAgo(1), actor: "a" },
				],
			},
		});
		expect(r.calls().filter((c) => /timeline/.test(c))).toHaveLength(1);
		expect(r.out).toMatch(/^#1\s+yes\s+40d!\s/m);
	});

	it("never writes the label — no method, no labels endpoint", async () => {
		const r = await run({
			issues: [{ number: 1, labels: ["waiting:external"] }],
			timeline: waiting(1, 60),
		});
		for (const call of r.calls())
			expect(call).not.toMatch(/(^|\s)(-X|--method)(\s|$)/);
		expect(restCalls(r.calls()).join("\n")).not.toMatch(/labels/);
		expectGraphqlReadsOnly(r.calls());
	});

	it("carries the wait into --json, excluded issues included", async () => {
		const r = await run(
			{
				issues: [
					{ number: 85, labels: ["waiting:external"], assignees: ["luc"] },
					{ number: 90, labels: ["waiting:external"] },
				],
				claims: { 85: "self" },
				timeline: { ...waiting(85, 44), ...waiting(90, 2) },
			},
			["--json"],
		);
		const w = r.json().waiting;
		expect(w.map((x: { number: number }) => x.number)).toEqual([85, 90]);
		expect(w[0].stalled).toBe(true);
		expect(w[0].excluded).toBe("claimed by luc");
		expect(w[1].stalled).toBe(false);
		expect(w[1].excluded).toBe(null);
	});
});

/*
 * #2000, #2703: a parked ticket stays choosable; the refill loop holds it out
 * of a launch (lib/refill-decide.js). The PARKED block keeps the park from
 * going quiet.
 */
describe("the parked label", () => {
	const parked = (n: number, days: number) => ({
		[n]: [{ label: "parked", created_at: daysAgo(days), actor: "owner" }],
	});

	it("keeps a parked ticket choosable and lists it under PARKED with its age", async () => {
		const r = await run({
			issues: [
				{ number: 1, labels: ["takes:wayfinder", "parked"] },
				{ number: 2, labels: ["takes:implement"] },
			],
			timeline: parked(1, 3),
		});
		expect([...r.order()].sort()).toEqual([1, 2]);
		expect(r.out).toMatch(/^PARKED — /m);
		expect(r.out).toMatch(/#1\s+3d, since \S+/);
		expect(r.out).toMatch(
			/Choosable here; the refill loop never launches it\./,
		);
		expect(r.out).toMatch(/open tally +2 open, 2 frontier/);
	});

	it("puts a parked ticket on the --json frontier and in its parked list", async () => {
		const r = await run(
			{
				issues: [{ number: 1, labels: ["parked"] }, { number: 2 }],
				timeline: parked(1, 3),
			},
			["--json"],
		);
		const j = r.json();
		expect(j.frontier.map((x: { number: number }) => x.number)).toContain(1);
		expect(j.parked.map((x: { number: number }) => x.number)).toEqual([1]);
	});

	it("lists a parked ticket another limb excludes, oldest park first", async () => {
		const r = await run(
			{
				issues: [
					{ number: 1, labels: ["parked"] },
					{ number: 2, labels: ["parked"], assignees: ["owner"] },
				],
				claims: { 2: "self" },
				timeline: { ...parked(1, 1), ...parked(2, 9) },
			},
			["--json"],
		);
		const p = r.json().parked;
		expect(p.map((x: { number: number }) => x.number)).toEqual([2, 1]);
		expect(p[0].days).toBe(9);
		expect(p[0].ageUnknown).toBe(null);
	});

	it("says the age is unknown where the timeline is unreadable", async () => {
		const r = await run({
			issues: [{ number: 1, labels: ["parked"] }, { number: 2 }],
			failTimeline: [1],
		});
		expect(r.out).toMatch(/#1\s+age unknown \(/);
	});
});

describe("possible file collisions", () => {
	/** The shortlist table alone. */
	const table = (out: string) => out.split("-".repeat(106))[1].split("\n\n")[0];

	it("reports two shortlisted issues whose bodies name the same tracked file", async () => {
		stubRepo(["scripts/lib/guard-log.sh", "scripts/pick-next.js"]);
		const r = await run({
			issues: [
				{ number: 181, body: "rework `scripts/lib/guard-log.sh`" },
				{ number: 183, body: "the parser in `scripts/lib/guard-log.sh`" },
				{ number: 184, body: "nothing shared here: `scripts/pick-next.js`" },
			],
		});
		expect(r.out).toMatch(
			/possible collision: #181 <-> #183 on scripts\/lib\/guard-log\.sh/,
		);
		expect(r.out.match(/possible collision:/g)).toHaveLength(1);
	});

	it("resolves a bare filename by unique suffix, which is how bodies write it", async () => {
		// The measured pairs name `session-arbiter.js`, never its full path.
		stubRepo(["scripts/session-arbiter.js"]);
		const r = await run({
			issues: [
				{ number: 159, body: "extract `session-arbiter.js`'s store" },
				{ number: 174, body: "`session-arbiter.js` reads an unreadable store" },
			],
		});
		expect(r.out).toMatch(
			/possible collision: #159 <-> #174 on scripts\/session-arbiter\.js/,
		);
	});

	it("ignores a backticked token that is no tracked file", async () => {
		// Existence is the whole precision filter: prose is full of backticks.
		stubRepo(["scripts/pick-next.js"]);
		const r = await run({
			issues: [
				{ number: 1, body: "see `not-a-file.js` and `--json` and `gh`" },
				{ number: 2, body: "see `not-a-file.js` too" },
			],
		});
		expect(r.out).not.toMatch(/possible collision/);
	});

	it("ignores a directory, which git never lists", async () => {
		stubRepo(["scripts/lib/gh.js"]);
		const r = await run({
			issues: [
				{ number: 1, body: "everything under `scripts/lib`" },
				{ number: 2, body: "also `scripts/lib`" },
			],
		});
		expect(r.out).not.toMatch(/possible collision/);
	});

	it("prefers an exact tracked path over the files nested beneath it", async () => {
		// Without exact-first, a root README.md loses to its own nested namesakes
		// and resolves to nothing — this repo has three.
		stubRepo(["README.md", "app/README.md", "docs/README.md"]);
		const r = await run({
			issues: [
				{ number: 1, body: "rewrite `README.md`" },
				{ number: 2, body: "also `README.md`" },
			],
		});
		expect(r.out).toMatch(/possible collision: #1 <-> #2 on README\.md/);
	});

	it("pairs the whole frontier, not just the rows --limit prints", async () => {
		// The skill invokes the script with --limit, so pairing the printed slice
		// would hide exactly the collisions a long frontier creates.
		stubRepo(["scripts/a.js"]);
		const r = await run(
			{
				issues: [
					{ number: 1 },
					{ number: 2, body: "`scripts/a.js`" },
					{ number: 3, body: "`scripts/a.js`" },
				],
			},
			["--limit", "1"],
		);
		expect(r.order()).toEqual([1]);
		expect(r.out).toMatch(/possible collision: #2 <-> #3 on scripts\/a\.js/);
	});

	it("ignores an ambiguous filename rather than guessing which file it meant", async () => {
		stubRepo(["a/index.ts", "b/index.ts"]);
		const r = await run({
			issues: [
				{ number: 1, body: "rewrite `index.ts`" },
				{ number: 2, body: "also `index.ts`" },
			],
		});
		expect(r.out).not.toMatch(/possible collision/);
	});

	it("matches only on a path boundary, never mid-filename", async () => {
		// `a.js` must not resolve to scripts/data.js on a bare endsWith.
		stubRepo(["scripts/data.js"]);
		const r = await run({
			issues: [
				{ number: 1, body: "rewrite `a.js`" },
				{ number: 2, body: "also `a.js`" },
			],
		});
		expect(r.out).not.toMatch(/possible collision/);
	});

	it("finds a path inside a backticked command line", async () => {
		stubRepo(["scripts/a.js"]);
		const r = await run({
			issues: [
				{ number: 1, body: "run `node scripts/a.js --json`" },
				{ number: 2, body: "edit `scripts/a.js`" },
			],
		});
		expect(r.out).toMatch(/possible collision: #1 <-> #2 on scripts\/a\.js/);
	});

	it("leaves the shortlist byte-identical — it annotates, it never sorts", async () => {
		// mantahostels#192 (this annotation) changed none of mantahostels#106's five sort levels.
		stubRepo(["scripts/a.js", "scripts/b.js"]);
		const issues = [{ number: 4 }, { number: 7 }, { number: 9 }];
		const bare = await run({ issues });
		// Deliberately uneven path counts: any level keyed on them would reorder.
		const bodies: Record<number, string> = {
			4: "`scripts/a.js`",
			7: "`scripts/a.js` and `scripts/b.js`",
			9: "`scripts/a.js`",
		};
		const annotated = await run({
			issues: issues.map((i) => ({ ...i, body: bodies[i.number] })),
		});
		expect(table(annotated.out)).toBe(table(bare.out));
		expect(annotated.order()).toEqual([4, 7, 9]);
		expect(annotated.out).toMatch(/possible collision: #4 <-> #7/);
		expect(annotated.out).toMatch(/possible collision: #4 <-> #9/);
		expect(annotated.out).toMatch(/possible collision: #7 <-> #9/);
	});

	it("says so, and still prints a shortlist, when the tracked files are unreadable", async () => {
		stubBrokenRepo();
		const r = await run({
			issues: [
				{ number: 1, body: "`scripts/a.js`" },
				{ number: 2, body: "`scripts/a.js`" },
			],
		});
		expect(r.status).toBe(0);
		expect(r.order()).toEqual([1, 2]);
		expect(r.out).toMatch(/POSSIBLE FILE COLLISIONS — unavailable/);
		expect(r.out).not.toMatch(/possible collision:/);
	});

	it("carries the pairs and each issue's paths into JSON", async () => {
		stubRepo(["scripts/a.js", "scripts/b.js"]);
		const r = await run(
			{
				issues: [
					{ number: 1, body: "`scripts/a.js` and `scripts/b.js`" },
					{ number: 2, body: "`scripts/a.js`" },
				],
			},
			["--json"],
		);
		const j = r.json();
		expect(j.possibleCollisions).toEqual([
			{ a: 1, b: 2, paths: ["scripts/a.js"] },
		]);
		expect(j.frontier[0].pathsNamed).toEqual(["scripts/a.js", "scripts/b.js"]);
		expect(j.pathsUnavailable).toBe(null);
	});

	it("suppresses a pair sharing only docs/doc-map.md behind a summary count", async () => {
		// The doc-map-only wall the skill tells the reader to discount (.claude/skills/pick-next/SKILL.md; mantahostels#593).
		stubRepo(["docs/doc-map.md"]);
		const r = await run({
			issues: [
				{ number: 1, body: "stamp `docs/doc-map.md`" },
				{ number: 2, body: "also `docs/doc-map.md`" },
				{ number: 3, body: "and `docs/doc-map.md`" },
			],
		});
		expect(r.out).not.toMatch(/possible collision:/);
		expect(r.out).toMatch(
			/3 pairs sharing only a stamp path \(docs\/doc-map\.md\) suppressed;/,
		);
		// No body names a §B entry, so no DOC-MAP QUEUE prints — and the summary
		// must not point at a block that is not there.
		expect(r.out).not.toMatch(/DOC-MAP QUEUE/);
	});

	it("suppresses a pair sharing only CLAUDE.md, the other ruled stamp path (mantahostels#1301, mantahostels#1312)", async () => {
		stubRepo(["CLAUDE.md"]);
		const r = await run({
			issues: [
				{ number: 1, body: "stamp `CLAUDE.md`" },
				{ number: 2, body: "also `CLAUDE.md`" },
			],
		});
		expect(r.out).not.toMatch(/possible collision:/);
		expect(r.out).toMatch(
			/1 pair sharing only a stamp path \(CLAUDE\.md\) suppressed;/,
		);
		expect(r.out).not.toMatch(/docs\/doc-map\.md/);
	});

	it("does not point a CLAUDE.md-only suppression at the DOC-MAP QUEUE (mantahostels#1312)", async () => {
		stubRepo(["CLAUDE.md", "docs/doc-map.md"]);
		const r = await run({
			issues: [
				{ number: 1, body: "stamp `CLAUDE.md`" },
				{ number: 2, body: "also `CLAUDE.md`" },
				{ number: 3, body: "stamp `docs/doc-map.md` and §B2" },
			],
		});
		expect(r.out).toMatch(
			/1 pair sharing only a stamp path \(CLAUDE\.md\) suppressed; --json/,
		);
		expect(r.out).not.toMatch(
			/CLAUDE\.md\) suppressed — see the DOC-MAP QUEUE/,
		);
	});

	it("points the summary at the DOC-MAP QUEUE only when that block prints", async () => {
		stubRepo(["docs/doc-map.md"]);
		const r = await run({
			issues: [
				{ number: 1, body: "stamp `docs/doc-map.md` and §B2" },
				{ number: 2, body: "also `docs/doc-map.md`" },
			],
		});
		expect(r.out).toMatch(
			/1 pair sharing only a stamp path \(docs\/doc-map\.md\) suppressed — see the DOC-MAP QUEUE below;/,
		);
		expect(r.out).toMatch(/DOC-MAP QUEUE \(1\)/);
	});

	it("prints the band-read nominations, and nominates nobody off a stamp-only overlap (mantahostels#1484)", async () => {
		stubRepo(["scripts/a.js", "docs/doc-map.md"]);
		const r = await run({
			issues: [
				{ number: 1, body: "writes `scripts/a.js`" },
				{ number: 2, body: "also `scripts/a.js`" },
				{ number: 3, body: "stamp `docs/doc-map.md`" },
				{ number: 4, body: "also `docs/doc-map.md`" },
			],
		});
		// Both sides of the substrate overlap, and neither side of the stamp one.
		expect(r.out).toMatch(/BAND-READ NOMINATIONS \(2\)/);
		expect(r.out).toMatch(/#1 on scripts\/a\.js — with #2/);
		expect(r.out).toMatch(/#2 on scripts\/a\.js — with #1/);
		expect(r.out).not.toMatch(/#3 on /);
		expect(r.out).not.toMatch(/#4 on /);
	});

	it("still prints, in full, a pair sharing docs/doc-map.md plus a second path", async () => {
		stubRepo(["docs/doc-map.md", "scripts/a.js"]);
		const r = await run({
			issues: [
				{ number: 1, body: "`docs/doc-map.md` and `scripts/a.js`" },
				{ number: 2, body: "`docs/doc-map.md` and `scripts/a.js`" },
			],
		});
		expect(r.out).toMatch(
			/possible collision: #1 <-> #2 on docs\/doc-map\.md, scripts\/a\.js/,
		);
		expect(r.out).not.toMatch(/suppressed/);
	});

	it("keeps a suppressed pair in --json", async () => {
		stubRepo(["docs/doc-map.md"]);
		const r = await run(
			{
				issues: [
					{ number: 1, body: "`docs/doc-map.md`" },
					{ number: 2, body: "`docs/doc-map.md`" },
				],
			},
			["--json"],
		);
		expect(r.json().possibleCollisions).toEqual([
			{ a: 1, b: 2, paths: ["docs/doc-map.md"] },
		]);
	});

	it("adds no API call — the bodies come from the list call already made", async () => {
		stubRepo(["scripts/a.js"]);
		const withBodies = await run({
			issues: [
				{ number: 1, body: "`scripts/a.js`" },
				{ number: 2, body: "`scripts/a.js`" },
			],
		});
		expect(
			withBodies.calls().filter((c) => /issues\?state=open/.test(c)),
		).toHaveLength(1);
		expect(withBodies.calls().join("\n")).not.toMatch(/\/(files|contents)/);
	});
});

/*
 * mantahostels#384: continuous refill needs an admission decision, and a fixed five-slot
 * count cannot make one — a working session's cost varies (docs/environment.md), so
 * what is affordable depends on how loaded the machine is.
 */
describe("admission", () => {
	it("reports the measured headroom and the live session count", async () => {
		oracleSessions = ["self", "a@601", "b@602"];
		procPssKb = { "601": WORKING_PAIR_KB, "602": WORKING_PAIR_KB };
		psOut = [...sessionProcs("a"), ...sessionProcs("b")].join("\n");
		memAvailableKb = 3072 * 1024;
		const r = await run({ issues: [{ number: 1 }] });
		expect(r.out).toMatch(/available memory\s+3072 MB/);
		expect(r.out).toMatch(/live sessions\s+2 alongside this one \(4 claude/);
		expect(r.out).toMatch(
			new RegExp(
				`session draw\\s+mean ${FIXTURE_DRAW.sessionMeanMb} MB, σ ${FIXTURE_DRAW.sessionSigmaMb} MB`,
			),
		);
		expect(r.out).toMatch(
			/live draw\s+2 live session\(s\): mean 858 MB \+ 1\.645 × σ 218 MB − 1280 MB they already hold/,
		);
		// 3072 − 106 − 794 − 300 = 1872 MB, the 106 MB the one spare pair
		// reserved where none is idle; the live draw and 3 more need 1432 at
		// p95, and 4 more 1915.
		expect(r.out).toMatch(/free slots\s+3/);
		expect(r.out).toMatch(/START ONE NOW/);
	});

	it("lifts the free slots to the session floor and names it (#2507)", async () => {
		oracleSessions = ["self", "a@601", "b@602"];
		oracleWorking = ["a", "b"];
		procPssKb = { "601": WORKING_PAIR_KB, "602": WORKING_PAIR_KB };
		psOut = [...sessionProcs("a"), ...sessionProcs("b")].join("\n");
		memAvailableKb = 3072 * 1024;
		sessionFloor = "8";
		const r = await run({ issues: [{ number: 1 }] });
		// 3 working with this run, so 5 wanted; 1872 MB holds 4 at the 429 MB
		// mean, over the 3 the p95 draw leaves.
		expect(r.out).toMatch(
			/session floor\s+8 working sessions \(~\/\.claude\/session-floor, #2501\); 3 working, this run's own counted, so 4 floor slot\(s\)/,
		);
		expect(r.out).toMatch(/free slots\s+4/);
		expect(r.out).toMatch(
			/START ONE NOW — 4 free slots, FLOOR: 4 slot\(s\) toward the 8 working sessions .*, 3 working, over the p95 pricing/,
		);
		expect(r.out).toMatch(/raised to 4 by the session floor of 8/);
	});

	it("holds the session floor while swap and free memory are both short (#2690)", async () => {
		oracleSessions = ["self", "a@601", "b@602"];
		oracleWorking = ["a", "b"];
		procPssKb = { "601": WORKING_PAIR_KB, "602": WORKING_PAIR_KB };
		psOut = [...sessionProcs("a"), ...sessionProcs("b")].join("\n");
		meminfoText = `MemTotal: 8114464 kB\nMemAvailable: ${2100 * 1024} kB\nSwapTotal: ${2048 * 1024} kB\nSwapFree: ${245 * 1024} kB\n`;
		sessionFloor = "8";
		const r = await run({ issues: [{ number: 1 }] });
		expect(r.out).toMatch(
			/session floor\s+8 working sessions .*; 3 working, this run's own counted, so 0 floor slot\(s\), held while swap is 245 of 2048 MB free and 2100 MB available, under 25% and 2200 MB \(#2690\)/,
		);
		// the p95 slot stays: 794 MB holds the live draw and one more
		expect(r.out).toMatch(/free slots\s+1\n/);
	});

	it("holds every slot at the load ceiling, naming the load (#834)", async () => {
		oracleSessions = ["self", "a"];
		psOut = sessionProcs("a").join("\n");
		load1 = 60;
		const r = await run({ issues: [{ number: 1 }] });
		expect(r.out).toMatch(/cpu load\s+load1 60 is at or above the 48 ceiling/);
		expect(r.out).toMatch(/free slots\s+0/);
		expect(r.out).toMatch(/HOLD — load1 60 is at or above the 48 ceiling/);
		expect(r.out).toMatch(/held to 0 on CPU load/);
	});

	it("holds every slot at the session ceiling, naming it (#2141)", async () => {
		oracleSessions = ["self", "a"];
		psOut = "900 1000 claude bg-pty-host --session a";
		sessionCeiling = "1";
		const r = await run({ issues: [{ number: 1 }] });
		expect(r.out).toMatch(
			/cpu sessions\s+1 session\(s\) running on the machine against the 1-session CPU ceiling \(#2141\), so 0 slot\(s\) — dispatch refuses/,
		);
		expect(r.out).toMatch(/free slots\s+0/);
		expect(r.out).toMatch(/HOLD — 1 session\(s\) running on the machine/);
	});

	it("does not count an orphaned bg-pty-host as a live session", async () => {
		oracleSessions = ["self", "a"];
		psOut = [
			...sessionProcs("a"),
			...sessionProcs("gone-1"),
			...sessionProcs("gone-2"),
			...sessionProcs("gone-3"),
		].join("\n");
		const r = await run({ issues: [{ number: 1 }] });
		expect(r.out).toMatch(/live sessions\s+1 alongside this one/);
		expect(r.out).not.toMatch(/live sessions\s+4/);
	});

	it("leaves the count unknown when the oracle will not answer, never falling back to the scan", async () => {
		oracleFails = true;
		psOut = [...sessionProcs("a"), ...sessionProcs("b")].join("\n");
		const r = await run({ issues: [{ number: 1 }] });
		expect(r.status).toBe(0);
		expect(r.out).toMatch(/live sessions\s+unknown/);
		expect(r.out).toMatch(/4 claude processes/);
		expect(r.out).not.toMatch(/live sessions\s+2/);
		/* Unknown, never an idle machine's 0 MB (#337). */
		expect(r.out).toMatch(
			/live draw\s+unknown — the session listing was refused/,
		);
	});

	it("reflects a live failure on the second read rather than the first read's cached success (mantahostels#1946, mantahostels#1960, mantahostels#1983)", async () => {
		// Cache deliberately left ON (opts.oracleCache) for this one case: with it
		// off, as every other test in this file runs, the seam this pins is never
		// exercised at all. Both calls become their own leader — sequential, not
		// concurrent, so neither is ever a follower reading the other's write —
		// which is exactly the case a reintroduced plain cache-hit in
		// readListing() would answer wrongly: this pins that nothing in the
		// read path takes a leader's own record as an answer either.
		oracleSessions = ["self"];
		const first = await run({ issues: [{ number: 1 }] }, [], {
			oracleCache: true,
		});
		expect(first.out).toMatch(/live sessions\s+0 alongside this one/);

		oracleFails = true;
		const second = await run({ issues: [{ number: 1 }] }, [], {
			oracleCache: true,
		});
		expect(second.out).toMatch(/live sessions\s+unknown/);
		expect(second.out).not.toMatch(/live sessions\s+0 alongside this one/);
	});

	it("subtracts this run's own session, so a lone session still admits one", async () => {
		oracleSessions = ["self"];
		memAvailableKb = 50 * 1024;
		const r = await run({ issues: [{ number: 1 }] });
		expect(r.out).toMatch(/live sessions\s+0 alongside this one/);
		expect(r.out).toMatch(/START ONE NOW — no session is running/);
	});

	it("prints a process count matching the bare name, `claude.exe` and the launcher path", async () => {
		// The binary lives in .../versions/2.1.233, so `ps` reports comm
		// `2.1.233` and only argv[0] says `claude`.
		psOut = [
			...sessionProcs("a"),
			...sessionProcs("b", "/usr/bin/claude.exe"),
			buildPsLine("2.1.233", "/home/lucmo/.local/bin/claude daemon run"),
			buildPsLine("node", "node scripts/pick-next.js"),
			buildPsLine("clauded", "clauded --not-ours"),
		].join("\n");
		const r = await run({ issues: [{ number: 1 }] });
		expect(r.out).toMatch(/\(5 claude processes/);
	});

	it("counts the versioned binary a resumed session re-execs, whose basename is a version", async () => {
		psOut = [
			...sessionProcs("a"),
			buildPsLine(
				"2.1.234",
				"/home/lucmo/.local/share/claude/versions/2.1.234 --resume /home/lucmo/.claude/projects/p/s.jsonl",
			),
			// Some other tool's versions directory is not ours.
			buildPsLine(
				"2.1.234",
				"/opt/acme/versions/2.1.234 --resume nothing-of-ours",
			),
		].join("\n");
		const r = await run({ issues: [{ number: 1 }] });
		expect(r.out).toMatch(/\(3 claude processes/);
	});

	it("holds when the headroom is under one slot and sessions are live", async () => {
		oracleSessions = ["self", "a@601"];
		procPssKb = { "601": WORKING_PAIR_KB };
		psOut = sessionProcs("a").join("\n");
		memAvailableKb = 400 * 1024;
		const r = await run({ issues: [{ number: 1 }] });
		expect(r.out).toMatch(/free slots\s+0/);
		expect(r.out).toMatch(
			/HOLD — -906 MB available after reserving 212 MB for the spare pool, holding 794 \+ 300 MB above earlyoom's kill line, under the 577 MB the live sessions' draw and one more need at p95/,
		);
		expect(r.out).not.toMatch(/START ONE NOW/);
		// A hold is about the machine, not the tracker: the shortlist still prints.
		expect(r.status).toBe(0);
		expect(r.order()).toEqual([1]);
	});

	it("admits one when no session is running, however tight the memory", async () => {
		// A daemon and a host are claude processes but not sessions, so the
		// oracle reports none alongside and the guarantee admits one anyway.
		psOut = [
			buildPsLine("claude", "claude daemon run --origin transient"),
			buildPsLine("claude", "/home/lucmo/.local/bin/claude agents"),
		].join("\n");
		memAvailableKb = 50 * 1024;
		const r = await run({ issues: [{ number: 1 }] });
		expect(r.out).toMatch(/live sessions\s+0/);
		expect(r.out).toMatch(/START ONE NOW — no session is running/);
		expect(r.out).not.toMatch(/HOLD/);
	});

	it("says so and still admits when the headroom cannot be read", async () => {
		memAvailableKb = null;
		oracleSessions = ["self", "a"];
		const r = await run({ issues: [{ number: 1 }] });
		expect(r.status).toBe(0);
		expect(r.out).toMatch(/available memory\s+unknown/);
		expect(r.out).toMatch(/START ONE NOW — headroom unmeasured/);
	});

	it("says why the process count is missing when `ps` fails, and still counts sessions", async () => {
		psFails = true;
		oracleSessions = ["self", "a"];
		const r = await run({ issues: [{ number: 1 }] });
		expect(r.status).toBe(0);
		expect(r.out).toMatch(/live sessions\s+1 alongside this one/);
		expect(r.out).toMatch(/process count unavailable: .+/);
		expect(r.out).not.toMatch(/claude processes/);
	});

	/*
	 * Without `CLAUDE_CODE_SESSION_ID` neither the subtraction nor the reader's
	 * own self-test can pick this run out of the list.
	 */
	it("treats a lone listed session as this one when the session id is unset", async () => {
		oracleSelfId = "";
		oracleSessions = ["whoever"];
		memAvailableKb = 50 * 1024;
		const r = await run({ issues: [{ number: 1 }] });
		expect(r.out).toMatch(/live sessions\s+0 alongside this one/);
		expect(r.out).toMatch(/START ONE NOW — no session is running/);
	});

	it("subtracts nothing from several listed sessions when the session id is unset", async () => {
		oracleSelfId = "";
		oracleSessions = ["a", "b", "c"];
		const r = await run({ issues: [{ number: 1 }] });
		expect(r.out).toMatch(/live sessions\s+3 alongside this one/);
	});

	/* This run never reaps (mantahostels#1029); it says what a reap would be worth, so a low
	 * headroom reading is not read as permanently spent. */
	it("names the finished-but-resident pool, and the run that frees it now", async () => {
		oracleSessions = ["self", "a", "b"];
		oracleFinished = ["a", "b"];
		const r = await run({ issues: [{ number: 1 }] });
		expect(r.out).toMatch(/reclaimable\s+2 finished sessions still resident/);
		/* The plain run, never --dry-run: only a real run reports the MB it
		 * returned. */
		expect(r.out).toMatch(/`node scripts\/reap-finished-sessions\.js` stops/);
		expect(r.out).not.toMatch(/--dry-run/);
		expect(r.out).toMatch(/reports the MB returned/);
	});

	it("says session, not sessions, for a pool of one", async () => {
		oracleSessions = ["self", "a"];
		oracleFinished = ["a"];
		expect((await run({ issues: [{ number: 1 }] })).out).toMatch(
			/reclaimable\s+1 finished session still resident/,
		);
	});

	it("prints no reclaimable row when nothing has finished", async () => {
		oracleSessions = ["self", "a"];
		const r = await run({ issues: [{ number: 1 }] });
		expect(r.out).not.toMatch(/reclaimable/);
	});

	/* Counting itself would promise headroom that stopping it could never
	 * return. */
	it("never counts this run's own session as reclaimable", async () => {
		oracleSessions = ["self"];
		oracleFinished = ["self"];
		expect((await run({ issues: [{ number: 1 }] })).out).not.toMatch(
			/reclaimable/,
		);
	});

	/* Without an id this run cannot subtract itself. It refuses to count instead,
	 * as the reaper does on the same unset variable — and says so, rather than
	 * printing nothing a reader cannot tell from zero (mantahostels#1237, on mantahostels#1206). */
	it("prints the reclaimable row as unknown when this run has no session id", async () => {
		oracleSessions = ["self", "a"];
		oracleFinished = ["a"];
		oracleSelfId = "";
		const r = await run({ issues: [{ number: 1 }] });
		expect(r.out).toMatch(
			/reclaimable\s+unknown \(CLAUDE_CODE_SESSION_ID[^)]*\) — some of the memory counted spent above may already be free/,
		);
		const j = (await run({ issues: [{ number: 1 }] }, ["--json"])).json();
		expect(j.admission.reclaimable).toBeNull();
		expect(j.admission.reclaimableError).toMatch(/CLAUDE_CODE_SESSION_ID/);
	});

	it("charges a young neighbour the draw it has yet to reach (#2221)", async () => {
		oracleSessions = ["self", "a@601"];
		procPssKb = { "601": 300 * 1024 };
		memAvailableKb = 2900 * 1024;
		const r = await run({ issues: [{ number: 1 }] });
		// 429 + 1.645 × 154 − 300 held = 383 MB still to come; 2 more fit 1806.
		expect(r.out).toMatch(/free slots\s+2/);
		const j = (await run({ issues: [{ number: 1 }] }, ["--json"])).json();
		expect(j.admission.drawNeedMb).toBe(383);
	});

	/* An oracle that will not answer is the second way the probe fails, and it
	 * reads the same way to a human (mantahostels#1237). */
	it("prints the reclaimable row as unknown when the oracle will not answer", async () => {
		oracleFails = true;
		const r = await run({ issues: [{ number: 1 }] });
		expect(r.out).toMatch(
			/reclaimable\s+unknown \(.+\) — some of the memory counted spent above may already be free/,
		);
	});

	it("carries the count into --json, and the refusal where the oracle will not answer", async () => {
		oracleSessions = ["self", "a"];
		oracleFinished = ["a"];
		expect(
			(await run({ issues: [{ number: 1 }] }, ["--json"])).json().admission
				.reclaimable,
		).toBe(1);

		oracleFails = true;
		const j = (await run({ issues: [{ number: 1 }] }, ["--json"])).json();
		expect(j.admission.reclaimable).toBeNull();
		expect(typeof j.admission.reclaimableError).toBe("string");
	});

	it("carries the admission decision into --json", async () => {
		oracleSessions = ["self", "a@601", "b@602"];
		procPssKb = { "601": WORKING_PAIR_KB, "602": WORKING_PAIR_KB };
		psOut = [...sessionProcs("a"), ...sessionProcs("b")].join("\n");
		memAvailableKb = 3072 * 1024;
		const j = (await run({ issues: [{ number: 1 }] }, ["--json"])).json();
		expect(j.admission).toEqual({
			availableMb: 3072,
			availableUnknown: null,
			sessions: 2,
			claudeProcesses: 4,
			claudeProcessesUnknown: null,
			sessionsUnknown: null,
			...FIXTURE_DRAW,
			reclaimable: 0,
			reclaimableError: null,
			reservedMb: 2 * IDLE_PAIR_MB,
			reservedError: null,
			budgetMb: 1766,
			drawNeedMb: -63,
			freeSlots: 3,
			admit: true,
			reason: expect.stringContaining("3 free slot"),
		});
	});

	/* mantahostels#1295: a reader of --json must be able to reconstruct `freeSlots` the same
	 * way a human reads the reservedNote in `reason`. */
	it("carries the reservation into --json", async () => {
		oracleSessions = ["self", "a"];
		psOut = [
			...sessionProcs("a"),
			"111 605000 claude bg-spare --bg-spare /tmp/x/spare/abc.claim.sock",
		].join("\n");
		memAvailableKb = 4000 * 1024;
		procCwds = { "111": "/tmp/x/spare" };
		const j = (await run({ issues: [{ number: 1 }] }, ["--json"])).json();
		// the idle pair and the one a launch warms
		expect(j.admission.reservedMb).toBe(1180);
		expect(j.admission.reservedError).toBeNull();
	});

	it("reports the reservation as unreadable, never silently as zero, when the overhead scan fails", async () => {
		oracleSessions = ["self", "a"];
		psFails = true;
		const j = (await run({ issues: [{ number: 1 }] }, ["--json"])).json();
		expect(j.admission.reservedMb).toBe(0);
		expect(typeof j.admission.reservedError).toBe("string");
	});

	/*
	 * mantahostels#1295: this run's own ADMISSION block reserves the spare pool's pair
	 * too, off the SAME oracle read `listed` already made — `poolReserve`
	 * exactly as `scripts/admission.js` prices it.
	 */
	it("reserves one idle spare pair, shrinking the free-slot count", async () => {
		oracleSessions = ["self", "a@601"];
		procPssKb = { "601": WORKING_PAIR_KB };
		psOut = [
			...sessionProcs("a"),
			"111 605000 claude bg-spare --bg-spare /tmp/x/spare/abc.claim.sock",
		].join("\n");
		memAvailableKb = 4000 * 1024;
		procCwds = { "111": "/tmp/x/spare" };
		const r = await run({ issues: [{ number: 1 }] });
		// 4000 − 2 × 590 − 794 − 300 = 1726 MB: 2 more and a pair fit, 3 more and two do not.
		expect(r.out).toMatch(/free slots\s+2/);
		expect(r.out).toMatch(/reserving 1180 MB for the spare pool/);
	});

	it("does not reserve a claimed spare — a live session keeps its /spare/ path", async () => {
		oracleSessions = ["self", "a@601", "other@111"];
		procPssKb = { "601": WORKING_PAIR_KB, "111": WORKING_PAIR_KB };
		psOut = [
			...sessionProcs("a"),
			"111 605000 claude bg-spare --bg-spare /tmp/x/spare/abc.claim.sock",
		].join("\n");
		memAvailableKb = 4000 * 1024;
		const r = await run({ issues: [{ number: 1 }] });
		// No idle pair is left, so the reserve falls back to the measured one.
		expect(r.out).toMatch(
			new RegExp(`reserving ${2 * IDLE_PAIR_MB} MB for the spare pool`),
		);
		// 4000 − 212 − 794 − 300 = 2694 MB; the live draw and 5 more need 2393 and 4 pairs.
		expect(r.out).toMatch(/free slots\s+4/);
	});

	/*
	 * The always-admit-one branch computes `freeSlots` net of the reservation
	 * too, so its reason must name the reservation the same way the ordinary
	 * branch does — otherwise a reader sees a slot count they cannot
	 * reconstruct from the printed reason (mantahostels#1295).
	 */
	it("names the reservation in the always-admit-one reason too", async () => {
		oracleSessions = ["self"];
		psOut = [
			"111 605000 claude bg-spare --bg-spare /tmp/x/spare/abc.claim.sock",
		].join("\n");
		memAvailableKb = 4000 * 1024;
		procCwds = { "111": "/tmp/x/spare" };
		const r = await run({ issues: [{ number: 1 }] });
		expect(r.out).toMatch(/free slots\s+1/);
		expect(r.out).toMatch(
			/no session is running, so one is admitted whatever the headroom after reserving 1180 MB for the spare pool/,
		);
	});

	/*
	 * #590: the breakdown is `admission.js`'s, off the same function, so on
	 * one machine the two print the same rows. The fixture is `admission.js`'s
	 * own, read as `--launch` reads it, as selection prices its slots as
	 * launches (#2568), and with a reap plan returning no MB, as selection
	 * credits none.
	 */
	describe("the memory breakdown (#590)", () => {
		const fixture = JSON.parse(
			fs.readFileSync(
				path.join(__dirname, "fixtures", "admission-pre-589.json"),
				"utf8",
			),
		).admit as {
			meminfo: string;
			agents: Array<{ sessionId: string; pid: number; state: string }>;
			ps: string[];
			pss: Record<string, number>;
		};
		const selfSessionId = "self-session-id";

		const machine = (pss = fixture.pss) => {
			meminfoText = fixture.meminfo;
			/* The fixture's idle `aaa` pair, its spare in the claim socket's directory. */
			procCwds = { "112": "/tmp/x/spare" };
			psOut = fixture.ps.join("\n");
			oracleSelfId = selfSessionId;
			oracleSessions = fixture.agents.map((a) => `${a.sessionId}@${a.pid}`);
			oracleFinished = fixture.agents
				.filter((a) => a.state === "done")
				.map((a) => a.sessionId);
			for (const [pid, kb] of Object.entries(pss))
				writeSmapsRollup(path.join(dir, "proc"), pid, kb);
		};
		const breakdownOf = (out: string, indent = "") =>
			(out.match(/^ *memory {13}of [\s\S]*?slot arithmetic .*$/m)?.[0] ?? "")
				.split("\n")
				.map((l) => l.replace(indent, ""));
		const row = (rows: string[], label: string) =>
			rows.find((l) => l.startsWith(`  ${label} `));

		it("prints admission.js's rows, figure for figure", async () => {
			machine();
			const picked = await run({ issues: [{ number: 1 }] });

			const host = path.join(dir, "host");
			fs.mkdirSync(path.join(host, ".claude"), { recursive: true });
			fs.writeFileSync(
				path.join(host, ".claude", "workflow-core.json"),
				JSON.stringify(FIXTURE_DRAW),
			);
			const reap = path.join(dir, "fake-reap.js");
			fs.writeFileSync(
				reap,
				`process.stdout.write(${JSON.stringify(JSON.stringify({ reaped: [{ pss: 0 }], kept: [] }))});\n`,
			);
			const admitted = runInProcess(
				path.resolve(__dirname, "admission.js"),
				["--skip-allowance", "--launch"],
				{
					cwd: host,
					env: {
						PATH: process.env.PATH,
						HOME: dir,
						WFC_MEMINFO: path.join(dir, "meminfo"),
						WFC_PS: path.join(dir, "ps"),
						WFC_PROC: path.join(dir, "proc"),
						WFC_LOADAVG: path.join(dir, "loadavg"),
						WFC_LOAD_CEILING: "48",
						WFC_SESSION_CEILING: sessionCeiling,
						TMPDIR: dir,
						WFC_CLAUDE_BIN: path.join(dir, "claude"),
						WFC_REAP_SCRIPT: reap,
						CLAUDE_CODE_SESSION_ID: selfSessionId,
						CLAUDE_PROJECT_DIR: host,
						CLAUDE_CONFIG_DIR: path.join(dir, "no-such-config"),
					},
				},
			);

			const ours = breakdownOf(picked.out, "  ");
			const theirs = breakdownOf(admitted.stdout);
			expect(row(ours, "finished")).toMatch(/, 1 taken by the next reap$/);
			expect(row(ours, "slot arithmetic")).toMatch(
				/ = \d+ MB; the live sessions' draw needs \d+ MB of it, and with \d+ more, with \d+ more spare pair\(s\) at \d+ MB, \d+ MB, so \d+ slot\(s\)$/,
			);
			expect(ours).toEqual(theirs);
		});

		it("carries the same rows in --json, as admission.js's memory object", async () => {
			machine();
			const m = (await run({ issues: [{ number: 1 }] }, ["--json"])).json()
				.memory;
			expect(m.totalMb).toBe(10_000);
			expect(m.working).toEqual({ count: 2, mb: 957, unknown: null });
			expect(m.finished).toMatchObject({ count: 1, mb: 410, reapable: 1 });
		});

		it("prints an unreadable reading as unknown, never 0", async () => {
			const { "301": _, ...pss } = fixture.pss;
			machine(pss);
			const r = await run({ issues: [{ number: 1 }] });
			expect(r.out).toMatch(
				/ {2}working {10}unknown \(pid 301's smaps_rollup unreadable\)/,
			);
			expect(r.out).toMatch(
				/ {2}everything else {2}unknown \(a row above it is unknown\)/,
			);
		});
	});

	it("reads the machine without touching the tracker", async () => {
		const r = await run({ issues: [{ number: 1 }] });
		for (const call of r.calls())
			expect(call).not.toMatch(/(^|\s)(-X|--method)(\s|$)/);
	});
});

/*
 * mantahostels#1206: two local, read-only counts at the fragment layer one down from the
 * issue layer `pick-next` ranks — debt entries and stranded file claims,
 * neither of which carries an issue number so neither can join the sort.
 */
describe("owed work (mantahostels#1206)", () => {
	it("reports the debt-entry and stranded-claim counts, never as a filter or sort input", async () => {
		oracleSessions = ["self"];
		const r = await run({
			issues: [{ number: 1 }, { number: 2 }],
			debts: [
				{ path: "docs/doc-map.md", issue: 900, gist: "a" },
				{ path: "scripts/foo.js" },
			],
			staleFiles: {
				a: { path: "scripts/a.js", sessionId: "dead-1", hoursAgo: 24 },
			},
		});
		expect(r.out).toMatch(/debt entries\s+2/);
		expect(r.out).toMatch(/stranded claims\s+1/);
		// The shortlist order is untouched: neither count is a sort key.
		expect(r.order()).toEqual([1, 2]);
	});

	it("does not count a claim held by a listed session as stranded", async () => {
		oracleSessions = ["self", "live"];
		const r = await run({
			issues: [{ number: 1 }],
			staleFiles: {
				a: { path: "scripts/a.js", sessionId: "live", hoursAgo: 24 },
			},
		});
		expect(r.out).toMatch(/stranded claims\s+0/);
	});

	/* mantahostels#2765: a claim held by a session the oracle still lists but has marked
	 * finished ages into the count on the usual threshold, rather than staying
	 * exempt for ever. */
	it("counts a claim held by a listed-but-finished session, past the threshold", async () => {
		oracleSessions = ["self", "done-1"];
		oracleFinished = ["done-1"];
		const r = await run({
			issues: [{ number: 1 }],
			staleFiles: {
				a: { path: "scripts/a.js", sessionId: "done-1", hoursAgo: 24 },
			},
		});
		expect(r.out).toMatch(/stranded claims\s+1/);
	});

	it("does not count a claim younger than the strand threshold", async () => {
		oracleSessions = ["self"];
		const r = await run({
			issues: [{ number: 1 }],
			staleFiles: {
				a: { path: "scripts/a.js", sessionId: "dead-1", hoursAgo: 1 },
			},
		});
		expect(r.out).toMatch(/stranded claims\s+0/);
	});

	it("draws the strand boundary at 12 hours — mantahostels#1746's derived threshold", async () => {
		oracleSessions = ["self"];
		const r = await run({
			issues: [{ number: 1 }],
			staleFiles: {
				a: { path: "scripts/a.js", sessionId: "dead-1", hoursAgo: 11 },
				b: { path: "scripts/b.js", sessionId: "dead-2", hoursAgo: 13 },
			},
		});
		expect(r.out).toMatch(/stranded claims\s+1/);
	});

	it("prints unknown, never zero, when the running-session oracle cannot be read", async () => {
		oracleFails = true;
		const r = await run({ issues: [{ number: 1 }] });
		expect(r.out).toMatch(/stranded claims\s+unknown/);
		expect(r.out).not.toMatch(/stranded claims\s+0/);
	});

	/*
	 * #1390: the headline reads the admission block's own STRICT oracle read,
	 * as check-stranded-file-claims.js does. A listing that omits this run's
	 * session is a short one, where a live neighbour's claim would count as
	 * stranded, so both refuse on it.
	 */
	it("prints unknown for stranded claims, as for live sessions, when this run's own session is not listed", async () => {
		oracleSessions = ["other"];
		const r = await run({
			issues: [{ number: 1 }],
			staleFiles: {
				a: { path: "scripts/a.js", sessionId: "dead-1", hoursAgo: 24 },
			},
		});
		expect(r.out).toMatch(/stranded claims\s+unknown/);
		expect(r.out).toMatch(/live sessions\s+unknown/);
	});

	it("prints unknown, never zero, when the debt store cannot be read", async () => {
		oracleSessions = ["self"];
		const r = await run({ issues: [{ number: 1 }], debtsUnreadable: true });
		expect(r.out).toMatch(/debt entries\s+unknown/);
		expect(r.out).not.toMatch(/debt entries\s+0/);
	});

	it("carries the same counts in --json under owedWork", async () => {
		oracleSessions = ["self"];
		const r = await run(
			{
				issues: [{ number: 1 }],
				debts: [{ path: "docs/doc-map.md", issue: 900 }],
				staleFiles: {
					a: { path: "scripts/a.js", sessionId: "dead-1", hoursAgo: 24 },
				},
			},
			["--json"],
		);
		const j = r.json();
		expect(j.owedWork).toEqual({
			debtEntries: 1,
			debtEntriesUnknown: null,
			strandedClaims: 1,
			strandedClaimsUnknown: null,
			strandedClaimsCarrying: 0,
			strandedClaimsCarryingUnknown: null,
		});
	});

	it("says in --json that git would not name the dirty files, rather than zero", async () => {
		oracleSessions = ["self"];
		stubBrokenRepo();
		const r = await run(
			{
				issues: [{ number: 1 }],
				staleFiles: {
					a: { path: "scripts/a.js", sessionId: "dead-1", hoursAgo: 24 },
				},
			},
			["--json"],
		);
		const j = r.json();
		expect(j.owedWork.strandedClaims).toBe(1);
		expect(j.owedWork.strandedClaimsCarrying).toBeNull();
		expect(j.owedWork.strandedClaimsCarryingUnknown).toMatch(
			/would not report/,
		);
		// The other null: the count itself read fine, so this one stays clear.
		expect(j.owedWork.strandedClaimsUnknown).toBeNull();
	});

	/* Conflating the two nulls tells a consumer git was asked (mantahostels#1780). */
	it("blames the oracle, not git, when the stranded count itself is unknown", async () => {
		oracleFails = true;
		const j = (await run({ issues: [{ number: 1 }] }, ["--json"])).json();
		expect(j.owedWork.strandedClaims).toBeNull();
		expect(j.owedWork.strandedClaimsUnknown).toMatch(/oracle/);
		expect(j.owedWork.strandedClaimsCarryingUnknown).toBeNull();
	});

	/*
	 * mantahostels#1780: the standing count alone is not owed work — most of the pile is
	 * inert, and the subset on a file carrying uncommitted work is the part a
	 * reader can act on. It is the same subset check-stranded-file-claims.js
	 * itemises under --notify, off lib/stranded-count.js, so the two readers
	 * cannot disagree (mantahostels#1206).
	 */
	it("names how many stranded claims carry uncommitted work", async () => {
		oracleSessions = ["self"];
		stubRepo(["scripts/dirty.js"]);
		const r = await run({
			issues: [{ number: 1 }],
			staleFiles: {
				a: { path: "scripts/dirty.js", sessionId: "dead-1", hoursAgo: 24 },
				b: { path: "scripts/absent.js", sessionId: "dead-2", hoursAgo: 24 },
			},
		});
		expect(r.out).toMatch(/stranded claims\s+2, 1 carrying uncommitted work/);
	});

	it("says how many carry uncommitted work is unknown when git will not answer", async () => {
		oracleSessions = ["self"];
		stubBrokenRepo();
		const r = await run({
			issues: [{ number: 1 }],
			staleFiles: {
				a: { path: "scripts/a.js", sessionId: "dead-1", hoursAgo: 24 },
			},
		});
		expect(r.out).toMatch(/stranded claims\s+1, unknown how many carrying/);
	});
});

/*
 * mantahostels#384: the issues a live session holds an arbiter claim on are the in-flight
 * set — the sessions actually running right now (narrowed from the assignee at
 * mantahostels#645). They are dropped from the shortlist, so pairing candidates only
 * with each other misses every collision with work already under way.
 */
describe("candidate-vs-in-flight collisions", () => {
	it("reports a candidate naming a file a claimed issue also names", async () => {
		stubRepo(["scripts/session-arbiter.js"]);
		const r = await run({
			issues: [
				{ number: 1, body: "extract `session-arbiter.js`'s store" },
				{
					number: 2,
					assignees: ["owner"],
					body: "`session-arbiter.js` reads an unreadable store",
				},
			],
			claims: { 2: "self" },
		});
		expect(r.order()).toEqual([1]);
		expect(r.out).toMatch(
			/in flight: #1 <-> #2 \(claimed by owner\) on scripts\/session-arbiter\.js/,
		);
	});

	it("restates the advisory limits when only an in-flight pair fires", async () => {
		stubRepo(["scripts/a.js"]);
		const r = await run({
			issues: [
				{ number: 1, body: "`scripts/a.js`" },
				{ number: 2, assignees: ["luc"], body: "`scripts/a.js`" },
			],
			claims: { 2: "self" },
		});
		expect(r.out).toMatch(/POSSIBLE FILE COLLISIONS/);
		expect(r.out).toMatch(/may\s+name a file it\s*\n?only refers to/);
		expect(r.out).toMatch(/naming no file can still collide/);
	});

	it("leaves an in-flight issue out of the shortlist and out of its pairs", async () => {
		stubRepo(["scripts/a.js"]);
		const r = await run({
			issues: [
				{ number: 1, body: "`scripts/a.js`" },
				{ number: 2, assignees: ["luc"], body: "`scripts/a.js`" },
				{ number: 3, body: "`scripts/a.js`" },
			],
			claims: { 2: "self" },
		});
		expect(r.order()).toEqual([1, 3]);
		expect(r.out).toMatch(/possible collision: #1 <-> #3 on scripts\/a\.js/);
		expect(r.out.match(/possible collision:/g)).toHaveLength(1);
		expect(r.out.match(/in flight:/g)).toHaveLength(2);
	});

	it("ignores an issue excluded for anything other than a claim", async () => {
		// Blocked or a container: nobody is writing those files right now.
		stubRepo(["scripts/a.js"]);
		const r = await run({
			issues: [
				{ number: 1, body: "`scripts/a.js`" },
				{ number: 2, body: "`scripts/a.js`" },
				{ number: 3, parent: 2, body: "unrelated" },
			],
			deps: { 1: [] },
		});
		expect(r.out).not.toMatch(/in flight:/);
	});

	it("carries the in-flight pairs into --json", async () => {
		stubRepo(["scripts/a.js"]);
		const j = (
			await run(
				{
					issues: [
						{ number: 1, body: "`scripts/a.js`" },
						{ number: 2, assignees: ["luc"], body: "`scripts/a.js`" },
					],
					claims: { 2: "self" },
				},
				["--json"],
			)
		).json();
		expect(j.inFlightCollisions).toEqual([
			{
				candidate: 1,
				inFlight: 2,
				claimedBy: ["luc"],
				claimedSession: "self",
				paths: ["scripts/a.js"],
			},
		]);
	});

	it("keeps claimedBy a list in --json and joins it only for the printed line", async () => {
		stubRepo(["scripts/a.js"]);
		const issues = [
			{ number: 1, body: "`scripts/a.js`" },
			{ number: 2, assignees: ["luc", "ada"], body: "`scripts/a.js`" },
		];
		const claims = { 2: "self" };
		expect((await run({ issues, claims })).out).toMatch(
			/\(claimed by luc, ada\)/,
		);
		expect(
			(await run({ issues, claims }, ["--json"])).json().inFlightCollisions[0]
				.claimedBy,
		).toEqual(["luc", "ada"]);
	});

	it("caps the printed pairs and says how many it withheld", async () => {
		// 13 candidates against 12 in-flight, left as a product: the count is
		// quadratic in the issues sharing a path (.claude/skills/pick-next/SKILL.md).
		stubRepo(["scripts/a.js"]);
		const issues = Array.from({ length: 25 }, (_, k) => ({
			number: k + 1,
			body: "`scripts/a.js`",
			assignees: k % 2 ? ["luc"] : undefined,
		}));
		const claims = Object.fromEntries(
			issues.filter((i) => i.assignees).map((i) => [i.number, "self"]),
		);
		const r = await run({ issues, claims });
		expect(r.out.match(/in flight:/g)).toHaveLength(20);
		expect(r.out).toMatch(/and \d+ more in-flight pairs — --json carries/);
		expect(
			(await run({ issues, claims }, ["--json"])).json().inFlightCollisions
				.length,
		).toBe(13 * 12);
	});

	it("changes no shortlist order — it annotates, like the pairs it extends", async () => {
		stubRepo(["scripts/a.js"]);
		const bare = await run({ issues: [{ number: 4 }, { number: 7 }] });
		const annotated = await run({
			issues: [
				{ number: 4, body: "`scripts/a.js`" },
				{ number: 7 },
				{ number: 9, assignees: ["luc"], body: "`scripts/a.js`" },
			],
			claims: { 9: "self" },
		});
		expect(annotated.order()).toEqual(bare.order());
	});
});

describe("when the tracker misbehaves", () => {
	it("retries a failed dependency call once and keeps the issue on a success", async () => {
		const r = await run({
			issues: [{ number: 1 }, { number: 2 }],
			failDepsOnce: [2],
		});
		expect(r.status).toBe(0);
		expect(r.order()).toEqual([1, 2]);
		expect(r.out).not.toMatch(/DEGRADED/);
	});

	it("reads every issue's blockers in one batched call, no per-issue call (#2685)", async () => {
		const r = await run({
			issues: [{ number: 1 }, { number: 2 }, { number: 3 }],
			deps: { 3: [{ number: 1, state: "open" }] },
		});
		expect(r.order()).toEqual([1, 2]);
		const calls = fs.readFileSync(CALL_LOG(), "utf8");
		expect(calls).not.toMatch(/dependencies\/blocked_by/);
		expect(calls.match(/^api graphql /gm)).toHaveLength(1);
	});

	it("reads the full blocker list of an issue with more than the batch's inner page (#2685)", async () => {
		// The batch reads 25 blockers per issue; #1's 26th, the only open one,
		// is past that page, so only the REST read can see it.
		const many = Array.from({ length: 26 }, (_, k) => ({
			number: 100 + k,
			state: k === 25 ? ("open" as const) : ("closed" as const),
		}));
		const r = await run({
			issues: [{ number: 1 }, { number: 2 }, { number: 125 }],
			deps: { 1: many },
		});
		expect(r.order()).toEqual([125, 2]);
		const calls = fs.readFileSync(CALL_LOG(), "utf8");
		expect(calls).toMatch(/issues\/1\/dependencies\/blocked_by/);
		expect(calls).not.toMatch(/issues\/2\/dependencies\/blocked_by/);
	});

	it("holds every issue in a failed batch out as readiness unknown, never unblocked (#2685)", async () => {
		const r = await run({
			issues: [{ number: 1 }, { number: 2 }],
			failGraphql: true,
		});
		expect(r.status).toBe(0);
		expect(r.order()).toEqual([]);
		expect(r.out).toMatch(/DEGRADED \(2\) — readiness unknown/);
		expect(r.out).toContain(GH_NOT_FOUND.stderr.trim());
		const calls = fs.readFileSync(CALL_LOG(), "utf8");
		expect(calls).not.toMatch(/dependencies\/blocked_by/);
	});

	it("retries a failed batch once and keeps its issues on a success (#2685)", async () => {
		const r = await run({
			issues: [{ number: 1 }, { number: 2 }],
			failGraphqlOnce: true,
		});
		expect(r.order()).toEqual([1, 2]);
		expect(r.out).not.toMatch(/DEGRADED/);
	});

	for (const answer of ["empty", "noRepo"] as const)
		it(`reads a batch answering ${answer} as readiness unknown, never as no blockers (#2685)`, async () => {
			const r = await run({
				issues: [{ number: 1 }],
				deps: { 1: [{ number: 9, state: "open" }] },
				graphqlAnswers: answer,
			});
			expect(r.order()).toEqual([]);
			expect(r.out).toMatch(/DEGRADED \(1\) — readiness unknown/);
		});

	it("holds an issue out of the shortlist when its readiness stays unknown", async () => {
		// Never assumed takeable: a session would claim work something else gates.
		const r = await run({
			issues: [{ number: 1 }, { number: 2 }],
			failDeps: [2],
		});
		expect(r.status).toBe(0);
		expect(r.order()).toEqual([1]);
		expect(r.out).toMatch(/DEGRADED \(1\) — readiness unknown/);
		expect(r.out).toMatch(/#2\s/);
		expect(r.out).toContain(GH_NOT_FOUND.stderr.trim());
	});

	it("qualifies the headline on the same line when any issue is degraded (#93)", async () => {
		const r = await run({
			issues: [{ number: 1 }, { number: 2 }],
			failDeps: [2],
		});
		expect(r.status).toBe(0);
		expect(r.out).toMatch(/TAKEABLE NOW: 1\s+\(1 unread, see DEGRADED\)/);
	});

	it("leaves the headline unqualified with nothing degraded (#93)", async () => {
		const r = await run({ issues: [{ number: 1 }] });
		expect(r.status).toBe(0);
		expect(r.out).toMatch(/TAKEABLE NOW: 1\n/);
		expect(r.out).not.toContain("see DEGRADED");
	});

	it("collapses more than 3 degraded issues failing the same way into one line (#93)", async () => {
		const numbers = [11, 12, 13, 14];
		const r = await run({
			issues: [{ number: 1 }, ...numbers.map((number) => ({ number }))],
			failDeps: numbers,
		});
		expect(r.status).toBe(0);
		expect(r.out).toMatch(/DEGRADED \(4\)/);
		expect(r.out).toContain(
			`4 failing the same way — ${GH_NOT_FOUND.stderr.trim()}`,
		);
		for (const n of numbers) expect(r.out).toContain(`#${n}`);
	});

	it("keeps individual blocks for 3 or fewer degraded issues sharing an error (#93)", async () => {
		const numbers = [21, 22, 23];
		const r = await run({
			issues: [{ number: 1 }, ...numbers.map((number) => ({ number }))],
			failDeps: numbers,
		});
		expect(r.status).toBe(0);
		expect(r.out).not.toMatch(/failing the same way/);
		for (const n of numbers) {
			expect(r.out).toMatch(new RegExp(`#${n}\\s+issue ${n}`));
		}
	});

	it("says reach is a lower bound when an issue is degraded", async () => {
		// mantahostels#3's blocked_by is what would have recorded the mantahostels#1 -> mantahostels#3 edge, so losing
		// that call costs mantahostels#1 a reach point.
		const r = await run({
			issues: [{ number: 1 }, { number: 2 }, { number: 3 }],
			deps: { 3: [{ number: 1, state: "open" }] },
			failDeps: [3],
		});
		expect(r.out).toMatch(/#1\s+0\s/);
		expect(r.out).toMatch(/every REACH above is a lower\s+bound/);
	});

	it("flags the lower bound in JSON too", async () => {
		const clean = await run({ issues: [{ number: 1 }] }, ["--json"]);
		expect(clean.json().reachIsLowerBound).toBe(false);
	});

	it("fails loudly when the issue list itself is unreachable, warning it is no empty frontier and printing no shortlist", async () => {
		// An empty shortlist would read as "the tracker is drained".
		const r = await run({ issues: [{ number: 1 }], failList: true });
		expect(r.status).toBe(1);
		expect(r.out).toMatch(/FAILED: could not list open issues/);
		expect(r.out).toMatch(/do not\s+read this as an empty frontier/);
		expect(r.out).not.toMatch(/TAKEABLE NOW/);
	});
});

describe("an empty issue list (#2565)", () => {
	it("re-reads it, then fails loudly where the repo counts open issues, printing the refusal whole", async () => {
		const r = await run({ issues: [], openCount: 5 });
		expect(r.status).toBe(1);
		expect(r.calls().filter((c) => /issues\?state=open/.test(c))).toHaveLength(
			2,
		);
		expect(r.out).toMatch(/GitHub counts 5 open on the repo/);
		expect(r.out).not.toMatch(/fault in the query/);
		expect(r.out).toMatch(/do not\s+read this as an empty frontier/);
	});
});

describe("advisory only", () => {
	it("issues nothing but gh api GETs — no method, no write subcommand", async () => {
		const r = await run({
			issues: [{ number: 1, labels: ["urgent"] }, { number: 2 }],
			timeline: {
				1: [{ label: "urgent", created_at: daysAgo(1), actor: "someone" }],
			},
		});
		for (const call of r.calls()) {
			expect(call.split(" ")[0]).toBe("api");
			expect(call).not.toMatch(/(^|\s)(-X|--method)(\s|$)/);
		}
		// The `urgent` path is the one mantahostels#101 (what defines urgency) and mantahostels#111 (who
		// may apply it) both guarded: read and display, never apply, never strip.
		expect(restCalls(r.calls()).join("\n")).not.toMatch(/labels/);
		expectGraphqlReadsOnly(r.calls());
		expect(r.out).toMatch(/nothing here was written back to the tracker/);
	});

	it("emits the same frontier as JSON, with the reasons for each exclusion", async () => {
		const r = await run(
			{
				issues: [{ number: 1 }, { number: 2, assignees: ["someone"] }],
				claims: { 2: "self" },
			},
			["--json"],
		);
		const j = r.json();
		expect(j.frontier.map((f: { number: number }) => f.number)).toEqual([1]);
		expect(j.excluded).toEqual([
			{ number: 2, title: "issue 2", reason: "claimed by someone" },
		]);
		expect(j.degraded).toEqual([]);
	});

	it("refuses a flag given as another flag's value, naming the flag that needs a value (#920)", async () => {
		// `--goal --json` must not resolve to the goal set "--json".
		const r = await run({ issues: [{ number: 1 }] }, ["--goal", "--json"]);
		expect(r.status).toBe(2);
		expect(r.out).toMatch(/--goal needs a value/);
	});

	it("caps the printed shortlist with --limit without hiding the true count", async () => {
		const r = await run(
			{ issues: [{ number: 1 }, { number: 2 }, { number: 3 }] },
			["--limit", "2"],
		);
		expect(r.order()).toEqual([1, 2]);
		expect(r.out).toMatch(/TAKEABLE NOW: 3\s+\(showing 2\)/);
	});
});

describe("--dump-bodies", () => {
	const dumpDir = () => path.join(dir, "bodies");

	it("writes one file per open issue and issues no extra call for any of it", async () => {
		const r = await run(
			{
				issues: [
					{ number: 1, title: "first", body: "body one" },
					{ number: 2, title: "second", body: "body two" },
				],
			},
			["--dump-bodies", dumpDir()],
		);
		expect(r.status).toBe(0);
		expect(fs.readFileSync(path.join(dumpDir(), "1.md"), "utf8")).toContain(
			"body one",
		);
		expect(fs.readFileSync(path.join(dumpDir(), "2.md"), "utf8")).toContain(
			"body two",
		);
		for (const call of restCalls(r.calls()))
			expect(call).not.toMatch(/\bissue\b/);
		expect(r.calls().filter((c) => /issues\?state=open/.test(c))).toHaveLength(
			1,
		);
	});

	it("names the issue in the file, so a band read needs no second lookup", async () => {
		await run({ issues: [{ number: 7, title: "a title", body: "text" }] }, [
			"--dump-bodies",
			dumpDir(),
		]);
		const f = fs.readFileSync(path.join(dumpDir(), "7.md"), "utf8");
		expect(f).toMatch(/#7 — a title/);
		expect(f).toContain("text");
	});

	it("dumps no pull request, matching the shortlist's own candidate set", async () => {
		await run(
			{
				issues: [
					{ number: 1, body: "an issue" },
					{ number: 2, body: "a PR", pull_request: {} },
				],
			},
			["--dump-bodies", dumpDir()],
		);
		expect(fs.existsSync(path.join(dumpDir(), "1.md"))).toBe(true);
		expect(fs.existsSync(path.join(dumpDir(), "2.md"))).toBe(false);
	});

	it("dumps every open issue, not only the shortlisted ones", async () => {
		// An excluded issue's body is what says whether its exclusion still holds.
		await run(
			{
				issues: [
					{ number: 1, body: "takeable" },
					{ number: 2, body: "claimed", assignees: ["someone"] },
				],
				claims: { 2: "self" },
			},
			["--dump-bodies", dumpDir()],
		);
		expect(fs.existsSync(path.join(dumpDir(), "2.md"))).toBe(true);
	});

	it("says where the bodies landed, in both output modes", async () => {
		const text = await run({ issues: [{ number: 1 }] }, [
			"--dump-bodies",
			dumpDir(),
		]);
		expect(text.out).toContain(dumpDir());
		const json = await run({ issues: [{ number: 1 }] }, [
			"--dump-bodies",
			dumpDir(),
			"--json",
		]);
		expect(json.json().bodiesDumped).toEqual({
			dir: dumpDir(),
			count: 1,
			error: null,
		});
	});

	it("reports an undumpable directory without failing the shortlist", async () => {
		const blocked = path.join(dir, "notadir");
		fs.writeFileSync(blocked, "");
		const r = await run({ issues: [{ number: 1 }] }, [
			"--dump-bodies",
			path.join(blocked, "under-a-file"),
		]);
		expect(r.status).toBe(0);
		expect(r.out).toMatch(/could not dump/i);
		expect(r.out).toMatch(/TAKEABLE NOW: 1/);
	});

	it("dumps nothing when the flag is absent", async () => {
		const r = await run({ issues: [{ number: 1 }] }, ["--json"]);
		expect(r.json().bodiesDumped).toBeNull();
	});
});

describe("the doc-map queue", () => {
	/*
	 * The queue's own line, not the whole output: the conflict graph below it
	 * prints issue numbers too (mantahostels#1002), so a bare /mantahostels#1, mantahostels#2/ over the run would
	 * pass on either block.
	 */
	const parseQueueLine = (out: string) =>
		out.match(/just the top:\n {2}(.*)/)?.[1] ?? null;

	it("flags the bodies naming a §B entry as one queue, in shortlist order", async () => {
		const r = await run({
			issues: [
				{ number: 1, body: "no entry here" },
				{ number: 2, body: "extends §B2 with the measurement" },
				{ number: 3, body: "writes §B7" },
			],
		});
		expect(r.out).toMatch(/DOC-MAP QUEUE/);
		expect(parseQueueLine(r.out)).toBe("#2, #3");
	});

	it("keeps out a bare B45 and a plain doc-map mention", async () => {
		// Both are caught only by the widening .claude/skills/pick-next/SKILL.md rejects on precision.
		const r = await run({
			issues: [
				{ number: 1, body: "the entry is B45" },
				{ number: 2, body: "mentions docs/doc-map.md as context" },
			],
		});
		expect(r.out).not.toMatch(/DOC-MAP QUEUE/);
	});

	it("flags an unnumbered §B entry in the DOC-MAP QUEUE, naming its issue — how a NEW entry is always written", async () => {
		const r = await run({
			issues: [
				{ number: 1, body: "writes its `docs/doc-map.md` §B entry" },
				{ number: 2, body: "no entry here" },
			],
		});
		expect(r.out).toMatch(/DOC-MAP QUEUE \(1\)/);
		expect(parseQueueLine(r.out)).toBe("#1");
	});

	it("prints the whole queue as one line, excluding none of it", async () => {
		const r = await run({
			issues: [
				{ number: 1, body: "§B1" },
				{ number: 2, body: "§B2" },
			],
		});
		expect(parseQueueLine(r.out)).toBe("#1, #2");
		expect(r.order()).toEqual([1, 2]);
		expect(r.out).not.toMatch(/EXCLUDED\n\n#/);
	});

	it("does not reorder the shortlist a flagged body sits in", async () => {
		// The flag is on the LOWER-ranked issue, so a queue that reached the sort —
		// in either direction — would show up as a swap here.
		const r = await run({
			issues: [
				{ number: 1, body: "nothing" },
				{ number: 2, body: "§B1 §B2 §B3" },
				{ number: 3, body: "nothing either" },
			],
		});
		expect(r.order()).toEqual([1, 2, 3]);
	});

	it("carries the queue in --json", async () => {
		const r = await run(
			{
				issues: [
					{ number: 1, body: "§B9" },
					{ number: 2, body: "plain" },
					{ number: 3, body: "§B10", assignees: ["someone"] },
				],
				claims: { 3: "self" },
			},
			["--json"],
		);
		// The shortlist is what the band read covers, so an excluded issue is no
		// part of the queue however its body reads.
		expect(r.json().docMapQueue).toEqual([1]);
	});

	it("prints no queue section when no body names an entry", async () => {
		const r = await run({ issues: [{ number: 1, body: "plain" }] });
		expect(r.out).not.toMatch(/DOC-MAP QUEUE/);
	});
});

describe("the write-set cache", () => {
	/*
	 * Every test here runs with `ownRepo`, dropping `--repo`: the store is keyed
	 * on the tree, so the cache serves only this repository's own issues.
	 * "skips the store entirely against another repository" is what pins that.
	 */
	const here = (fx: Fixture, args: string[] = []) =>
		run(fx, args, { ownRepo: true });

	/** Stores an entry the way `pick-next-cache.js put` would. */
	const store = (
		number: number,
		body: string,
		fields: Record<string, unknown> = {},
	) =>
		writeSetCache.writeEntry(repoRoot, {
			issue: number,
			bodyHash: writeSetCache.bodyHash(body),
			writeSet: ["scripts/a.js"],
			trackedAtDerive: [],
			sizeBand: "M",
			gist: "what it does",
			...fields,
		});

	it("counts every frontier issue as cold on a first run", async () => {
		// `--no-prewarm` throughout the cold-path tests below: pre-warming fills
		// a miss in the same run that finds it (mantahostels#1001), so without the flag there
		// is no cold state left to assert on.
		const r = await here(
			{
				issues: [
					{ number: 1, body: "one" },
					{ number: 2, body: "two" },
				],
			},
			["--no-prewarm"],
		);
		expect(r.out).toMatch(
			/WRITE-SET CACHE .* 0 warm, 0 provisional, 2 to derive/,
		);
		expect(r.out).toMatch(/derive #1 #2/);
	});

	it("gives each cold issue the key to store its result back under", async () => {
		const r = await here({ issues: [{ number: 1, body: "one" }] }, [
			"--json",
			"--no-prewarm",
		]);
		expect(r.json().writeSetCache.cold).toEqual([
			{
				number: 1,
				state: "cold",
				bodyHash: writeSetCache.bodyHash("one"),
				gonePaths: null,
			},
		]);
	});

	it("reads a stored entry back as warm, with its write-set and gist", async () => {
		store(1, "one");
		const r = await here({ issues: [{ number: 1, body: "one" }] });
		expect(r.out).toMatch(/1 warm, 0 provisional, 0 to derive/);
		expect(r.out).toMatch(/warm {2}#1 {2}1 path\(s\), M — what it does/);
	});

	it("goes cold again once the body is really edited", async () => {
		store(1, "one");
		const r = await here({ issues: [{ number: 1, body: "one, rewritten" }] }, [
			"--json",
			"--no-prewarm",
		]);
		expect(r.json().writeSetCache.cold[0].state).toBe("body-changed");
	});

	it("stays warm through a ticked checkbox, which changes no file", async () => {
		store(1, "- [ ] do the thing");
		const r = await here(
			{ issues: [{ number: 1, body: "- [x] do the thing" }] },
			["--json"],
		);
		expect(
			r.json().writeSetCache.warm.map((w: { number: number }) => w.number),
		).toEqual([1]);
	});

	it("re-derives an entry whose tracked path was renamed away", async () => {
		stubRepo(["scripts/new-name.js"]);
		store(1, "one", {
			writeSet: ["scripts/old-name.js"],
			trackedAtDerive: ["scripts/old-name.js"],
		});
		const r = await here({ issues: [{ number: 1, body: "one" }] }, [
			"--json",
			"--no-prewarm",
		]);
		expect(r.json().writeSetCache.cold[0].state).toBe("path-gone");
		expect(r.json().writeSetCache.cold[0].gonePaths).toEqual([
			"scripts/old-name.js",
		]);
	});

	it("says so when git could not list the tree, rather than hiding it", async () => {
		// The broken root first: `store` writes into whatever repoRoot then is.
		stubBrokenRepo();
		store(1, "one", {
			writeSet: ["scripts/a.js"],
			trackedAtDerive: ["scripts/a.js"],
		});
		const r = await here({ issues: [{ number: 1, body: "one" }] });
		expect(r.out).toMatch(/warm {2}#1.*unrevalidated/);
		const j = await here({ issues: [{ number: 1, body: "one" }] }, ["--json"]);
		expect(j.json().writeSetCache.warm[0].unrevalidated).toBe(true);
	});

	it("prunes the entry of an issue that is no longer open", async () => {
		store(1, "one");
		store(99, "closed since");
		const r = await here({ issues: [{ number: 1, body: "one" }] }, ["--json"]);
		expect(r.json().writeSetCache.pruned).toEqual([99]);
		expect(writeSetCache.readEntry(repoRoot, 99)).toBeNull();
		expect(writeSetCache.readEntry(repoRoot, 1)).not.toBeNull();
	});

	it("keeps the entry of an open issue the shortlist excluded", async () => {
		// A claimed issue is still open, and its entry is what makes the next
		// re-pick warm.
		store(2, "claimed");
		await here(
			{
				issues: [
					{ number: 1, body: "one" },
					{ number: 2, body: "claimed", assignees: ["someone"] },
				],
				claims: { 2: "self" },
			},
			["--json"],
		);
		expect(writeSetCache.readEntry(repoRoot, 2)).not.toBeNull();
	});

	it("writes the key into each dumped body, so a band read needs no lookup", async () => {
		const dumpDir = path.join(dir, "bodies");
		const r = await here({ issues: [{ number: 1, body: "one" }] }, [
			"--dump-bodies",
			dumpDir,
			"--json",
			"--no-prewarm",
		]);
		const dumped = fs.readFileSync(path.join(dumpDir, "1.md"), "utf8");
		expect(dumped).toContain(
			`<!-- body-hash: ${r.json().writeSetCache.cold[0].bodyHash} -->`,
		);
	});

	it("covers the whole frontier, not the --limit slice", async () => {
		// --limit is a display cap, and a warm entry hidden by it is one the band
		// read pays for a second time. mantahostels#1289: `frontier` itself is no longer
		// truncated either, so this checks the cache split, which was always the
		// full frontier — and the written report alongside it.
		const r = await here(
			{
				issues: [
					{ number: 1, body: "one" },
					{ number: 2, body: "two" },
				],
			},
			["--limit", "1", "--json", "--no-prewarm"],
		);
		expect(r.json().frontier).toHaveLength(2);
		expect(
			r.json().writeSetCache.cold.map((c: { number: number }) => c.number),
		).toEqual([1, 2]);
	});

	it("changes neither the order nor the shortlist", async () => {
		// Advisory: nothing is refused on a prediction.
		store(2, "two");
		const r = await here({
			issues: [
				{ number: 1, body: "one" },
				{ number: 2, body: "two" },
			],
		});
		expect(r.order()).toEqual([1, 2]);
		expect(r.out).toMatch(/TAKEABLE NOW: 2/);
	});

	it("skips the store entirely against another repository", async () => {
		// The store is keyed on the tree, so another tracker's mantahostels#1 would read this
		// one's entry, and pruning would delete what that tracker has no issue for.
		store(1, "one");
		store(99, "gone");
		const r = await run({ issues: [{ number: 1, body: "one" }] }, ["--json"]);
		expect(r.json().writeSetCache.warm).toEqual([]);
		expect(r.json().writeSetCache.cold).toEqual([]);
		expect(writeSetCache.readEntry(repoRoot, 99)).not.toBeNull();
	});

	/** Every line of the warm-fraction log this tree has recorded, oldest first. */
	const readLog = () =>
		fs
			.readFileSync(
				path.join(repoRoot as string, warmFractionLog.LOG_SUBPATH),
				"utf8",
			)
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l));

	/** Moves an entry's derive time, so the interval under test is not a race. */
	const derivedAt = (issue: number, at: string) => {
		const file = path.join(writeSetCache.cacheDir(repoRoot), `${issue}.json`);
		const e = JSON.parse(fs.readFileSync(file, "utf8"));
		fs.writeFileSync(file, JSON.stringify({ ...e, derivedAt: at }));
	};

	it("records how many entries were put since the run before it (mantahostels#667)", async () => {
		const fx = {
			issues: [
				{ number: 1, body: "one" },
				{ number: 2, body: "two" },
			],
		};
		await here(fx);
		const first = readLog()[0];
		// The band read the first run asked for, landing between the two runs.
		store(1, "one");
		derivedAt(1, new Date(Date.parse(first.at) + 1).toISOString());
		await here(fx);
		const lines = readLog();
		expect(lines).toHaveLength(2);
		// Nothing preceded the first run, so its interval is unknown, not empty.
		expect(first.putsSinceLastRun).toBeNull();
		expect(lines[1].putsSinceLastRun).toBe(1);
	});

	it("counts nothing put where the store has not moved since the last run", async () => {
		const fx = { issues: [{ number: 1, body: "one" }] };
		store(1, "one");
		await here(fx);
		await here(fx);
		expect(readLog()[1].putsSinceLastRun).toBe(0);
	});

	const logFile = () =>
		path.join(repoRoot as string, warmFractionLog.LOG_SUBPATH);

	it("writes no line under --no-log", async () => {
		// A run made to produce a figure measures the harness rather than the
		// churn, so it must not enter the record it would be quoted from (mantahostels#628).
		const r = await here({ issues: [{ number: 1, body: "one" }] }, [
			"--no-log",
		]);
		expect(r.status).toBe(0);
		expect(r.out).toMatch(/WRITE-SET CACHE/);
		expect(fs.existsSync(logFile())).toBe(false);
	});

	it("writes no line for a run against another repository", async () => {
		const r = await run({ issues: [{ number: 1, body: "one" }] });
		expect(r.status).toBe(0);
		// The run has to have got that far: an absent file alone would pass against
		// a run that fell over before reaching the log.
		expect(r.out).toMatch(/TAKEABLE NOW: 1/);
		expect(fs.existsSync(logFile())).toBe(false);
	});

	it("logs the whole frontier, not the --limit slice", async () => {
		// Recording the slice instead would shrink the denominator the warm
		// fraction is taken over.
		const r = await here(
			{
				issues: [
					{ number: 1, body: "one" },
					{ number: 2, body: "two" },
				],
			},
			["--limit", "1", "--no-prewarm"],
		);
		expect(r.order()).toEqual([1]);
		expect(readLog()[0].frontier).toBe(2);
		expect(readLog()[0].cold).toBe(2);
	});

	it("leaves the exit code and the shortlist alone when the append fails", async () => {
		// A directory where the log file belongs.
		fs.mkdirSync(logFile(), { recursive: true });
		const fx = {
			issues: [
				{ number: 1, body: "one" },
				{ number: 2, body: "two" },
			],
		};
		const r = await here(fx);
		expect(r.status).toBe(0);
		expect(r.order()).toEqual([1, 2]);
		expect(r.out).toMatch(/TAKEABLE NOW: 2/);
		expect(r.out).toMatch(
			/This run went unrecorded for mantahostels#628's warm fraction/,
		);
		const j = await here(fx, ["--json"]);
		expect(j.status).toBe(0);
		expect(j.json().warmFractionLogged.ok).toBe(false);
		expect(j.json().frontier).toHaveLength(2);
	});

	it("says a failed append went unrecorded even with nothing to derive", async () => {
		// The warning used to print inside the cache block, so a run with an empty
		// frontier lost it.
		fs.mkdirSync(logFile(), { recursive: true });
		const r = await here({
			issues: [{ number: 1, body: "one" }],
			deps: { 1: [{ number: 2, state: "open" }] },
		});
		expect(r.status).toBe(0);
		expect(r.out).not.toMatch(/WRITE-SET CACHE/);
		expect(r.out).toMatch(/This run went unrecorded/);
	});

	describe("pre-warming a miss in the run that finds it (mantahostels#1001)", () => {
		it("leaves nothing to derive on a first run, so no band read is dispatched", async () => {
			// The whole point: an issue filed since the last selection used to cost
			// this run a ~60 s band-read subagent on its critical path.
			const r = await here({
				issues: [
					{ number: 1, body: "one" },
					{ number: 2, body: "two" },
				],
			});
			expect(r.out).toMatch(
				/WRITE-SET CACHE .* 0 warm, 2 provisional, 0 to derive/,
			);
			expect(r.out).not.toMatch(/ derive #/);
		});

		it("prints a provisional row apart from a warm one, and says it has no size", async () => {
			store(1, "one");
			const r = await here({
				issues: [
					{ number: 1, body: "one" },
					{ number: 2, title: "Do the thing", body: "two" },
				],
			});
			expect(r.out).toMatch(/warm {2}#1 {2}1 path\(s\), M — what it does/);
			expect(r.out).toMatch(
				/prov {2}#2 {2}0 path\(s\), no size \(predicted: small\) — Do the thing/,
			);
		});

		it("carries the two apart in --json, so a reader taking `warm` gets band reads only", async () => {
			store(1, "one");
			const r = await here(
				{
					issues: [
						{ number: 1, body: "one" },
						{ number: 2, title: "Do the thing", body: "two" },
					],
				},
				["--json"],
			);
			const j = r.json().writeSetCache;
			expect(j.warm.map((w: { number: number }) => w.number)).toEqual([1]);
			expect(j.provisional).toEqual([
				{
					number: 2,
					writeSet: [],
					sizeBand: null,
					predictedSize: "small",
					gist: "Do the thing",
					derivedAt: expect.any(String),
					provisional: true,
					replaced: "cold",
					unrevalidated: false,
				},
			]);
			expect(j.cold).toEqual([]);
			expect(j.prewarmed).toBe(true);
		});

		it("predicts the paths the body names, plus doc-map off a §B entry", async () => {
			stubRepo(["scripts/a.js", "docs/doc-map.md"]);
			const r = await here(
				{ issues: [{ number: 1, body: "edit `scripts/a.js`, register §B7" }] },
				["--json"],
			);
			expect(r.json().writeSetCache.provisional[0].writeSet).toEqual([
				"docs/doc-map.md",
				"scripts/a.js",
			]);
		});

		it("reads its own prediction back as provisional on the next run, never as warm", async () => {
			const fx = { issues: [{ number: 1, title: "T", body: "one" }] };
			await here(fx);
			const r = await here(fx, ["--json"]);
			expect(r.json().writeSetCache.warm).toEqual([]);
			expect(r.json().writeSetCache.provisional[0].number).toBe(1);
			// Carried in from the store rather than written over a miss this run.
			expect(r.json().writeSetCache.provisional[0].replaced).toBeNull();
		});

		it("is superseded by a band read, which clears the flag", async () => {
			await here({ issues: [{ number: 1, body: "one" }] });
			store(1, "one");
			const r = await here({ issues: [{ number: 1, body: "one" }] }, [
				"--json",
			]);
			expect(
				r.json().writeSetCache.warm.map((w: { number: number }) => w.number),
			).toEqual([1]);
			expect(r.json().writeSetCache.provisional).toEqual([]);
		});

		it("leaves a wayfinder:map issue cold, and says why", async () => {
			// Its substrate is its own body, so whatever its prose backticks is not
			// what it would write.
			const r = await here(
				{
					issues: [
						{ number: 1, body: "`scripts/a.js`", labels: ["wayfinder:map"] },
					],
				},
				["--json"],
			);
			expect(r.json().writeSetCache.cold[0].number).toBe(1);
			expect(r.json().writeSetCache.prewarmSkipped).toEqual([
				{ number: 1, why: expect.stringMatching(/wayfinder:map/) },
			]);
			const text = await here({
				issues: [
					{ number: 1, body: "`scripts/a.js`", labels: ["wayfinder:map"] },
				],
			});
			expect(text.out).toMatch(/not predicted: #1 — wayfinder:map/);
		});

		it("names the prediction as `grep` in the conflict graph, never as a band read", async () => {
			// mantahostels#588 bars refusing a candidate on grep output, and a row that cannot
			// be told from a judged one is how that bar is lost.
			stubRepo(["scripts/a.js"]);
			const r = await here(
				{ issues: [{ number: 1, body: "`scripts/a.js`" }] },
				["--json"],
			);
			expect(r.json().conflictGraph.candidates[0]).toMatchObject({
				source: "grep",
				sizeBand: null,
			});
		});

		it("records the provisional tickets apart from warm in the measurement log", async () => {
			// Folding them into `warm` would drive every line towards 100% and make
			// mantahostels#385's 60-80% claim untestable.
			store(1, "one");
			await here({
				issues: [
					{ number: 1, body: "one" },
					{ number: 2, body: "two" },
				],
			});
			expect(readLog()[0].warm).toBe(1);
			expect(readLog()[0].provisional).toBe(1);
			expect(readLog()[0].cold).toBe(0);
			expect(readLog()[0].provisionalNumbers).toEqual([2]);
		});

		it("does not count its own predictions as puts, which would defeat the collapse", async () => {
			const fx = { issues: [{ number: 1, body: "one" }] };
			await here(fx);
			await here(fx);
			expect(readLog()[1].putsSinceLastRun).toBe(0);
		});

		it("changes neither the order nor the shortlist", async () => {
			const r = await here({
				issues: [
					{ number: 1, body: "one" },
					{ number: 2, body: "two" },
				],
			});
			expect(r.order()).toEqual([1, 2]);
			expect(r.out).toMatch(/TAKEABLE NOW: 2/);
		});

		it("stores nothing at all under --no-prewarm", async () => {
			const r = await here({ issues: [{ number: 1, body: "one" }] }, [
				"--json",
				"--no-prewarm",
			]);
			expect(r.json().writeSetCache.prewarmed).toBe(false);
			expect(writeSetCache.readEntry(repoRoot, 1)).toBeNull();
		});

		it("stores nothing against another repository, whose issue numbers are not ours", async () => {
			const r = await run({ issues: [{ number: 1, body: "one" }] }, ["--json"]);
			expect(r.json().writeSetCache.provisional).toEqual([]);
			expect(writeSetCache.readEntry(repoRoot, 1)).toBeNull();
		});

		it("leaves every issue cold when git cannot list the tree, rather than predicting blind", async () => {
			stubBrokenRepo();
			const r = await here({ issues: [{ number: 1, body: "one" }] }, [
				"--json",
			]);
			expect(r.json().writeSetCache.cold[0].number).toBe(1);
			expect(r.json().writeSetCache.prewarmSkipped).toEqual([
				{
					number: 1,
					why: expect.stringMatching(/git could not list the tree/),
				},
			]);
		});
	});
});

describe("an assignment is real only where a live session claimed it (mantahostels#645)", () => {
	it("excludes an assigned issue whose claim's session is live", async () => {
		oracleSessions = ["self", "alice"];
		const r = await run({
			issues: [{ number: 1, assignees: ["owner"] }, { number: 2 }],
			claims: { 1: "alice" },
		});
		expect(r.order()).toEqual([2]);
		expect(r.out).toMatch(/#1\s+.*claimed by owner/);
	});

	it("offers an assigned issue whose claim's session has finished", async () => {
		// The mantahostels#633 failure: every assignee is the login `owner`, so a finished
		// session's assignment hid its issue for good.
		oracleSessions = ["self"];
		const r = await run({
			issues: [{ number: 1, assignees: ["owner"] }, { number: 2 }],
			claims: { 1: "alice" },
		});
		expect(r.order()).toEqual([1, 2]);
	});

	it("offers an assigned issue no session ever claimed — the fail-open case", async () => {
		const r = await run({
			issues: [{ number: 1, assignees: ["owner"] }, { number: 2 }],
		});
		expect(r.order()).toEqual([1, 2]);
	});

	it("names the assignments it decided to ignore, rather than dropping them silently", async () => {
		const r = await run({ issues: [{ number: 1, assignees: ["owner"] }] });
		expect(r.out).toMatch(/ASSIGNED BUT UNCLAIMED \(1\) — treated as takeable/);
		expect(r.out).toMatch(/#1\s+owner/);
		expect(r.out).toMatch(/session-arbiter\.js claim-issue <n>/);
	});

	it("says nothing about unclaimed assignments when there are none", async () => {
		oracleSessions = ["self", "alice"];
		const r = await run({
			issues: [{ number: 1, assignees: ["owner"] }],
			claims: { 1: "alice" },
		});
		expect(r.out).not.toMatch(/ASSIGNED BUT UNCLAIMED/);
	});

	it("excludes a live claim carrying no assignee at all", async () => {
		oracleSessions = ["self", "alice"];
		const r = await run({
			issues: [{ number: 1 }, { number: 2 }],
			claims: { 1: "alice" },
		});
		expect(r.order()).toEqual([2]);
		// The recording session, not "a live session": the id is the only handle a
		// reader has on a claim nobody assigned themselves to (mantahostels#708).
		expect(r.out).toMatch(/#1\s+.*claimed by session alice/);
	});

	it("keeps every claim standing when the oracle will not answer", async () => {
		// Narrowing the live set on a partial read would dispatch a second session
		// onto work already in flight.
		oracleFails = true;
		const r = await run({
			issues: [{ number: 1, assignees: ["owner"] }, { number: 2 }],
			claims: { 1: "alice" },
		});
		expect(r.order()).toEqual([2]);
		expect(r.out).toMatch(/CLAIMS DEGRADED/);
		expect(r.out).toMatch(/kept rather than narrowing the live set/);
	});

	it("warns a corrupt claim record apart from a wholly unread store (mantahostels#1186)", async () => {
		// A corrupt record among readable ones still leaves some claims held —
		// unlike a store that would not open at all.
		oracleSessions = ["self", "alice"];
		const r = await run({
			issues: [{ number: 1 }, { number: 2 }],
			claims: { 1: "alice" },
			corruptClaim: true,
		});
		expect(r.order()).toEqual([2]);
		expect(r.out).toMatch(/CLAIMS DEGRADED/);
		expect(r.out).toMatch(/could not be read, so what is shown as claimed/);
		expect(r.out).not.toMatch(/No claim was read/);
	});

	it("still offers an unclaimed assignment when the oracle will not answer", async () => {
		// Doubt keeps the claims that exist; it never invents one.
		oracleFails = true;
		const r = await run({ issues: [{ number: 1, assignees: ["owner"] }] });
		expect(r.order()).toEqual([1]);
	});

	it("pairs a candidate only with an issue a live session is on", async () => {
		oracleSessions = ["self", "alice"];
		stubRepo(["scripts/a.js"]);
		const issues = [
			{ number: 1, body: "`scripts/a.js`" },
			{ number: 2, assignees: ["luc"], body: "`scripts/a.js`" },
		];
		// Claimed: in flight, and out of the shortlist.
		expect((await run({ issues, claims: { 2: "alice" } })).out).toMatch(
			/in flight: #1 <-> #2/,
		);
		// Unclaimed: this run offers mantahostels#2 itself, so warning against it would
		// contradict its own shortlist — it is an ordinary candidate pair.
		const open = await run({ issues });
		expect(open.out).not.toMatch(/in flight:/);
		expect(open.out).toMatch(/possible collision: #1 <-> #2/);
	});

	it("carries the unclaimed assignments and the degraded read into --json", async () => {
		oracleFails = true;
		const j = (
			await run(
				{
					issues: [
						{ number: 1, assignees: ["owner"] },
						{ number: 2, assignees: ["ada"] },
					],
					claims: { 2: "alice" },
				},
				["--json"],
			)
		).json();
		expect(j.assignedUnclaimed).toEqual([
			{ number: 1, title: "issue 1", assignees: ["owner"] },
		]);
		expect(j.claimsDegraded.claimsKept).toBe(true);
		expect(j.claimsDegraded.why).toMatch(/agents --json/);
	});

	it("does not offer a blocked issue as takeable on the strength of a stale assignee", async () => {
		const r = await run({
			issues: [{ number: 1, assignees: ["owner"] }, { number: 2 }],
			deps: { 1: [{ number: 2, state: "open" }] },
		});
		expect(r.out).toMatch(/#1\s+.*blocked by #2/);
		expect(r.out).not.toMatch(/ASSIGNED BUT UNCLAIMED/);
	});

	it("pairs a candidate with a live claim that carries no assignee", async () => {
		oracleSessions = ["self", "alice"];
		stubRepo(["scripts/a.js"]);
		const r = await run({
			issues: [
				{ number: 1, body: "`scripts/a.js`" },
				{ number: 2, body: "`scripts/a.js`" },
			],
			claims: { 2: "alice" },
		});
		expect(r.out).toMatch(/in flight: #1 <-> #2 \(claimed by session alice\)/);
	});
});

/* mantahostels#708: what selection TELLS a reader about a claim. */
/* #2310 */
describe("a live claim on an issue's parent holds the issue too", () => {
	const thereUrl = "https://api.github.com/repos/o/there";
	const claudeConfig = () => path.join(dir, "home", ".claude");

	it("excludes a child of a live-claimed map, naming parent and holder", async () => {
		oracleSessions = ["self", "alice"];
		oracleNames = { alice: "Wayfinder 20: chart" };
		const r = await run({
			issues: [
				{ number: 20, labels: ["wayfinder:map"] },
				{ number: 21, parent: 20 },
				{ number: 22 },
			],
			claims: { 20: "alice" },
		});
		expect(r.order()).toEqual([22]);
		expect(r.out).toMatch(
			/#21\s+.*parent map #20 by session Wayfinder 20: chart/,
		);
		expect(r.calls().filter((c) => c.includes("/parent"))).toEqual([]);
	});

	it("reads a parent named by a real API URL as the child's own repo", async () => {
		oracleSessions = ["self", "alice"];
		const r = await run({
			issues: [
				{ number: 20, labels: ["wayfinder:map"] },
				{
					number: 21,
					parentUrl: "https://api.github.com/repos/o/r/issues/20",
				},
			],
			claims: { 20: "alice" },
		});
		expect(r.order()).toEqual([]);
		expect(r.out).toMatch(/#21\s+.*parent map #20 by session alice/);
		expect(r.calls().filter((c) => c.includes("/parent"))).toEqual([]);
	});

	it("offers a child whose live-claimed parent is no map", async () => {
		oracleSessions = ["self", "alice"];
		const r = await run({
			issues: [
				{ number: 20, labels: ["kind:spec"] },
				{ number: 21, parent: 20 },
			],
			claims: { 20: "alice" },
		});
		expect(r.order()).toEqual([21]);
	});

	it("offers a child whose parent's claim is held by an ended session", async () => {
		oracleSessions = ["self"];
		const r = await run({
			issues: [
				{ number: 20, labels: ["wayfinder:map"] },
				{ number: 21, parent: 20 },
			],
			claims: { 20: "alice" },
		});
		expect(r.order()).toEqual([21]);
	});

	const thereMap = { url: `${thereUrl}/issues/7`, labels: ["wayfinder:map"] };

	const otherCheckout = (home: string, claims: Record<number, string>) => {
		const at = path.join(home, "there");
		writeAdopterCheckout(at, "o/there");
		for (const [n, sessionId] of Object.entries(claims))
			writeIssueClaim(claudeConfig(), at, Number(n), sessionId);
		return at;
	};

	it("reads a parent in another repo from that repo's own store", async () => {
		oracleSessions = ["self", "alice"];
		const home = path.join(dir, "adopters");
		otherCheckout(home, { 7: "alice" });
		const r = await run(
			{
				parents: { 21: thereMap },
				issues: [
					{ number: 7 },
					{
						number: 21,
						parentUrl: `${thereUrl}/issues/7`,
						repoUrl: "https://api.github.com/repos/o/r",
					},
					{ number: 22 },
				],
			},
			[],
			{ env: { HOME: home } },
		);
		/* #7 here is not that parent: only the child of o/there#7 is held. */
		expect(r.order()).toEqual([7, 22]);
		expect(r.out).toMatch(/#21\s+.*parent map o\/there#7 by session alice/);
	});

	it("offers the child with a WARN where the parent repo's store reads only in part", async () => {
		oracleSessions = ["self", "alice"];
		const home = path.join(dir, "adopters");
		const there = otherCheckout(home, { 8: "alice" });
		writeTornClaim(claudeConfig(), there);
		const r = await run(
			{
				parents: { 21: thereMap },
				issues: [{ number: 21, parentUrl: `${thereUrl}/issues/7` }],
			},
			[],
			{ env: { HOME: home } },
		);
		expect(r.order()).toEqual([21]);
		expect(r.out).toContain(
			"WARN: the claim on parent o/there#7 was not read: 1 issue-claim record could not be read and was dropped",
		);
	});

	it("offers the child with a WARN where the parent repo's store cannot be found", async () => {
		oracleSessions = ["self", "alice"];
		const home = path.join(dir, "adopters");
		fs.mkdirSync(home, { recursive: true });
		const r = await run(
			{
				parents: { 21: thereMap },
				issues: [
					{
						number: 21,
						parentUrl: `${thereUrl}/issues/7`,
						repoUrl: "https://api.github.com/repos/o/r",
					},
				],
			},
			[],
			{ env: { HOME: home } },
		);
		expect(r.order()).toEqual([21]);
		expect(r.out).toContain(
			`WARN: no checkout under ${home} tracks o/there, so the claim on parent o/there#7 was not read.`,
		);
	});
});

describe("a claim is reported the same way to a person and to a machine (mantahostels#708)", () => {
	const sharing = (): Issue[] => {
		stubRepo(["scripts/a.js"]);
		return [
			{ number: 1, body: "`scripts/a.js`" },
			{ number: 2, body: "`scripts/a.js`" },
		];
	};

	it("names the claim's session in --json where there is no assignee to name", async () => {
		// The defect: `claimedBy: []` told a machine reader nobody had claimed it.
		oracleSessions = ["self", "alice"];
		const j = (
			await run({ issues: sharing(), claims: { 2: "alice" } }, ["--json"])
		).json();
		expect(j.inFlightCollisions[0].claimedBy).toEqual([]);
		expect(j.inFlightCollisions[0].claimedSession).toBe("alice");
	});

	it("carries the session alongside the assignee, not instead of it", async () => {
		oracleSessions = ["self", "alice"];
		const issues = sharing();
		issues[1].assignees = ["luc"];
		const j = (
			await run({ issues, claims: { 2: "alice" } }, ["--json"])
		).json();
		expect(j.inFlightCollisions[0].claimedBy).toEqual(["luc"]);
		expect(j.inFlightCollisions[0].claimedSession).toBe("alice");
	});

	it("does not assert the session is live when the oracle would not answer", async () => {
		// The claim was KEPT on doubt, so this run never established liveness.
		oracleFails = true;
		const r = await run({
			issues: [{ number: 1 }, { number: 2 }],
			claims: { 1: "s" },
		});
		expect(r.out).toMatch(/CLAIMS DEGRADED/);
		expect(r.out).toMatch(/#1\s+.*claimed by session s, liveness unread/);
		expect(r.out).not.toMatch(/a live session/);
	});

	it("names the holding session rather than printing a bare id", async () => {
		// A uuid tells a reader nothing about which session to go and look at.
		oracleSessions = ["self", "alice"];
		oracleNames = { alice: "Implement 708" };
		const r = await run({
			issues: [{ number: 1 }, { number: 2 }],
			claims: { 1: "alice" },
		});
		expect(r.out).toMatch(/#1\s+.*claimed by session Implement 708/);
	});

	it("falls back to a short id where the oracle named no session", async () => {
		oracleSessions = ["self", "0b1a4d3e-1111-2222-3333-444455556666"];
		const r = await run({
			issues: [{ number: 1 }, { number: 2 }],
			claims: { 1: "0b1a4d3e-1111-2222-3333-444455556666" },
		});
		expect(r.out).toMatch(/claimed by session 0b1a4d3e(?!-)/);
	});

	it("does not hedge the row when the oracle did answer", async () => {
		oracleSessions = ["self", "alice"];
		const r = await run({
			issues: [{ number: 1 }, { number: 2 }],
			claims: { 1: "alice" },
		});
		expect(r.out).not.toMatch(/liveness unread/);
	});

	it("hedges the in-flight pair on a degraded read too", async () => {
		oracleFails = true;
		const r = await run({ issues: sharing(), claims: { 2: "alice" } });
		expect(r.out).toMatch(
			/in flight: #1 <-> #2 \(claimed by session alice, liveness unread\)/,
		);
	});

	it("leaves an excluded issue out of assignedUnclaimed", async () => {
		// Blocked, so this run is not offering it and its assignment decided
		// nothing — the field carries only what was treated as takeable.
		const j = (
			await run(
				{
					issues: [{ number: 1, assignees: ["owner"] }, { number: 2 }],
					deps: { 1: [{ number: 2, state: "open" }] },
				},
				["--json"],
			)
		).json();
		expect(j.assignedUnclaimed).toEqual([]);
	});
});

describe("which tree the claims came from (mantahostels#703)", () => {
	/*
	 * This script pins its repo with WFC_REPO_ROOT; the arbiter store keys its
	 * state directory on CLAUDE_PROJECT_DIR. Invoke the canonical checkout's copy
	 * from inside a throwaway worktree and the two name different trees, so the
	 * store resolves cleanly to a directory holding no claims — and a run that
	 * reads no claim at all looks exactly like a genuinely unclaimed frontier.
	 */
	const elsewhere = () => {
		claimsRepo = fs.mkdtempSync(path.join(os.tmpdir(), "pick-next-worktree-"));
		roots.push(claimsRepo);
	};

	it("says so when the claim store resolves outside the pinned repo root", async () => {
		elsewhere();
		const r = await run({ issues: [{ number: 1, assignees: ["owner"] }] });
		expect(r.out).toMatch(/CLAIMS DEGRADED/);
		expect(r.out).toMatch(/not the tree this run's claims are filed under/);
		expect(r.out).toMatch(/Claims filed against .* are invisible/);
	});

	/*
	 * A run from a worktree has both sides resolving independently to that
	 * worktree. They agree — and every claim is still filed under the canonical
	 * checkout's slug, so the run reads none.
	 */
	const linkedWorktree = () => {
		const canonical = repoRoot as string;
		spawnSync(
			"git",
			[
				"-c",
				"user.email=t@example",
				"-c",
				"user.name=t",
				"commit",
				"-q",
				"--allow-empty",
				"-m",
				"base",
			],
			{ cwd: canonical },
		);
		const wt = path.join(dir, "linked-worktree");
		spawnSync("git", ["worktree", "add", "-q", "--detach", wt, "HEAD"], {
			cwd: canonical,
		});
		repoRoot = wt;
		noProjectDir = true;
		runCwd = wt;
		claimsRepo = canonical;
		return { canonical: fs.realpathSync(canonical), wt: fs.realpathSync(wt) };
	};

	it("says so from inside a linked worktree, where the two roots agree", async () => {
		const { canonical, wt } = linkedWorktree();
		const r = await run({ issues: [{ number: 1, assignees: ["owner"] }] });
		expect(r.out).toMatch(/CLAIMS DEGRADED/);
		expect(r.out).toMatch(/a linked worktree of/);
		expect(r.out).toContain(canonical);
		expect(r.out).toContain(wt);
	});

	it("points the reader at the canonical checkout, not the worktree", async () => {
		const { canonical } = linkedWorktree();
		expect((await run({ issues: [{ number: 1 }] })).out).toContain(
			`Claims filed against ${canonical} are invisible`,
		);
	});

	it("carries the worktree case into --json, with the tree to re-run from", async () => {
		const { canonical } = linkedWorktree();
		const j = (await run({ issues: [{ number: 1 }] }, ["--json"])).json();
		expect(j.claimsDegraded.storeElsewhere).toBe(true);
		expect(j.claimsDegraded.why).toMatch(/linked worktree of/);
		// The path, not just the flag: a consumer should not have to regex `why`.
		expect(j.claimsDegraded.claimsTree).toBe(canonical);
	});

	/*
	 * mantahostels#1 is assigned and a LIVE session holds its claim — filed under the canonical checkout — so a run from the
	 * canonical tree excludes it. From the worktree the store reads empty, and
	 * the issue is offered as takeable while somebody is on it.
	 */
	it("shows a live session's issue as takeable, which is the fault itself", async () => {
		linkedWorktree();
		oracleSessions = ["self", "alice"];
		const r = await run({
			issues: [{ number: 1, assignees: ["owner"] }, { number: 2 }],
			claims: { 1: "alice" },
		});
		expect(r.order()).toContain(1);
		expect(r.out).toMatch(/CLAIMS DEGRADED/);
	});

	/*
	 * A store root INSIDE a repository is not a linked worktree, and must not be
	 * announced as one: `--git-common-dir` prints the same `.git` from any
	 * subdirectory, so taking its parent unconditionally invents a worktree
	 * nobody has.
	 */
	it("calls a subdirectory a mismatch, never a linked worktree", async () => {
		claimsRepo = path.join(repoRoot as string, "sub");
		const r = await run({ issues: [{ number: 1 }] });
		expect(r.out).toMatch(/CLAIMS DEGRADED/);
		expect(r.out).not.toMatch(/linked worktree/);
		expect(r.out).toMatch(/not the tree this run's claims are filed under/);
	});

	/*
	 * With neither variable set, the canonical checkout drives the same `git rev-parse` fallback and must stay
	 * silent, or every ordinary run cries wolf.
	 */
	it("says nothing from the canonical checkout with neither variable set", async () => {
		noProjectDir = true;
		runCwd = repoRoot;
		const r = await run({ issues: [{ number: 1, assignees: ["owner"] }] });
		expect(r.out).not.toMatch(/CLAIMS DEGRADED/);
	});

	it("names both trees, so the reader can see which store was read", async () => {
		elsewhere();
		const r = await run({ issues: [{ number: 1 }] });
		expect(r.out).toContain(fs.realpathSync(claimsRepo as string));
		expect(r.out).toContain(fs.realpathSync(repoRoot as string));
	});

	it("carries the divergence into --json", async () => {
		elsewhere();
		const j = (await run({ issues: [{ number: 1 }] }, ["--json"])).json();
		expect(j.claimsDegraded.storeElsewhere).toBe(true);
		expect(j.claimsDegraded.why).toMatch(/claim store resolves to/);
	});

	it("keeps the corrupt-record warning beside the divergence, not overwritten by it (mantahostels#1186)", async () => {
		elsewhere();
		const j = (
			await run({ issues: [{ number: 1 }], corruptClaim: true }, ["--json"])
		).json();
		expect(j.claimsDegraded.why).toMatch(/claim store resolves to/);
		expect(j.claimsDegraded.why).toMatch(/could not be read and .* dropped/);
	});

	it("says nothing when the two roots agree", async () => {
		const r = await run({ issues: [{ number: 1, assignees: ["owner"] }] });
		expect(r.out).not.toMatch(/CLAIMS DEGRADED/);
		expect(r.json).toBeDefined();
	});

	it("prefers the divergence to the oracle's own degraded read", async () => {
		// Whatever the oracle said, it said about another tree's claims.
		elsewhere();
		oracleFails = true;
		const j = (await run({ issues: [{ number: 1 }] }, ["--json"])).json();
		expect(j.claimsDegraded.storeElsewhere).toBe(true);
		expect(j.claimsDegraded.why).toMatch(/claim store resolves to/);
	});

	it("still reads the claims it found there, rather than discarding them", async () => {
		// They are claims on the same tracker, so an exclusion is still the safer
		// answer than pretending the issue is free.
		elsewhere();
		oracleSessions = ["self", "alice"];
		const r = await run({
			issues: [{ number: 1, assignees: ["owner"] }, { number: 2 }],
			claims: { 1: "alice" },
		});
		expect(r.order()).toEqual([2]);
	});
});

describe("the selection marker that arms guard-selection-sum.js (mantahostels#844)", () => {
	const here = (fx: Fixture, args: string[] = []) =>
		run(fx, args, { ownRepo: true });

	/** The id the harness gives the run, which is what the marker is keyed on. */
	const marker = () => selectionMarker.read(repoRoot, oracleSelfId);

	it("records the frontier a real run measured", async () => {
		const r = await here({
			issues: [
				{ number: 1, body: "one" },
				{ number: 2, body: "two" },
			],
		});
		expect(r.status).toBe(0);
		expect(marker()?.frontier).toBe(2);
	});

	it("records the whole frontier, not the --limit slice", async () => {
		// The guard checks the stated frontier against this number, so recording
		// the slice would make every honest accounting look like an invented one.
		const r = await here(
			{
				issues: [
					{ number: 1, body: "one" },
					{ number: 2, body: "two" },
					{ number: 3, body: "three" },
				],
			},
			["--limit", "1"],
		);
		expect(r.status).toBe(0);
		expect(marker()?.frontier).toBe(3);
	});

	it("records the admission slot count the run measured (mantahostels#1321)", async () => {
		// The guard demands §6's admission-cut line where the sessions dispatched
		// reach this number, so it must be the same figure the ADMISSION block
		// printed — not one the marker derived on its own.
		const r = await here({ issues: [{ number: 1, body: "one" }] });
		expect(r.status).toBe(0);
		const printed = r.out.match(/free slots\s+(\d+)/);
		expect(
			printed,
			"the run must print a slot count to compare against",
		).not.toBeNull();
		expect(marker()?.slots).toBe(Number((printed as RegExpMatchArray)[1]));
	});

	it("records no slot count where the machine could not be read", async () => {
		// Admission unreadable arms nothing on that limb rather than guessing a
		// number — the same discipline the frontier keeps.
		memAvailableKb = null;
		const r = await here({ issues: [{ number: 1, body: "one" }] });
		expect(r.status).toBe(0);
		expect(marker()?.frontier).toBe(1);
		expect(marker()?.slots).toBe(null);
	});

	it("mints nothing under --no-log", async () => {
		// A run exercising the tooling dispatches nothing, so a Stop hook must not
		// start demanding §5's sum of it (mantahostels#628's flag, reused).
		const r = await here({ issues: [{ number: 1, body: "one" }] }, [
			"--no-log",
		]);
		expect(r.status).toBe(0);
		expect(r.out).toMatch(/TAKEABLE NOW: 1/);
		expect(marker()).toBeNull();
	});

	it("mints nothing where the run has no session id to key on", async () => {
		oracleSelfId = "";
		const r = await here({ issues: [{ number: 1, body: "one" }] });
		expect(r.status).toBe(0);
		expect(
			fs.existsSync(
				path.join(
					String(repoRoot),
					".claude/tmp/markers/.pick-next/selection-sessions",
				),
			),
		).toBe(false);
	});
});

describe("a date gate in the body (mantahostels#85)", () => {
	/*
	 * A YYYY-MM-DD `n` days from now, the shape the marker takes — on WITA, the
	 * clock a gate is written and read on. A UTC date here would put every case
	 * a day out for the eight hours after 16:00 UTC.
	 */
	const isoIn = (n: number) =>
		new Date(Date.now() + WITA_OFFSET_MS + n * 86_400_000)
			.toISOString()
			.slice(0, 10);
	const gate = (n: number, why = "waiting on Bunkward") =>
		`Some body text.\n\n**Gated until:** ${isoIn(n)} — ${why}\n\nMore text.`;

	it("holds a gated issue out of the shortlist and says until when", async () => {
		const r = await run({
			issues: [{ number: 1 }, { number: 85, body: gate(9) }],
		});
		expect(r.order()).toEqual([1]);
		expect(r.out).toMatch(
			new RegExp(
				`#85\\s+held until ${isoIn(9)}, 9d left — waiting on Bunkward`,
			),
		);
	});

	it("still prints it under the waiting banner, to be chased anyway", async () => {
		// The point of reusing `excluded` rather than dropping the issue: it leaves
		// the batch without leaving the report.
		const r = await run({
			issues: [
				{ number: 1 },
				{ number: 85, body: gate(9), labels: ["waiting:external"] },
			],
			timeline: {
				85: [
					{ label: "waiting:external", created_at: daysAgo(5), actor: "luc" },
				],
			},
		});
		expect(r.order()).toEqual([1]);
		expect(r.out).toMatch(
			/not in the shortlist: gated until .* — chase it anyway/,
		);
	});

	it("lets the issue back in once the date is reached, and says the gate lapsed", async () => {
		const r = await run({
			issues: [{ number: 1 }, { number: 85, body: gate(-1) }],
		});
		expect(r.order()).toContain(85);
		expect(r.out).toMatch(
			new RegExp(`#85\\s+LAPSED ${isoIn(-1)} — back in the batch`),
		);
	});

	it("treats the named day itself as takeable, not as the last held day", async () => {
		// "Gated until the 24th" means free on the 24th: the boundary is that
		// date's midnight UTC, so a gate naming today is already spent.
		const r = await run({ issues: [{ number: 85, body: gate(0) }] });
		expect(r.order()).toContain(85);
		expect(r.out).toMatch(/LAPSED/);
	});

	it("turns the day on the founder's clock, not UTC", async () => {
		// WITA is UTC+8, so for the eight hours after 16:00 UTC the two disagree
		// about what day it is. Reading UTC would hold a gate through the morning
		// it was meant to lapse on. Only the WITA-dated gate is spent.
		const utcToday = new Date().toISOString().slice(0, 10);
		const r = await run({
			issues: [
				{ number: 85, body: `**Gated until:** ${isoIn(0)} — spent` },
				{ number: 86, body: `**Gated until:** ${isoIn(1)} — still holding` },
			],
		});
		expect(r.order()).toContain(85);
		expect(r.order()).not.toContain(86);
		// Only meaningful on the days the two clocks differ; harmless otherwise.
		if (utcToday !== isoIn(0)) expect(isoIn(0) > utcToday).toBe(true);
	});

	it("gates nothing on a date it cannot read, and says so rather than failing quietly", async () => {
		const r = await run({
			issues: [
				{ number: 85, body: "**Gated until:** next Tuesday — a chase is due" },
			],
		});
		expect(r.order()).toContain(85);
		// The whole tail comes back verbatim: which part of it was meant as the
		// date is precisely what could not be worked out.
		expect(r.out).toMatch(
			/#85\s+UNREADABLE DATE `next Tuesday — a chase is due` — GATING NOTHING/,
		);
	});

	it("rejects a well-shaped date that is not a real day, naming it as an UNREADABLE DATE and keeping the issue ranked", async () => {
		// 2026-02-30 parses in JS and silently becomes 2 March, so a round-trip is
		// what catches it.
		const r = await run({
			issues: [{ number: 85, body: "**Gated until:** 2026-02-30 — typo" }],
		});
		expect(r.order()).toContain(85);
		expect(r.out).toMatch(/UNREADABLE DATE `2026-02-30`/);
	});

	it("reports a gate with no reason rather than refusing to gate", async () => {
		const r = await run({
			issues: [
				{ number: 1 },
				{ number: 85, body: `**Gated until:** ${isoIn(5)}` },
			],
		});
		expect(r.order()).toEqual([1]);
		expect(r.out).toMatch(/#85\s+held until .*5d left — no reason given/);
	});

	it("reports a concrete blocker instead of the gate when both apply", async () => {
		const r = await run({
			issues: [{ number: 1 }, { number: 85, body: gate(9) }],
			deps: { 85: [{ number: 1, state: "open" }] },
		});
		expect(r.out).toMatch(/#85\s+\w*\s*blocked by #1/);
		expect(r.out).not.toMatch(/#85\s+spec\s+gated until/);
	});

	it("ignores a marker that is not at the head of its own line", async () => {
		const r = await run({
			issues: [
				{ number: 85, body: `See also **Gated until:** ${isoIn(9)} — nope` },
			],
		});
		expect(r.order()).toContain(85);
		expect(r.out).not.toMatch(/GATED BY A LINE/);
	});

	it("carries every gate into --json, lapsed and unreadable ones included", async () => {
		const r = await run(
			{
				issues: [
					{ number: 85, body: gate(9) },
					{ number: 86, body: gate(-2, "lapsed one") },
					{ number: 87, body: "**Gated until:** soon — bad" },
				],
			},
			["--json"],
		);
		const g = r.json().gated;
		expect(g.map((x: { number: number }) => x.number)).toEqual([85, 86, 87]);
		expect(g[0]).toMatchObject({ active: true, until: isoIn(9), daysLeft: 9 });
		expect(g[1]).toMatchObject({ active: false, reason: "lapsed one" });
		expect(g[2]).toMatchObject({ active: false, malformed: "soon — bad" });
	});
});

describe("a data-condition gate in the body (mantahostels#1419)", () => {
	/** A YYYY-MM-DD `n` days from now on WITA, the clock a date gate is read on. */
	const isoIn = (n: number) =>
		new Date(Date.now() + WITA_OFFSET_MS + n * 86_400_000)
			.toISOString()
			.slice(0, 10);
	const gateCondition =
		"the eleven tickets have cleared the 5-day rework horizon";
	/* Backtick-quoted in a real body; kept regex-safe here so the assertions can
	 * match the printed line literally. */
	const gateCommand = "python3 scan_rework.py";
	const abandonCondition = "the label stops being applied";
	const gateOn = (cond = gateCondition, cmd: string | null = gateCommand) =>
		`Some body text.\n\n**Gated on:** ${cond}${cmd ? ` — check: ${cmd}` : ""} — abandon if: ${abandonCondition}\n\nMore text.`;

	it("holds a conditioned issue out of the shortlist and prints its line", async () => {
		const r = await run({
			issues: [{ number: 1 }, { number: 1215, body: gateOn() }],
		});
		expect(r.order()).toEqual([1]);
		expect(r.out).toMatch(
			new RegExp(
				`#1215\\s+held on ${gateCondition} — check: ${gateCommand} — abandon if: ${abandonCondition}`,
			),
		);
	});

	it("holds a conditioned goal-set member out of the shortlist (#3102)", async () => {
		const r = await run(
			{ issues: [{ number: 1 }, { number: 1215, body: gateOn() }] },
			// --json: the frontier the refill loop reads (lib/refill-frontier.js)
			["--json", "--goal", "1215"],
		);
		expect(r.status).toBe(0);
		expect(r.json().frontier.map((f: { number: number }) => f.number)).toEqual([
			1,
		]);
	});

	it("states the condition in the exclusion reason, never a date", async () => {
		// The defect this whole marker exists to fix: a date-shaped reason line
		// where the truth is a sample count the reader could have checked.
		const r = await run({
			issues: [
				{ number: 1 },
				{
					number: 1215,
					body: gateOn(),
					labels: ["waiting:external"],
				},
			],
			timeline: {
				1215: [
					{ label: "waiting:external", created_at: daysAgo(5), actor: "luc" },
				],
			},
		});
		expect(r.out).toMatch(
			new RegExp(`not in the shortlist: gated on ${gateCondition}`),
		);
		expect(r.out).not.toMatch(/not in the shortlist: gated until/);
	});

	it("heads the banner with both spellings", async () => {
		const r = await run({ issues: [{ number: 1215, body: gateOn() }] });
		expect(r.out).toMatch(/GATED BY A LINE IN THE BODY/);
		expect(r.out).toMatch(/\*\*Gated until:\*\* YYYY-MM-DD/);
		expect(r.out).toMatch(/\*\*Gated on:\*\* <condition>/);
	});

	it("interleaves a dated and a conditioned issue by number under one banner", async () => {
		const r = await run({
			issues: [
				{ number: 1215, body: gateOn() },
				{
					number: 85,
					body: `**Gated until:** ${isoIn(9)} — chase Bunkward`,
				},
			],
		});
		const lines = r.out.split("\n");
		const banners = lines.filter((l) => /GATED BY A LINE/.test(l));
		expect(banners).toHaveLength(1);
		const dated = lines.findIndex((l) => /#85\s+held until/.test(l));
		const conditioned = lines.findIndex((l) => /#1215\s+held on/.test(l));
		expect(dated).toBeGreaterThan(-1);
		expect(conditioned).toBeGreaterThan(dated);
	});

	it("prints both footers, the date one and the judge-it-yourself one (#2279)", async () => {
		const r = await run({ issues: [{ number: 1215, body: gateOn() }] });
		expect(r.out).toMatch(
			/Move the date or delete the line; nothing expires it/,
		);
		expect(r.out).toMatch(
			/The `check:` on a condition gate is yours to run and judge/,
		);
		expect(r.out).toMatch(/`check-gates.js --issue <n>`, and on met/);
		expect(r.out).toMatch(/launching `\/triage <n>`\s+on a changed reading/);
		expect(r.out).toMatch(/`abandon if:` alone retires one unmet/);
	});

	it("says `check: none stated` where no command is given", async () => {
		// Separates "no command tests this" from "the parser dropped one".
		const r = await run({
			issues: [
				{
					number: 1105,
					body: gateOn("an `opusplan` session has happened", null),
				},
			],
		});
		expect(r.order()).not.toContain(1105);
		expect(r.out).toMatch(
			/#1105\s+held on .* — check: none stated — abandon if:/,
		);
	});

	it("gates nothing on a line missing its abort clause, and echoes the raw text", async () => {
		// `abandon if:` is the only thing that retires a condition, so holding on a
		// line that lacks it holds the issue under a rule nothing can release.
		const r = await run({
			issues: [{ number: 1215, body: "**Gated on:** enough samples exist" }],
		});
		expect(r.order()).toContain(1215);
		expect(r.out).toMatch(
			/#1215\s+MALFORMED GATE \(no `— abandon if:`\) `enough samples exist` — GATING NOTHING/,
		);
	});

	it("names the reason for a malformed gate that reads well-formed on its own", async () => {
		// mantahostels#1652: a duplicate `— check:`/`— abandon if:` inside the prose leaves
		// the raw tail looking like a valid three-segment gate, so the print
		// site must say *why* it was rejected, not just echo the tail.
		const r = await run({
			issues: [
				{
					number: 1215,
					body: "**Gated on:** rerun — check: the corpus first — check: `scan.py` — abandon if: retired",
				},
			],
		});
		expect(r.order()).toContain(1215);
		expect(r.out).toMatch(
			/#1215\s+MALFORMED GATE \(more than one `— check:`\)/,
		);
	});

	it("gates nothing when a body carries both markers, and says which defect", async () => {
		const r = await run({
			issues: [
				{
					number: 1215,
					body: `**Gated until:** ${isoIn(9)} — guessed\n\n**Gated on:** ${gateCondition} — abandon if: ${abandonCondition}`,
				},
			],
		});
		expect(r.order()).toContain(1215);
		expect(r.out).toMatch(/#1215\s+TWO GATE LINES, a date and a condition/);
		expect(r.out).not.toMatch(/#1215\s+held until/);
		expect(r.out).not.toMatch(/#1215\s+held on/);
	});

	it("carries conditioned issues in a sibling array, leaving `gated[]` alone", async () => {
		const r = await run(
			{
				issues: [
					{ number: 85, body: `**Gated until:** ${isoIn(9)} — chase` },
					{ number: 1105, body: gateOn("a session has happened", null) },
					{ number: 1215, body: gateOn() },
					{ number: 1216, body: "**Gated on:** enough samples exist" },
				],
			},
			["--json"],
		);
		const j = r.json();
		expect(j.gated.map((x: { number: number }) => x.number)).toEqual([85]);
		expect(j.gated[0]).toMatchObject({ active: true, until: isoIn(9) });
		expect(j.gatedOn.map((x: { number: number }) => x.number)).toEqual([
			1105, 1215, 1216,
		]);
		expect(j.gatedOn[0]).toMatchObject({
			condition: "a session has happened",
			command: null,
			abandonIf: abandonCondition,
			holding: true,
			malformed: null,
		});
		expect(j.gatedOn[1]).toMatchObject({ command: gateCommand, holding: true });
		expect(j.gatedOn[2]).toMatchObject({
			holding: false,
			malformed: "enough samples exist",
			malformedReason: "no `— abandon if:`",
			condition: null,
		});
	});

	it("flags a two-marker issue in the JSON, not only in the printed banner", async () => {
		// Without the flag a conflicted issue reads exactly like a lapsed date in
		// `gated[]` — `active: false` beside a positive `daysLeft` — so a consumer
		// that never sees the banner cannot tell the two apart (mantahostels#1333, one gate
		// line per issue).
		const r = await run(
			{
				issues: [
					{
						number: 1215,
						body: `**Gated until:** ${isoIn(9)} — guessed\n\n**Gated on:** ${gateCondition} — abandon if: ${abandonCondition}`,
					},
					{ number: 1216, body: gateOn() },
				],
			},
			["--json"],
		);
		const j = r.json();
		expect(j.gated[0]).toMatchObject({
			number: 1215,
			active: false,
			daysLeft: 9,
			bothMarkers: true,
		});
		expect(j.gatedOn[0]).toMatchObject({
			number: 1215,
			holding: false,
			bothMarkers: true,
		});
		// The unconflicted neighbour is untouched by the flag.
		expect(j.gatedOn[1]).toMatchObject({
			number: 1216,
			holding: true,
			bothMarkers: false,
		});
	});
});

describe("the full-JSON snapshot every run leaves on disk", () => {
	const here = (fx: Fixture, args: string[] = []) =>
		run(fx, args, { ownRepo: true });
	const snapshotPath = () =>
		path.join(
			String(repoRoot),
			".claude",
			"tmp",
			"markers",
			".pick-next",
			"last-run.json",
		);
	const readSnapshot = () =>
		JSON.parse(fs.readFileSync(snapshotPath(), "utf8"));

	it("writes the report on a plain text run, which asked for no JSON at all", async () => {
		const r = await here({ issues: [{ number: 1, body: "one" }] });
		expect(r.status).toBe(0);
		expect(readSnapshot().openIssues).toBe(1);
	});

	it("names the file it wrote, at the end where a tail still sees it", async () => {
		// Tailing the output is the failure this exists to fix, so a pointer at
		// the top would be lost by exactly the reader who needs it.
		const r = await here({ issues: [{ number: 1, body: "one" }] });
		expect(r.out).toMatch(/FULL JSON OF THIS RUN: .*last-run\.json/);
		// Genuinely last, not merely near the end: the "Advisory only" line used
		// to print after it, so a reader tailing two lines saw neither.
		const lines = r.out.trimEnd().split("\n");
		expect(lines.at(-3)).toMatch(/FULL JSON OF THIS RUN/);
		expect(lines.at(-1)).toMatch(/Check its generatedAt and repo/);
		// The line it used to hide behind now comes first.
		expect(lines.slice(0, -3).join("\n")).toMatch(/Advisory only/);
	});

	it("records which repo and which flags produced it", async () => {
		// One file holds whatever ran last, so a reader told to trust it instead
		// of re-running needs to see that this was another tracker's run.
		const r = await here({ issues: [{ number: 1, body: "one" }] }, [
			"--no-log",
			"--limit",
			"1",
		]);
		expect(r.status).toBe(0);
		expect(readSnapshot().argv).toEqual(["--no-log", "--limit", "1"]);
		expect(typeof readSnapshot().repo).toBe("string");
		expect(readSnapshot().repo).toBeTruthy();
	});

	it("leaves no half-written file where a concurrent reader can see one", async () => {
		// A successful run leaves no aside beside its snapshot.
		const r = await here({ issues: [{ number: 1, body: "one" }] });
		expect(r.status).toBe(0);
		const cacheDir = path.join(
			String(repoRoot),
			".claude",
			"tmp",
			"markers",
			".pick-next",
		);
		expect(fs.readdirSync(cacheDir).filter((f) => f.endsWith(".tmp"))).toEqual(
			[],
		);
	});

	it("carries the whole frontier, not the --limit slice", async () => {
		// mantahostels#1289: a truncated written `frontier` forced a second full run to read
		// the tie band. `--limit` now caps only the printed table.
		const r = await here(
			{
				issues: [
					{ number: 1, body: "one" },
					{ number: 2, body: "two" },
					{ number: 3, body: "three" },
				],
			},
			["--limit", "1"],
		);
		expect(r.status).toBe(0);
		expect(readSnapshot().frontier).toHaveLength(3);
		expect(readSnapshot().frontierCount).toBe(3);
		expect(readSnapshot().summary.shown).toBe(1);
	});

	it("writes the same report --json prints, so re-running buys nothing", async () => {
		const r = await here({ issues: [{ number: 1, body: "one" }] }, ["--json"]);
		expect(r.status).toBe(0);
		const printed = r.json();
		const written = readSnapshot();
		// generatedAt is the one field a second run would legitimately move.
		delete printed.generatedAt;
		delete written.generatedAt;
		expect(written).toEqual(printed);
	});

	it("reports a write it could not make, and still answers", async () => {
		// The run's own answer is on stdout; losing the copy must not lose it.
		fs.mkdirSync(String(repoRoot), { recursive: true });
		fs.mkdirSync(path.join(String(repoRoot), ".claude", "tmp", "markers"), {
			recursive: true,
		});
		fs.writeFileSync(
			path.join(String(repoRoot), ".claude", "tmp", "markers", ".pick-next"),
			"not a dir",
		);
		const r = await here({ issues: [{ number: 1, body: "one" }] });
		expect(r.status).toBe(0);
		expect(r.out).toMatch(/TAKEABLE NOW: 1/);
		expect(r.out).toMatch(/FULL JSON NOT WRITTEN — /);
	});
});

describe("the substrate-conflict graph (mantahostels#1002)", () => {
	/*
	 * `ownRepo` throughout: the write-set cache is keyed on the tree, and a
	 * band-read write-set is the graph's better input — a body's backticked
	 * paths are only its floor.
	 */
	const here = (fx: Fixture, args: string[] = []) =>
		run(fx, args, { ownRepo: true });

	/** A warm cache entry, the shape `pick-next-cache.js put` writes. */
	const warm = (
		number: number,
		body: string,
		fields: Record<string, unknown>,
	) =>
		writeSetCache.writeEntry(repoRoot, {
			issue: number,
			bodyHash: writeSetCache.bodyHash(body),
			trackedAtDerive: [],
			sizeBand: "M",
			gist: "what it does",
			...fields,
		});

	/** The graph block alone, so an assertion cannot pass on the table above it. */
	const block = (out: string) =>
		out.split("SUBSTRATE-CONFLICT GRAPH")[1]?.split("\nWRITE-SET CACHE")[0] ??
		"";

	it("names the pair sharing a file, and keeps the higher-ranked one", async () => {
		warm(1, "one", { writeSet: ["scripts/a.js"] });
		warm(2, "two", { writeSet: ["scripts/a.js"] });
		warm(3, "three", { writeSet: ["scripts/c.js"] });
		const r = await here({
			issues: [
				{ number: 1, body: "one" },
				{ number: 2, body: "two" },
				{ number: 3, body: "three" },
			],
		});
		expect(block(r.out)).toMatch(/#1 <-> #2 on scripts\/a\.js/);
		expect(block(r.out)).toMatch(/PROPOSED DISJOINT SET \(2\)[\s\S]*#1, #3/);
		expect(block(r.out)).toMatch(
			/not in it: #2 — #1 already in the set names scripts\/a\.js/,
		);
	});

	it("names the running session whose held file rules a candidate out", async () => {
		oracleSessions = ["self", "worker"];
		oracleNames = { worker: "Implement 900" };
		warm(1, "one", { writeSet: ["scripts/a.js"] });
		const r = await here({
			issues: [{ number: 1, body: "one" }],
			heldFiles: { "scripts/a.js": "worker" },
		});
		expect(block(r.out)).toMatch(/#1 — Implement 900 holds scripts\/a\.js/);
		expect(block(r.out)).toMatch(/PROPOSED DISJOINT SET \(0\)[\s\S]*empty/);
	});

	it("ignores a file held by a session the oracle no longer lists", async () => {
		oracleSessions = ["self"];
		warm(1, "one", { writeSet: ["scripts/a.js"] });
		const r = await here({
			issues: [{ number: 1, body: "one" }],
			heldFiles: { "scripts/a.js": "finished" },
		});
		expect(block(r.out)).not.toMatch(/ruled out by a running session/);
		expect(block(r.out)).toMatch(/PROPOSED DISJOINT SET \(1\)[\s\S]*#1/);
	});

	it("reports a doc-map-only overlap as stamp-sharing, and runs both", async () => {
		warm(1, "one", { writeSet: ["docs/doc-map.md"] });
		warm(2, "two", { writeSet: ["docs/doc-map.md"] });
		const r = await here({
			issues: [
				{ number: 1, body: "one" },
				{ number: 2, body: "two" },
			],
		});
		expect(block(r.out)).toMatch(
			/1 pair shares only docs\/doc-map\.md — a STAMP/,
		);
		expect(block(r.out)).not.toMatch(/candidate pairs naming one file/);
		expect(block(r.out)).toMatch(/PROPOSED DISJOINT SET \(2\)[\s\S]*#1, #2/);
	});

	it("prints a merge-test pair only where both sides are sized small", async () => {
		warm(1, "one", { writeSet: ["docs/doc-map.md"], sizeBand: "small" });
		warm(2, "two", { writeSet: ["docs/doc-map.md"], sizeBand: "small" });
		warm(3, "three", { writeSet: ["docs/doc-map.md"], sizeBand: "large" });
		const r = await here({
			issues: [
				{ number: 1, body: "one" },
				{ number: 2, body: "two" },
				{ number: 3, body: "three" },
			],
		});
		const pairs = block(r.out).split("merge-test pairs")[1] ?? "";
		expect(pairs).toMatch(/#1 \+ #2 on docs\/doc-map\.md/);
		// mantahostels#3 is not small, so it pairs with nobody — though it is still admitted.
		expect(pairs.split("PROPOSED")[0]).not.toMatch(/#3/);
		// Two of three limbs, said in the block itself.
		expect(block(r.out)).toMatch(/disjoint edit targets .* is\n {2}yours/);
	});

	it("falls back to the paths a cold body names, and says none was predicted", async () => {
		stubRepo(["scripts/a.js"]);
		const r = await here({
			issues: [
				{ number: 1, body: "edits `scripts/a.js`" },
				{ number: 2, body: "edits `scripts/a.js` too" },
				{ number: 3, body: "names no file at all" },
			],
		});
		expect(block(r.out)).toMatch(/#1 <-> #2 on scripts\/a\.js/);
		expect(block(r.out)).toMatch(/no write-set predicted[\s\S]*#3/);
		// Predicted nothing is not predicted safe: mantahostels#3 is admitted all the same.
		expect(block(r.out)).toMatch(/PROPOSED DISJOINT SET \(2\)[\s\S]*#1, #3/);
	});

	it("does not rule a candidate out on a file this very run's session holds", async () => {
		// Selection only reads, so its own claim is finished work, not work in
		// flight — the same reason admission counts sessions less its own.
		warm(1, "one", { writeSet: ["scripts/a.js"] });
		const r = await here({
			issues: [{ number: 1, body: "one" }],
			heldFiles: { "scripts/a.js": "self" },
		});
		expect(block(r.out)).not.toMatch(/ruled out by a running session/);
		expect(block(r.out)).toMatch(/PROPOSED DISJOINT SET \(1\)/);
	});

	it("summarises the conflicting pairs by file, hottest first", async () => {
		warm(1, "one", { writeSet: ["scripts/hot.js"] });
		warm(2, "two", { writeSet: ["scripts/hot.js"] });
		warm(3, "three", { writeSet: ["scripts/hot.js"] });
		const r = await here({
			issues: [
				{ number: 1, body: "one" },
				{ number: 2, body: "two" },
				{ number: 3, body: "three" },
			],
		});
		expect(block(r.out)).toMatch(/3 candidate pairs name one file, by file:/);
		expect(block(r.out)).toMatch(/scripts\/hot\.js — 3 pairs/);
	});

	it("agrees its verbs on the singular row", async () => {
		warm(1, "one", { writeSet: ["scripts/hot.js"] });
		warm(2, "two", { writeSet: ["scripts/hot.js"] });
		const r = await here({
			issues: [
				{ number: 1, body: "one" },
				{ number: 2, body: "two" },
			],
		});
		expect(block(r.out)).toMatch(/1 candidate pair names one file/);
		expect(block(r.out)).toMatch(/scripts\/hot\.js — 1 pair$/m);
	});

	it("says how many write-sets are the body's floor rather than a band read", async () => {
		stubRepo(["scripts/a.js"]);
		warm(1, "one", { writeSet: ["scripts/a.js"] });
		const r = await here({
			issues: [
				{ number: 1, body: "one" },
				{ number: 2, body: "also edits `scripts/a.js`" },
			],
		});
		expect(block(r.out)).toMatch(
			/1 of 2 write-sets above are the body's backticked/,
		);
	});

	it("truncates a session name long enough to push the file off the row", async () => {
		oracleSessions = ["self", "worker"];
		oracleNames = {
			worker:
				"Implement 922, 989: What replaces the per-push pricing rule once nothing is billed",
		};
		warm(1, "one", { writeSet: ["scripts/a.js"] });
		const r = await here({
			issues: [{ number: 1, body: "one" }],
			heldFiles: { "scripts/a.js": "worker" },
		});
		expect(block(r.out)).toMatch(
			/#1 — Implement 922, 989: What replaces… holds scripts\/a\.js/,
		);
		expect(block(r.out)).toMatch(
			/not in it: #1 — Implement 922, 989: What replaces… holds scripts\/a\.js/,
		);
		// --json keeps the whole name: the truncation is the row's, not the data's.
		const j = (
			await run(
				{
					issues: [{ number: 1, body: "one" }],
					heldFiles: { "scripts/a.js": "worker" },
				},
				["--json"],
				{ ownRepo: true },
			)
		).json();
		expect(j.conflictGraph.inFlight[0].session).toBe(oracleNames.worker);
	});

	it("carries the whole graph in --json", async () => {
		warm(1, "one", { writeSet: ["scripts/a.js"], sizeBand: "small" });
		warm(2, "two", { writeSet: ["scripts/a.js"], sizeBand: "small" });
		const r = await here(
			{
				issues: [
					{ number: 1, body: "one" },
					{ number: 2, body: "two" },
				],
			},
			["--json"],
		);
		const g = r.json().conflictGraph;
		expect(g.conflicts).toEqual([{ a: 1, b: 2, paths: ["scripts/a.js"] }]);
		expect(g.proposed).toEqual([1]);
		expect(g.mergeable).toEqual([{ a: 1, b: 2, paths: ["scripts/a.js"] }]);
		expect(g.stamps).toEqual(["docs/doc-map.md", "CLAUDE.md"]);
	});

	it("DISPATCHABLE FLOOR counts proposed members minus takes:human and takes:children", async () => {
		warm(1, "one", { writeSet: ["scripts/a.js"] });
		warm(2, "two", { writeSet: ["scripts/b.js"] });
		warm(3, "three", { writeSet: ["scripts/c.js"] });
		const issues = [
			{ number: 1, body: "one", labels: ["takes:implement"] },
			{ number: 2, body: "two", labels: ["takes:human"] },
			{ number: 3, body: "three", labels: ["takes:children"] },
		];
		const j = (await here({ issues }, ["--json"])).json();
		expect(j.conflictGraph.proposed).toEqual([1, 2, 3]);
		expect(j.dispatchableFloor).toBe(1);

		const r = await here({ issues });
		expect(r.out).toMatch(/DISPATCHABLE FLOOR: 1/);
	});

	it("refuses nothing: every candidate is still on the shortlist above", async () => {
		oracleSessions = ["self", "worker"];
		warm(1, "one", { writeSet: ["scripts/a.js"] });
		warm(2, "two", { writeSet: ["scripts/a.js"] });
		const r = await here({
			issues: [
				{ number: 1, body: "one" },
				{ number: 2, body: "two" },
			],
			heldFiles: { "scripts/a.js": "worker" },
		});
		expect(r.status).toBe(0);
		expect(r.order()).toEqual([1, 2]);
		// And the header says what the block is not, where the reader meets it.
		expect(block(r.out)).toMatch(/NOT a substrate call/);
		expect(block(r.out)).toMatch(/candidate for that test, never its verdict/);
	});

	it("keeps every file claim where the oracle could not be read, and says so", async () => {
		oracleFails = true;
		warm(1, "one", { writeSet: ["scripts/a.js"] });
		const r = await here({
			issues: [{ number: 1, body: "one" }],
			heldFiles: { "scripts/a.js": "whoever" },
		});
		expect(block(r.out)).toMatch(/ruled out by a running session/);
		expect(block(r.out)).toMatch(/CLAIMS DEGRADED/);
		expect(block(r.out)).toMatch(/may be free/);
	});

	describe("bandReadRequired — skip the band read when empty (mantahostels#1485)", () => {
		it("is false and says so where nothing is nominated and nothing is cold", async () => {
			warm(1, "one", { writeSet: ["scripts/a.js"], sizeBand: "small" });
			const r = await here({ issues: [{ number: 1, body: "one" }] }, [
				"--json",
			]);
			expect(r.json().bandReadRequired).toBe(false);
			const text = await here({ issues: [{ number: 1, body: "one" }] });
			expect(block(text.out)).toMatch(/NO BAND READ REQUIRED THIS RUN/);
		});

		it("is true where the nomination list is non-empty", async () => {
			stubRepo(["scripts/a.js"]);
			const r = await here(
				{
					issues: [
						{ number: 1, body: "edits `scripts/a.js`" },
						{ number: 2, body: "also edits `scripts/a.js`" },
					],
				},
				["--json"],
			);
			expect(r.json().conflictGraph.nominated.length).toBeGreaterThan(0);
			expect(r.json().bandReadRequired).toBe(true);
			const text = await here({
				issues: [
					{ number: 1, body: "edits `scripts/a.js`" },
					{ number: 2, body: "also edits `scripts/a.js`" },
				],
			});
			expect(block(text.out)).toMatch(/BAND READ REQUIRED THIS RUN/);
		});

		it("is true on a cold entry alone, even with nothing nominated (mantahostels#1485's cold widening)", async () => {
			const r = await here(
				{
					issues: [
						{ number: 1, body: "`scripts/a.js`", labels: ["wayfinder:map"] },
					],
				},
				["--json"],
			);
			expect(r.json().conflictGraph.nominated).toEqual([]);
			expect(r.json().writeSetCache.cold.length).toBeGreaterThan(0);
			expect(r.json().bandReadRequired).toBe(true);
		});

		it("stays false on an already-mergeable warm pair — skipping forecloses no merge already in reach", async () => {
			warm(1, "one", { writeSet: ["scripts/a.js"], sizeBand: "small" });
			warm(2, "two", { writeSet: ["scripts/a.js"], sizeBand: "small" });
			const r = await here(
				{
					issues: [
						{ number: 1, body: "one" },
						{ number: 2, body: "two" },
					],
				},
				["--json"],
			);
			expect(r.json().conflictGraph.nominated).toEqual([]);
			expect(r.json().conflictGraph.mergeable.length).toBeGreaterThan(0);
			expect(r.json().bandReadRequired).toBe(false);
		});
	});
});

describe("the run summary (mantahostels#1001)", () => {
	/** The RUN SUMMARY block alone, so a match cannot land in another block. */
	const block = (out: string) =>
		out.split("RUN SUMMARY")[1]?.split("\nAdvisory only")[0] ?? "";

	it("carries the frontier count, the admission verdict and the shortlist size", async () => {
		const r = await run({
			issues: [
				{ number: 1, body: "one" },
				{ number: 2, body: "two" },
				{ number: 3, body: "three" },
			],
		});
		expect(block(r.out)).toMatch(/open issues +3/);
		expect(block(r.out)).toMatch(/frontier +3/);
		expect(block(r.out)).toMatch(/admission +START ONE NOW/);
	});

	it("gives the frontier, never the --limit slice, as the accounting denominator", async () => {
		const r = await run(
			{
				issues: [
					{ number: 1, body: "one" },
					{ number: 2, body: "two" },
					{ number: 3, body: "three" },
				],
			},
			["--limit", "1"],
		);
		expect(block(r.out)).toMatch(/frontier +3 /);
		expect(block(r.out)).toMatch(/shown +1/);
	});

	it("names the frontier issues whose takes: label is missing or doubled", async () => {
		const r = await run({
			issues: [
				{ number: 1, body: "one", labels: [] },
				{ number: 2, body: "two", labels: ["takes:implement", "takes:triage"] },
				{ number: 3, body: "three", labels: ["takes:implement"] },
			],
		});
		expect(block(r.out)).toMatch(
			/labelling +#1 \(none\), #2 \(implement\+triage\)/,
		);
		expect(block(r.out)).toMatch(/check-issue-labels\.js/);
		// mantahostels#3 carries exactly one value, so the labelling line must not name it —
		// asserted on that line alone, since the proposed set names it legitimately.
		const labelling = block(r.out)
			.split("\n")
			.find((l) => l.includes("labelling"));
		expect(labelling).not.toMatch(/#3/);
	});

	it("says nothing about labelling when every frontier issue carries one value", async () => {
		const r = await run({
			issues: [{ number: 1, body: "one", labels: ["takes:implement"] }],
		});
		expect(block(r.out)).not.toMatch(/labelling/);
	});

	it("reports the readiness-unknown count, and stays silent when there is none", async () => {
		const clean = await run({ issues: [{ number: 1, body: "one" }] });
		expect(block(clean.out)).not.toMatch(/degraded/);
		const r = await run({
			issues: [{ number: 1, body: "one" }],
			failDeps: [1],
		});
		expect(block(r.out)).toMatch(/degraded +1 readiness unknown/);
	});

	it("reports reclaimable sessions, which mean the headroom is understated", async () => {
		oracleSessions = ["self", "done-one"];
		oracleFinished = ["done-one"];
		const r = await run({ issues: [{ number: 1, body: "one" }] });
		expect(block(r.out)).toMatch(/reclaimable +1 /);
		expect(block(r.out)).toMatch(/headroom understated/);
	});

	it("splits the write-set cache into warm, provisional and to-derive", async () => {
		writeSetCache.writeEntry(repoRoot, {
			issue: 1,
			bodyHash: writeSetCache.bodyHash("one"),
			writeSet: ["scripts/a.js"],
			trackedAtDerive: [],
			sizeBand: "small",
			gist: "what it does",
		});
		const r = await run(
			{
				issues: [
					{ number: 1, body: "one" },
					{ number: 2, body: "two" },
				],
			},
			[],
			{ ownRepo: true },
		);
		expect(block(r.out)).toMatch(
			/write-sets +1 warm, 1 provisional, 0 to derive/,
		);
	});

	it("carries every summary figure into --json, so a reader makes one read", async () => {
		const r = await run(
			{
				issues: [
					{ number: 1, body: "one", labels: [] },
					{ number: 2, body: "two", labels: ["takes:implement"] },
				],
			},
			["--json", "--limit", "1"],
		);
		const s = r.json().summary;
		expect(s.openIssues).toBe(2);
		expect(s.frontierCount).toBe(2);
		expect(s.shown).toBe(1);
		expect(s.admit).toBe(true);
		expect(s.degraded).toBe(0);
		expect(s.labelDefects).toEqual([{ number: 1, takes: [] }]);
		expect(s.writeSets).toEqual({ warm: 0, provisional: 0, cold: 0 });
	});

	it("gives each proposed member the takes: value and write-set §6's line needs", async () => {
		stubRepo(["scripts/a.js"]);
		const r = await run(
			{
				issues: [
					{
						number: 1,
						body: "writes `scripts/a.js`",
						labels: ["takes:implement"],
					},
				],
			},
			["--json"],
			{ ownRepo: true },
		);
		expect(r.json().summary.proposed).toEqual([
			{ number: 1, takes: ["implement"], writeSet: ["scripts/a.js"] },
		]);
	});

	it("gives a proposed member its takes: value even below the --limit cut", async () => {
		// `graph.proposed` covers the whole frontier, so looking `takes:` up in
		// the printed slice reported `[]` for anything --limit cut (mantahostels#3363).
		stubRepo(["scripts/a.js", "scripts/b.js"]);
		const r = await run(
			{
				issues: [
					{
						number: 1,
						body: "writes `scripts/a.js`",
						labels: ["takes:implement"],
					},
					{
						number: 2,
						body: "writes `scripts/b.js`",
						labels: ["takes:to-spec"],
					},
				],
			},
			["--json", "--limit", "1"],
			{ ownRepo: true },
		);
		const s = r.json().summary;
		expect(s.shown).toBe(1);
		expect(s.proposed).toEqual([
			{ number: 1, takes: ["implement"], writeSet: ["scripts/a.js"] },
			{ number: 2, takes: ["to-spec"], writeSet: ["scripts/b.js"] },
		]);
	});

	it("reports a label defect on a frontier issue --limit cut from the table", async () => {
		// mantahostels#3363: `labelDefects` was filtered over `shown`, so a defect below the
		// cut went unreported. The frontier order is asserted because the
		// assertion below only bites while mantahostels#2 is the issue `--limit` cuts.
		const r = await run(
			{
				issues: [
					{ number: 1, body: "one", labels: ["takes:implement"] },
					{ number: 2, body: "two", labels: [] },
				],
			},
			["--json", "--limit", "1"],
		);
		const s = r.json().summary;
		expect(s.shown).toBe(1);
		expect(r.json().frontier.map((i: { number: number }) => i.number)).toEqual([
			1, 2,
		]);
		expect(s.labelDefects).toEqual([{ number: 2, takes: [] }]);
	});

	it("prints a --limit-cut issue's label defect on the labelling row", async () => {
		const r = await run(
			{
				issues: [
					{ number: 1, body: "one", labels: ["takes:implement"] },
					{ number: 2, body: "two", labels: [] },
				],
			},
			["--limit", "1"],
		);
		expect(r.status).toBe(0);
		expect(block(r.out)).toMatch(/labelling +#2 \(none\)/);
		expect(block(r.out)).toMatch(/check-issue-labels\.js/);
	});

	it("prints the proposed set as a count, never as its numbers", async () => {
		stubRepo(["scripts/a.js", "scripts/b.js"]);
		const r = await run(
			{
				issues: [
					{ number: 1, body: "writes `scripts/a.js`" },
					{ number: 2, body: "writes `scripts/b.js`" },
				],
			},
			[],
			{ ownRepo: true },
		);
		const line = block(r.out)
			.split("\n")
			.find((l) => l.includes("proposed set"));
		expect(line).toMatch(/2 candidates/);
		expect(line).not.toMatch(/#1/);
	});

	it("names the admission figures as this run's, and sends the reader to re-read them", async () => {
		const r = await run({ issues: [{ number: 1, body: "one" }] });
		expect(block(r.out)).toMatch(
			/admission .*as of this run — re-read it with node scripts\/admission\.js/,
		);
	});

	it("holds, and says so, when the machine has no room", async () => {
		// A second live session: with none, the always-admit-one rule admits
		// whatever the headroom.
		oracleSessions = ["self", "other"];
		psOut = sessionProcs("other").join("\n");
		memAvailableKb = 200 * 1024;
		const r = await run({ issues: [{ number: 1, body: "one" }] }, ["--json"]);
		expect(r.status).toBe(0);
		expect(r.json().summary.admit).toBe(false);
	});

	it("carries the owed-work counts, and prints unknown where the store will not read", async () => {
		const counted = await run({
			issues: [{ number: 1, body: "one" }],
			debts: [{ path: "scripts/a.js", issue: 9 }],
		});
		expect(block(counted.out)).toMatch(/owed work +1 debt entries/);
		const r = await run({
			issues: [{ number: 1, body: "one" }],
			debtsUnreadable: true,
		});
		expect(block(r.out)).toMatch(/owed work +unknown debt entries/);
	});

	/*
	 * mantahostels#1780: the summary's `carrying` figure is null two ways — nobody asked git,
	 * or git would not answer — and only the second may be reported as "unknown
	 * how many carrying", which claims git WAS asked.
	 */
	it("drops the carrying parenthetical when the stranded count itself is unknown", async () => {
		oracleSessions = ["self"];
		stubRepo(["scripts/dirty.js"]);
		const counted = await run({
			issues: [{ number: 1, body: "one" }],
			staleFiles: {
				a: { path: "scripts/dirty.js", sessionId: "dead-1", hoursAgo: 24 },
			},
		});
		expect(block(counted.out)).toMatch(
			/1 stranded claims \(1 carrying uncommitted work\)/,
		);

		oracleFails = true;
		const r = await run({ issues: [{ number: 1, body: "one" }] });
		expect(block(r.out)).toMatch(/unknown stranded claims/);
		expect(block(r.out)).not.toMatch(/carrying uncommitted work/);
	});

	it("reports a failed reclaimable probe as unknown, never as silence a reader reads as zero", async () => {
		oracleSelfId = "";
		oracleSessions = ["self", "a"];
		oracleFinished = ["a"];
		const r = await run({ issues: [{ number: 1, body: "one" }] });
		expect(block(r.out)).toMatch(/reclaimable +unknown \(/);
		expect(block(r.out)).toMatch(/CLAUDE_CODE_SESSION_ID/);
		const s = (
			await run({ issues: [{ number: 1, body: "one" }] }, ["--json"])
		).json().summary;
		expect(s.reclaimable).toBeNull();
		expect(s.reclaimableUnknown).toMatch(/CLAUDE_CODE_SESSION_ID/);
	});

	it("exits 0 on every summary above", async () => {
		const r = await run({ issues: [{ number: 1, body: "one" }] });
		expect(r.status).toBe(0);
	});
});

/*
 * mantahostels#1528: the launcher records every launch to `.pick-next/dispatched.jsonl` and
 * drops a set member whose issues are already there, so a run that ranks one
 * spends a set slot on a line the launcher will delete — under-dispatching, and
 * counting a non-takeable issue in §5's accounting denominator.
 */
describe("issues the launcher has already dispatched", () => {
	it("holds a recently dispatched issue out of the frontier", async () => {
		const r = await run({
			issues: [{ number: 1 }, { number: 2 }],
			dispatched: [{ issues: [2], prompt: "/implement 2" }],
		});
		expect(r.order()).toEqual([1]);
	});

	it("names the launch that excluded it, with its age and prompt", async () => {
		const r = await run({
			issues: [{ number: 2 }],
			dispatched: [{ issues: [2], prompt: "/implement 2 7", hoursAgo: 0.5 }],
		});
		expect(r.out).toMatch(/#2\s+0\.5h ago — \/implement 2 7/);
	});

	it("re-admits one whose launch the refill loop handed off, inside the window (#2744)", async () => {
		const r = await run({
			issues: [{ number: 1 }, { number: 2 }, { number: 3 }],
			dispatched: [
				{ issues: [2], jobId: "job2", released: true },
				{ issues: [3], jobId: "job3" },
			],
		});
		expect(r.order()).toEqual([1, 2]);
	});

	it("re-admits one whose ledger entry has aged out of the window", async () => {
		const r = await run({
			issues: [{ number: 2 }],
			dispatched: [{ issues: [2], hoursAgo: 1.5 }],
		});
		expect(r.order()).toEqual([2]);
	});

	it("excludes even though no session from that launch is still listed", async () => {
		// oracleSessions is ["self"] alone, so the launch's session has exited:
		// the ledger limb is deliberately unconditional inside the window.
		const r = await run({
			issues: [{ number: 2 }],
			dispatched: [{ issues: [2] }],
		});
		expect(r.order()).toEqual([]);
	});

	it("prints the block, the launcher's window and the --force way past it", async () => {
		const r = await run({
			issues: [{ number: 1 }, { number: 2 }],
			dispatched: [{ issues: [2] }],
		});
		expect(r.out).toContain("ALREADY DISPATCHED (1)");
		expect(r.out).toContain("1h after launching it");
		expect(r.out).toContain("scripts/dispatch-sessions.sh --force");
	});

	it("takes the excluded issue out of the frontier count the summary prints", async () => {
		const r = await run({
			issues: [{ number: 1 }, { number: 2 }],
			dispatched: [{ issues: [2] }],
		});
		expect(r.out).toMatch(/frontier\s+1 —/);
		expect(r.out).toMatch(/dispatched\s+1 held out on a launch in the last 1h/);
	});

	it("never reports a dispatched issue as assigned-but-unclaimed", async () => {
		const r = await run({
			issues: [{ number: 2, assignees: ["someone"] }],
			dispatched: [{ issues: [2] }],
		});
		expect(r.out).not.toContain("ASSIGNED BUT UNCLAIMED");
	});

	it("lets a live claim keep the reason, since it names the holder", async () => {
		oracleSessions = ["self", "s1"];
		const r = await run({
			issues: [{ number: 2, assignees: ["someone"] }],
			claims: { 2: "s1" },
			dispatched: [{ issues: [2] }],
		});
		expect(r.out).toMatch(/#2\s+\S*\s*claimed by/);
	});

	it("carries the ledger read into --json, window and all", async () => {
		const r = await run(
			{
				issues: [{ number: 2 }],
				dispatched: [{ issues: [2], prompt: "/implement 2" }],
			},
			["--json"],
		);
		const d = r.json().alreadyDispatched;
		expect(d.windowHours).toBe(1);
		expect(d.degraded).toBeNull();
		expect(d.issues).toHaveLength(1);
		expect(d.issues[0]).toMatchObject({ number: 2, prompt: "/implement 2" });
	});

	/*
	 * mantahostels#3488: the ledger holds an issue out for the whole window regardless of
	 * whether its launch is still running. `liveness` is the join that tells a
	 * finished launch from a live one — read off the ledger's `jobId`, the oracle
	 * listing, and the job's own local `state.json`.
	 */
	describe("whether the dispatched launch's own job is still alive (mantahostels#3488)", () => {
		it("reads live off a working job the oracle still lists", async () => {
			oracleSessions = ["self", "worker1"];
			writeJobState("job1", { state: "working", sessionId: "worker1" });
			const r = await run(
				{
					issues: [{ number: 2 }],
					dispatched: [{ issues: [2], jobId: "job1" }],
				},
				["--json"],
			);
			expect(r.json().alreadyDispatched.issues[0].liveness).toBe("live");
		});

		it("prints live in the text table's liveness column", async () => {
			oracleSessions = ["self", "worker1"];
			writeJobState("job1", { state: "working", sessionId: "worker1" });
			const r = await run({
				issues: [{ number: 2 }],
				dispatched: [{ issues: [2], jobId: "job1" }],
			});
			expect(r.out).toMatch(/^ {2}#2\s.*\blive\b/m);
		});

		it("reads finished: done off a job whose own state.json reads done", async () => {
			// No oracle entry at all: a finished job can fall out of `claude
			// agents --json` on its own, and the job's own record is trusted
			// outright once it reads a terminal state (this function's header).
			writeJobState("job1", { state: "done", sessionId: "worker1" });
			const r = await run(
				{
					issues: [{ number: 2 }],
					dispatched: [{ issues: [2], jobId: "job1" }],
				},
				["--json"],
			);
			expect(r.json().alreadyDispatched.issues[0].liveness).toBe(
				"finished: done",
			);
		});

		it("prints finished: done in the text table", async () => {
			writeJobState("job1", { state: "done", sessionId: "worker1" });
			const r = await run({
				issues: [{ number: 2 }],
				dispatched: [{ issues: [2], jobId: "job1" }],
			});
			expect(r.out).toMatch(/^ {2}#2\s.*\bfinished: done\b/m);
		});

		it("reads finished off the oracle's own terminal state where the job record only says working", async () => {
			oracleSessions = ["self", "worker1"];
			oracleFinished = ["worker1"];
			writeJobState("job1", { state: "working", sessionId: "worker1" });
			const r = await run(
				{
					issues: [{ number: 2 }],
					dispatched: [{ issues: [2], jobId: "job1" }],
				},
				["--json"],
			);
			expect(r.json().alreadyDispatched.issues[0].liveness).toBe(
				"finished: oracle reads it terminal",
			);
		});

		it("reads unknown, never live, on a pre-mantahostels#3488 entry with no job id", async () => {
			oracleSessions = ["self", "worker1"];
			const r = await run(
				{
					issues: [{ number: 2 }],
					dispatched: [{ issues: [2] }],
				},
				["--json"],
			);
			expect(r.json().alreadyDispatched.issues[0].liveness).toBe("unknown");
		});

		it("prints unknown, never live, in the text table on a pre-mantahostels#3488 entry with no job id", async () => {
			oracleSessions = ["self", "worker1"];
			const r = await run({
				issues: [{ number: 2 }],
				dispatched: [{ issues: [2] }],
			});
			expect(r.out).toMatch(/^ {2}#2\s.*\bunknown\b/m);
			expect(r.out).not.toMatch(/^ {2}#2\s.*\blive\b/m);
		});

		it("reads unknown, never live, where the job id names no readable job record", async () => {
			oracleSessions = ["self"];
			// A different job's state.json makes the store itself readable
			// (jobs !== null), so the "ghost" lookup exercises "no job record
			// found for ghost" rather than the un-opened-store branch.
			writeJobState("job1", { state: "working", sessionId: "worker1" });
			const r = await run(
				{
					issues: [{ number: 2 }],
					dispatched: [{ issues: [2], jobId: "ghost" }],
				},
				["--json"],
			);
			expect(r.json().alreadyDispatched.issues[0].liveness).toBe("unknown");
			expect(r.json().alreadyDispatched.issues[0].livenessWhy).toMatch(/ghost/);
		});
	});

	it("excludes nothing on a ledger it cannot read, and says so", async () => {
		const r = await run({
			issues: [{ number: 1 }, { number: 2 }],
			dispatchLedgerUnreadable: true,
		});
		expect(r.order()).toEqual([1, 2]);
		expect(r.out).toContain("DISPATCH LEDGER DEGRADED");
		expect(r.out).toMatch(/dispatched\s+unknown \(/);
	});

	it("says nothing at all when no launch has ever been recorded", async () => {
		const r = await run({ issues: [{ number: 1 }] });
		expect(r.out).not.toContain("ALREADY DISPATCHED");
		expect(r.out).not.toContain("DISPATCH LEDGER DEGRADED");
		expect(r.out).toMatch(/dispatched\s+0 held out on a launch in the last 1h/);
	});

	describe("keyed on issue and command (#752)", () => {
		it("re-admits an issue relabelled to a different command since its launch", async () => {
			const r = await run({
				issues: [{ number: 2, labels: ["takes:wayfinder"] }],
				dispatched: [{ issues: [2], prompt: "/triage 2" }],
			});
			expect(r.order()).toEqual([2]);
			expect(r.out).not.toContain("ALREADY DISPATCHED");
		});

		it("still holds one whose takes: value is the command it was launched under", async () => {
			const r = await run({
				issues: [{ number: 2, labels: ["takes:triage"] }],
				dispatched: [{ issues: [2], prompt: "/triage 2" }],
			});
			expect(r.order()).toEqual([]);
			expect(r.out).toContain("ALREADY DISPATCHED (1)");
		});

		it("holds on an entry whose prompt carries no readable command", async () => {
			const r = await run({
				issues: [{ number: 2, labels: ["takes:wayfinder"] }],
				dispatched: [{ issues: [2], prompt: "2" }],
			});
			expect(r.order()).toEqual([]);
		});

		it("holds an issue carrying no takes: value, having nothing to compare", async () => {
			const r = await run({
				issues: [{ number: 2 }],
				dispatched: [{ issues: [2], prompt: "/triage 2" }],
			});
			expect(r.order()).toEqual([]);
		});

		it("reads every entry on the issue, not only the latest", async () => {
			const r = await run({
				issues: [{ number: 2, labels: ["takes:wayfinder"] }],
				dispatched: [
					{ issues: [2], prompt: "/wayfinder 2", hoursAgo: 0.8 },
					{ issues: [2], prompt: "/triage 2", hoursAgo: 0.3 },
				],
			});
			expect(r.order()).toEqual([]);
			expect(r.out).toMatch(/#2\s+0\.8h ago — \/wayfinder 2/);
		});
	});
});

/*
 * The review of mantahostels#1528 found three defects in the first implementation: the held
 * issues printed under both ALREADY DISPATCHED and EXCLUDED; the block and its
 * counts keyed off the ledger rather than off the exclusion that actually
 * fired, so a claimed issue was reported as dispatch-held too; and the picker
 * passed its own WFC_REPO_ROOT while the launcher resolves
 * WFC_DISPATCH_ROOT first, so the two could read different ledgers.
 */
describe("what the mantahostels#1528 review caught", () => {
	it("prints a held issue once, under its own block and not under EXCLUDED", async () => {
		const r = await run({
			issues: [{ number: 1 }, { number: 2 }],
			dispatched: [{ issues: [2] }],
		});
		const excluded = r.out.split("\nEXCLUDED\n")[1] ?? "";
		expect(r.out).toContain("ALREADY DISPATCHED (1)");
		expect(excluded).not.toMatch(/^#2\s/m);
		// Still accounted for, so the table is not silently short.
		expect(excluded).toContain("1 more excluded as already dispatched");
	});

	it("leaves a claimed issue out of the dispatched block and its count", async () => {
		oracleSessions = ["self", "s1"];
		const r = await run({
			issues: [{ number: 1 }, { number: 2, assignees: ["someone"] }],
			claims: { 2: "s1" },
			dispatched: [{ issues: [2] }],
		});
		expect(r.out).not.toContain("ALREADY DISPATCHED");
		expect(r.out).toMatch(/dispatched\s+0 held out on a launch/);
		// It is excluded, and the reason printed is the claim, which names a holder.
		expect(r.out.split("\nEXCLUDED\n")[1]).toMatch(/^#2\s+\S*\s*claimed by/m);
	});

	it("counts only the dispatch-held issues in --json, not every ledger hit", async () => {
		oracleSessions = ["self", "s1"];
		const r = await run(
			{
				issues: [{ number: 2, assignees: ["someone"] }, { number: 3 }],
				claims: { 2: "s1" },
				dispatched: [{ issues: [2, 3] }],
			},
			["--json"],
		);
		expect(
			r
				.json()
				.alreadyDispatched.issues.map((i: { number: number }) => i.number),
		).toEqual([3]);
	});

	it("reads the ledger WFC_DISPATCH_ROOT names, as the launcher does", async () => {
		// The ledger goes somewhere WFC_REPO_ROOT does not point at, so a run
		// that resolved its own root would find nothing and offer mantahostels#2 as takeable.
		const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "pick-next-led-"));
		roots.push(elsewhere);
		fs.mkdirSync(
			path.join(elsewhere, ".claude", "tmp", "markers", ".pick-next"),
			{ recursive: true },
		);
		fs.writeFileSync(
			path.join(
				elsewhere,
				".claude",
				"tmp",
				"markers",
				".pick-next",
				"dispatched.jsonl",
			),
			`${JSON.stringify({
				ts: new Date().toISOString(),
				issues: [2],
				model: "opus",
				prompt: "/implement 2",
				session: "gone",
			})}\n`,
		);
		process.env.WFC_DISPATCH_ROOT = elsewhere;
		try {
			const r = await run({ issues: [{ number: 1 }, { number: 2 }] });
			expect(r.order()).toEqual([1]);
			expect(r.out).toContain("ALREADY DISPATCHED (1)");
		} finally {
			delete process.env.WFC_DISPATCH_ROOT;
		}
	});
});

describe("the band no command opens — §5's third accounting term (mantahostels#1626)", () => {
	/** The RUN SUMMARY block alone, so a match cannot land in another block. */
	const block = (out: string) =>
		out.split("RUN SUMMARY")[1]?.split("\nAdvisory only")[0] ?? "";

	it("counts a takes:human issue, which no /-command opens", async () => {
		const r = await run({
			issues: [
				{ number: 1, labels: ["takes:implement"] },
				{ number: 2, labels: ["takes:human"] },
			],
		});
		expect(block(r.out)).toMatch(/frontier +2/);
		expect(block(r.out)).toMatch(/no command +1/);
	});

	it("prints the row at zero, so the term is never read as unowed", async () => {
		const r = await run({
			issues: [{ number: 1, labels: ["takes:implement"] }],
		});
		expect(block(r.out)).toMatch(/no command +0/);
	});

	it("counts a takes:children container whose last child has closed", async () => {
		// On the frontier that is the only takes:children issue there is — the
		// exclusion cascade holds a live container off it (mantahostels#1622).
		const r = await run({
			issues: [
				{ number: 1, labels: ["takes:implement"] },
				{ number: 2, labels: ["takes:children"] },
			],
		});
		expect(block(r.out)).toMatch(/no command +1/);
		expect(block(r.out)).toMatch(/rotted containers: #2/);
	});

	it("counts nothing for a container still holding an open child", async () => {
		// It never reaches the frontier, so it is neither in `<F>` nor in `<U>`.
		const r = await run({
			issues: [
				{ number: 1, labels: ["takes:children"] },
				{ number: 2, labels: ["takes:implement"], parent: 1 },
			],
		});
		expect(r.out).toMatch(/#1\s+\S*\s*container — 1 open children/);
		expect(block(r.out)).toMatch(/frontier +1/);
		expect(block(r.out)).toMatch(/no command +0/);
		expect(block(r.out)).not.toMatch(/rotted containers/);
	});

	it("counts nothing for a takes:human issue an open blocker excluded", async () => {
		// `<U>` is a term of a sum whose denominator is the frontier, so counting
		// one off it would put the line permanently above `<F>` and refuse every
		// honest accounting.
		const r = await run({
			issues: [
				{ number: 1, labels: ["takes:implement"] },
				{ number: 2, labels: ["takes:human"] },
			],
			deps: { 2: [{ number: 9, state: "open" }] },
		});
		expect(r.out).toMatch(/#2\s+\S*\s*blocked by #9/);
		expect(block(r.out)).toMatch(/frontier +1/);
		expect(block(r.out)).toMatch(/no command +0/);
	});

	it("names no rotted container where the band is takes:human alone", async () => {
		const r = await run({
			issues: [
				{ number: 1, labels: ["takes:implement"] },
				{ number: 2, labels: ["takes:human"] },
			],
		});
		expect(block(r.out)).not.toMatch(/rotted containers/);
	});

	it("counts the whole frontier, never the --limit slice", async () => {
		// `<U>` is a term of an accounting whose denominator is the frontier, so a
		// display cap that moved it would make every honest line fail the pin.
		const r = await run(
			{
				issues: [
					{ number: 1, labels: ["takes:implement"] },
					{ number: 2, labels: ["takes:human"] },
					{ number: 3, labels: ["takes:human"] },
				],
			},
			["--limit", "1"],
		);
		expect(block(r.out)).toMatch(/no command +2/);
	});

	it("joins several rotted containers, which is the measured case", async () => {
		// mantahostels#1622 counted three at once on the runs it measured, so the single-mantahostels#2
		// case never exercises the join.
		const r = await run({
			issues: [
				{ number: 1, labels: ["takes:implement"] },
				{ number: 2, labels: ["takes:children"] },
				{ number: 3, labels: ["takes:children"] },
				{ number: 4, labels: ["takes:children"] },
			],
		});
		expect(block(r.out)).toMatch(/no command +3/);
		expect(block(r.out)).toMatch(/rotted containers: #2, #3, #4/);
	});

	it("prints the row under --no-log, which mints no marker", async () => {
		// mantahostels#1626's Done-when is written against a --no-log run, and that flag
		// suppresses the marker and the warm-fraction line, not the output.
		const r = await run(
			{
				issues: [
					{ number: 1, labels: ["takes:implement"] },
					{ number: 2, labels: ["takes:human"] },
				],
			},
			["--no-log"],
		);
		expect(block(r.out)).toMatch(/no command +1/);
	});

	it("carries the count and the rotted numbers in --json", async () => {
		const r = await run(
			{
				issues: [
					{ number: 1, labels: ["takes:implement"] },
					{ number: 2, labels: ["takes:human"] },
					{ number: 3, labels: ["takes:children"] },
				],
			},
			["--json"],
		);
		expect(r.json().summary.noCommand).toBe(2);
		expect(r.json().summary.rottedContainers).toEqual([3]);
	});

	it("records the count on the marker the guard pins against", async () => {
		const r = await run(
			{
				issues: [
					{ number: 1, labels: ["takes:implement"] },
					{ number: 2, labels: ["takes:human"] },
				],
			},
			[],
			{ ownRepo: true },
		);
		expect(r.status).toBe(0);
		expect(selectionMarker.read(repoRoot, oracleSelfId)?.noCommand).toBe(1);
	});
});

describe("why each frontier issue did not launch, and the open tally (#591)", () => {
	const here = (fx: Fixture, args: string[] = []) =>
		run(fx, args, { ownRepo: true });
	const warm = (
		number: number,
		body: string,
		fields: Record<string, unknown>,
	) =>
		writeSetCache.writeEntry(repoRoot, {
			issue: number,
			bodyHash: writeSetCache.bodyHash(body),
			trackedAtDerive: [],
			sizeBand: "M",
			gist: "what it does",
			...fields,
		});
	const reasons = (j: { notLaunched: { number: number; reason: string }[] }) =>
		Object.fromEntries(j.notLaunched.map((e) => [e.number, e.reason]));

	it("fills every reason the script can know, with its detail", async () => {
		oracleSessions = ["self", "worker"];
		oracleNames = { worker: "Implement 900" };
		warm(1, "one", { writeSet: ["scripts/a.js"] });
		warm(2, "two", { writeSet: ["scripts/a.js"] });
		warm(3, "three", { writeSet: ["scripts/held.js"] });
		const j = (
			await here(
				{
					issues: [
						{ number: 1, body: "one", labels: ["takes:implement"] },
						{ number: 2, body: "two", labels: ["takes:implement"] },
						{ number: 3, body: "three", labels: ["takes:implement"] },
						{ number: 4, labels: ["takes:human"] },
					],
					heldFiles: { "scripts/held.js": "worker" },
				},
				["--json"],
			)
		).json();
		expect(j.notLaunched).toEqual([
			{
				number: 2,
				reason: "shares a file",
				detail: { with: 1, file: "scripts/a.js", provisional: true },
			},
			{
				number: 3,
				reason: "file held by a running session",
				detail: {
					files: ["scripts/held.js"],
					session: "Implement 900",
					sessionId: "worker",
				},
			},
			{ number: 4, reason: "no command", detail: { takes: ["human"] } },
		]);
	});

	it("cuts the set below the slot count as no admission slot", async () => {
		oracleSessions = ["self", "a@601", "b@602"];
		procPssKb = { "601": WORKING_PAIR_KB, "602": WORKING_PAIR_KB };
		psOut = [...sessionProcs("a"), ...sessionProcs("b")].join("\n");
		// 2706 − 212 − 794 − 300 = 1400 MB: 3 more need 1432 and two pairs.
		memAvailableKb = 2706 * 1024;
		const j = (
			await run(
				{
					issues: [1, 2, 3, 4, 5].map((number) => ({
						number,
						labels: ["takes:implement"],
					})),
				},
				["--json"],
			)
		).json();
		expect(j.admission.freeSlots).toBe(2);
		expect(reasons(j)).toEqual({
			3: "no admission slot",
			4: "no admission slot",
			5: "no admission slot",
		});
		expect(j.notLaunched[0].detail).toEqual({ slots: 2, freeSlots: 2 });
	});

	it("gives an issue matching two reasons the earlier one", async () => {
		oracleSessions = ["self", "worker"];
		warm(1, "one", { writeSet: ["scripts/held.js"] });
		const j = (
			await here(
				{
					issues: [{ number: 1, body: "one", labels: ["takes:human"] }],
					heldFiles: { "scripts/held.js": "worker" },
				},
				["--json"],
			)
		).json();
		expect(reasons(j)).toEqual({ 1: "no command" });
	});

	it("counts an issue merged into a set member's line as launched", async () => {
		warm(1, "one", { writeSet: ["scripts/a.js"], sizeBand: "small" });
		warm(2, "two", { writeSet: ["scripts/a.js"], sizeBand: "small" });
		const j = (
			await here(
				{
					issues: [
						{ number: 1, body: "one", labels: ["takes:implement"] },
						{ number: 2, body: "two", labels: ["takes:implement"] },
					],
				},
				["--json"],
			)
		).json();
		expect(j.conflictGraph.proposed).toEqual([1]);
		expect(j.notLaunched).toEqual([]);
	});

	const retro = "Standalone: retro-sweep finding (#948)";

	/**
	 * The sessions guard-selection-sum.js keys `lines` on, run as Claude Code
	 * runs it at Stop over a wave-1 turn of this run's own marker, and read back
	 * off the wave it records there.
	 */
	const guardSessionKeys = (lines: string[], frontier: number) => {
		const transcript = path.join(dir, "guard-transcript.jsonl");
		const text = [
			...lines,
			`Wave 1 of 2 — frontier ${frontier}: ${frontier - 1} dispatched + 0 disqualified + 0 no command + 1 pending band read.`,
			"**Admission cut:** none.",
		].join("\n");
		fs.writeFileSync(
			transcript,
			`${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } })}\n`,
		);
		const env: NodeJS.ProcessEnv = {
			...process.env,
			WFC_REPO_ROOT: repoRoot as string,
		};
		/* Off, or a suite run from a background job arms the completion-mark limb. */
		delete env.CLAUDE_JOB_DIR;
		const r = runInProcess(
			path.resolve(__dirname, "guard-selection-sum.js"),
			[],
			{
				stdin: JSON.stringify({
					session_id: oracleSelfId,
					transcript_path: transcript,
				}),
				env,
			},
		);
		expect(r.stdout.trim(), "the guard must pass the wave-1 turn").toBe("");
		return selectionMarker.read(repoRoot, oracleSelfId)?.wave?.keys;
	};
	const nineFindings = () =>
		Array.from({ length: 9 }, (_, k) => ({
			number: 10 + k,
			body: retro,
			labels: ["takes:triage"],
		}));
	const nineBundled = [
		[10, 11, 12, 13, 14],
		[15, 16, 17, 18],
	];

	it("launches retro findings as bundles of at most 8, one slot each (#1105)", async () => {
		warm(10, retro, { writeSet: ["scripts/a.js"] });
		warm(11, retro, { writeSet: ["scripts/a.js"] });
		const j = (
			await here(
				{
					issues: [
						...nineFindings(),
						{ number: 30, body: "not a finding", labels: ["takes:triage"] },
					],
				},
				["--json"],
			)
		).json();
		expect(j.retroBundles.map((b: RetroLaunch) => b.issues)).toEqual(
			nineBundled,
		);
		// Two bundles plus the lone non-retro triage issue, despite 10 sharing a file with 11.
		expect(j.dispatchableFloor).toBe(3);
		expect(j.notLaunched).toEqual([]);
	});

	it("prints each bundle's line and prompt and carries both in --json, so every reader gets its issues back (#1195, #1206)", async () => {
		const fixture = {
			issues: nineFindings(),
		};
		const bundles: RetroLaunch[] = (await here(fixture, ["--json"])).json()
			.retroBundles;
		const out = (await here(fixture)).out;
		const lines = out
			.split("\n")
			.filter((l) => /^\s+\*\*[\d, ]+\*\* - takes:triage/.test(l));
		expect(guardSessionKeys(lines, 9)).toEqual(
			nineBundled.map((b) => b.join(",")),
		);
		// Line i launches bundle i, so a swap between lines fails here.
		expect(lines.map((l) => l.match(/· (\S+) {4}→ "(.*)"$/)?.slice(1))).toEqual(
			bundles.map((b) => [b.model, b.prompt]),
		);
		expect(bundles.map((b) => issuesIn(b.prompt))).toEqual(nineBundled);
		for (const b of bundles) {
			// The bundle rule the vendored /triage skill lacks (#1195).
			expect(b.prompt).toContain(
				"one decision, one round comment and one brief per issue",
			);
			expect(commandOf(b.prompt)).toBe("triage");
			expect(b.model).toBe(RETRO_BUNDLE_MODEL);
		}
	});

	it("never drops a non-retro issue for a file a retro finding names (#1105)", async () => {
		warm(1, retro, { writeSet: ["scripts/a.js"], sizeBand: "small" });
		warm(2, "two", { writeSet: ["scripts/a.js"], sizeBand: "small" });
		const j = (
			await here(
				{
					issues: [
						{ number: 1, body: retro, labels: ["takes:triage"] },
						{ number: 2, body: "two", labels: ["takes:implement"] },
					],
				},
				["--json"],
			)
		).json();
		expect(j.conflictGraph.proposed).toEqual([2]);
		expect(j.conflictGraph.mergeable).toEqual([]);
		expect(j.dispatchableFloor).toBe(2);
		expect(j.notLaunched).toEqual([]);
	});

	it("tallies the open issues by the EXCLUDED table's own categories", async () => {
		const r = await run({
			issues: [
				{ number: 1, labels: ["takes:implement"] },
				{ number: 2, labels: ["takes:implement"] },
				{ number: 3, labels: ["takes:implement"] },
				{ number: 4, labels: ["takes:implement"] },
				{ number: 5, labels: ["takes:implement"] },
				{ number: 6, labels: ["takes:implement"], assignees: ["me"] },
				{ number: 7, labels: ["takes:children"] },
				{ number: 8, labels: ["takes:implement"], parent: 7 },
			],
			deps: {
				2: [{ number: 99, state: "open" }],
				3: [{ number: 99, state: "open" }],
				4: [{ number: 99, state: "open" }],
				5: [{ number: 99, state: "open" }],
			},
			claims: { 6: "self" },
		});
		const excluded = r.out.split("\nEXCLUDED\n")[1].split("\nNOT PROPOSED")[0];
		expect(excluded.match(/blocked by/g)).toHaveLength(4);
		expect(excluded.match(/claimed by/g)).toHaveLength(1);
		expect(excluded.match(/container —/g)).toHaveLength(1);
		expect(r.out).toMatch(
			/open tally +8 open, 2 frontier, 4 blocked, 1 claimed \(#6\), 1 container \(#7\)\n/,
		);
	});

	it("tallies the gated, dispatched and degraded categories too", async () => {
		const isoIn = (n: number) =>
			new Date(Date.now() + WITA_OFFSET_MS + n * 86_400_000)
				.toISOString()
				.slice(0, 10);
		const j = (
			await run(
				{
					issues: [
						{ number: 1, labels: ["takes:implement"] },
						{
							number: 2,
							body: `**Gated until:** ${isoIn(9)} — later`,
							labels: ["takes:implement"],
						},
						{ number: 3, labels: ["takes:implement"] },
						{ number: 4, labels: ["takes:implement"] },
					],
					dispatched: [{ issues: [3], prompt: "/implement 3" }],
					failDeps: [4],
				},
				["--json"],
			)
		).json();
		const count = (name: string) =>
			j.openTally.categories.find(
				(c: { category: string }) => c.category === name,
			);
		expect(count("gated")).toEqual({
			category: "gated",
			count: 1,
			numbers: [2],
		});
		expect(count("already dispatched")).toEqual({
			category: "already dispatched",
			count: 1,
			numbers: [3],
		});
		expect(count("degraded")).toEqual({
			category: "degraded",
			count: 1,
			numbers: [4],
		});
		expect(j.openTally.frontier).toBe(1);
	});

	it("lists a dropped issue whose mergeable partner is not the one it clashed with", async () => {
		// #3 clashes with #1 on a.js; its merge pair is with #2 on b.js, so
		// nothing carries it.
		warm(1, "one", { writeSet: ["scripts/a.js"], sizeBand: "M" });
		warm(2, "two", { writeSet: ["scripts/b.js"], sizeBand: "small" });
		warm(3, "three", {
			writeSet: ["scripts/a.js", "scripts/b.js"],
			sizeBand: "small",
		});
		const j = (
			await here(
				{
					issues: [
						{ number: 1, body: "one", labels: ["takes:implement"] },
						{ number: 2, body: "two", labels: ["takes:implement"] },
						{ number: 3, body: "three", labels: ["takes:implement"] },
					],
				},
				["--json"],
			)
		).json();
		expect(j.conflictGraph.proposed).toEqual([1, 2]);
		expect(reasons(j)).toEqual({ 3: "shares a file" });
	});

	it("carries the tally in --json with every number, however many", async () => {
		const j = (
			await run(
				{
					issues: [1, 2, 3, 4, 5].map((number) => ({
						number,
						labels: ["takes:implement"],
					})),
					deps: Object.fromEntries(
						[2, 3, 4, 5].map((n) => [n, [{ number: 99, state: "open" }]]),
					),
				},
				["--json"],
			)
		).json();
		expect(j.openTally.open).toBe(5);
		expect(j.openTally.frontier).toBe(1);
		expect(
			j.openTally.categories.find(
				(c: { category: string }) => c.category === "blocked",
			),
		).toEqual({ category: "blocked", count: 4, numbers: [2, 3, 4, 5] });
	});

	it("caps the printed block, grouped by reason, and --json carries all", async () => {
		const issues = Array.from({ length: 25 }, (_, n) => ({
			number: n + 1,
			labels: ["takes:human"],
		}));
		const r = await run({ issues });
		const block = r.out.split("NOT PROPOSED")[1].split("\nRUN SUMMARY")[0];
		expect(block).toMatch(/^ \(25\)/);
		expect(block.match(/^ {2}no command:$/gm)).toHaveLength(1);
		expect(block.match(/^ {4}#\d+ {2}human$/gm)).toHaveLength(20);
		expect(block).toMatch(/\.\.\. and 5 more — --json carries every one\./);
		const j = (await run({ issues }, ["--json"])).json();
		expect(j.notLaunched).toHaveLength(25);
	});

	it("prints none where every frontier issue is in the set", async () => {
		const r = await run({
			issues: [{ number: 1, labels: ["takes:implement"] }],
		});
		expect(r.out).toMatch(/NOT PROPOSED \(0\)[^\n]*\n\n {2}none\n/);
	});
});
