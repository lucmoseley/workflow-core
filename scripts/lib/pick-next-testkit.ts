/*
 * The harness every pick-next test file runs `scripts/pick-next.js` in: a stub
 * `gh` (WFC_GH) serving each case's fixture, so no network, no auth and no
 * dependence on this repo's own issue state, which is the thing the script
 * reports on and so cannot also be its fixture; and a hermetic machine, claim
 * store and tree.
 *
 * `run()` goes through `runInProcessAsync` (mantahostels#1944), which patches process
 * globals for the duration of one call — no `it.concurrent` or
 * `describe.concurrent` in a file that calls it, and none of its `it()`s may
 * overlap. Vitest runs a file's tests sequentially by default; these files
 * rely on that rather than opting out of concurrency themselves.
 *
 * A file calls `installPickNextHarness()` once at its top. `kit` holds the
 * per-case state its tests set before a run.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect } from "vitest";
import {
	BLOCKED_BY_GRAPHQL_FAKE,
	GH_GRAPHQL_NO_REPO,
	GH_LOGGED_OUT,
	GH_NOT_FOUND,
	GH_PARENT_NOT_FOUND,
	RECORDED_SHAPES,
} from "./gh-fake";
import { type GhStubServer, serveGhStub, stubGhScript } from "./gh-stub";
import { loadavgLine, writeCwd, writeSmapsRollup } from "./proc-fake";
import { projectSlug } from "./project-slug.js";
import { writePsStub } from "./ps-stub";
import { runInProcessAsync } from "./run-in-process";
import { shellQuote } from "./sh-quote.js";

/** Each case's state as `beforeEach` resets it. */
const kitDefaults = () => ({
	dir: "",
	/*
	 * The machine admission measures (mantahostels#384). Hermetic by default, like the tree
	 * below: a quiet box with nothing of ours running, so no test reads the real
	 * `/proc/meminfo` or the sessions that happen to be live while it runs.
	 */
	psOut: "",
	psFails: false,
	memAvailableKb: (4096 * 1024) as number | null,
	/** Replaces the whole `/proc/meminfo` where set. */
	meminfoText: null as string | null,
	/** load1 for the stand-in `/proc/loadavg`, against a ceiling of 48 (#830). */
	load1: 0.5,
	/** WFC_SESSION_CEILING (#2141); off unless set, so the runner's core count never holds a slot. */
	sessionCeiling: "0",
	/** WFC_SESSION_FLOOR (#2501); empty is no floor, so the host's ~/.claude/session-floor is never read. */
	sessionFloor: "",
	/** The tree the path annotation resolves backticked tokens against. */
	repoRoot: null as string | null,
	/*
	 * The sessions `claude agents --json` lists. This run's own session is always
	 * one of them — the shared reader refuses a list that omits it — so the count
	 * admission prints is one fewer than the length here.
	 *
	 * An entry may carry `@<pid>` to say which pid that session is, so its
	 * processes are paired with it (mantahostels#1295).
	 */
	oracleSessions: ["self"] as string[],
	oracleFails: false,
	/** Session id -> the display name `claude agents --json` reports, where it has one. */
	oracleNames: {} as Record<string, string>,
	/*
	 * The listed sessions the oracle reports FINISHED but still resident — the
	 * reclaimable pool. Members must also appear in `oracleSessions`; this only
	 * says which of them carry `kind: background` / `state: done`.
	 */
	oracleFinished: [] as string[],
	/** The listed sessions the oracle reads `state: working`, which the session floor counts (#2505). */
	oracleWorking: [] as string[],
	/* Pair PSS in kB by pid, written under the stub /proc. */
	procPssKb: {} as Record<string, number>,
	/* Each pid's cwd, a `cwd` symlink under the stub /proc: a `bg-spare` in its
	 * claim socket's directory is an idle spare (#2502). */
	procCwds: {} as Record<string, string>,
	/** Settable to "", as a cron run or a subshell that does not propagate it leaves it. */
	oracleSelfId: "self",
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
	claimsRepo: null as string | null,
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
	noProjectDir: false,
	runCwd: null as string | null,
});

export const kit = kitDefaults();

/* WITA, UTC+8 with no DST: the clock a date gate is written and read on. */
export const WITA_OFFSET_MS = 8 * 3_600_000;

const SCRIPT = path.resolve(__dirname, "..", "pick-next.js");

export interface Issue {
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
	/** Its `sub_issues_summary` open count, children in every repo (#3658). */
	openSubIssues?: number;
}

export interface Fixture {
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
	/** Issue number -> its `issues/<n>/sub_issues` rows, `repo` naming another (#3658). */
	subIssues?: Record<
		number,
		Array<{ number: number; state: string; repo?: string }>
	>;
	/** Issue numbers whose sub_issues call always fails. */
	failSubIssues?: number[];
	/** Issue numbers whose sub_issues call exits 0 printing nothing. */
	emptySubIssues?: number[];
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
export const CALL_LOG = () => path.join(kit.dir, CALL_LOG_FILE);

/** The calls other than the batched blockers read, whose query text names
 *  `labels` and `issue` as fields it reads. */
export const restCalls = (calls: string[]) =>
	calls.filter((c) => !c.startsWith("api graphql "));

/** Every GraphQL call is a `query`, never a `mutation`. */
export const expectGraphqlReadsOnly = (calls: string[]) => {
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
if (/\\/sub_issues/.test(p)) {
  const n = num(/issues\\/(\\d+)\\/sub_issues/);
  if ((fx.failSubIssues || []).includes(n)) return fail();
  if ((fx.emptySubIssues || []).includes(n)) return;
  return page("subIssuesPage", edges((fx.subIssues || {})[n] || []));
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
    state: "open",
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
    sub_issues_summary: { total: i.openSubIssues || 0, completed: 0, percent_completed: 0 },
  })));
}
die("unexpected path: " + p);
`;

let ghServer: GhStubServer;

/** Points the stub server at `fx` for this run. */
const stubGh = (fx: Fixture) => {
	fs.writeFileSync(path.join(kit.dir, FIXTURE_FILE), JSON.stringify(fx));
	return stubGhScript(kit.dir, ghServer.script);
};
/** A `ps` line as the real one prints it: comm, then the full argv. */
export const buildPsLine = (comm: string, args: string) => `${comm} ${args}`;
/** The two processes one live session is (docs/environment.md). */
export const sessionProcs = (id: string, exe = "claude") => [
	buildPsLine(
		"2.1.233",
		`${exe} bg-pty-host --bg-pty-host /tmp/${id}.pty.sock 200`,
	),
	buildPsLine("2.1.233", `${exe} bg-spare --bg-spare /tmp/${id}.claim.sock`),
];
export const roots: string[] = [];
/** One `git init` per file, copied into each case's tree (base §X8 (1)). */
let repoTemplate: string;
export const stubRepo = (files: string[]) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pick-next-repo-"));
	roots.push(root);
	fs.cpSync(repoTemplate, root, { recursive: true });
	for (const f of files) {
		fs.mkdirSync(path.join(root, path.dirname(f)), { recursive: true });
		fs.writeFileSync(path.join(root, f), "");
	}
	if (files.length > 0) spawnSync("git", ["add", "-A"], { cwd: root });
	kit.repoRoot = root;
};
/** A directory that is no git repository at all, so `git ls-files` fails. */
export const stubBrokenRepo = () => {
	kit.repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pick-next-norepo-"));
	roots.push(kit.repoRoot);
};
/* The draw the admission cases' arithmetic is written at, declared in each
 * fixture repo, so a re-measured DEFAULT_SESSION_DRAW moves none of them
 * (#2231). */
export const FIXTURE_DRAW = { sessionMeanMb: 429, sessionSigmaMb: 154 };
/* A working session's pair, above FIXTURE_DRAW's mean. */
export const WORKING_PAIR_KB = 640 * 1024;
/* The one spare pair admission reserves where no pair is idle (#2223):
 * `IDLE_PAIR_MB` in lib/admission.js. */
export const IDLE_PAIR_MB = 106;
/** A fake `claude` whose `agents --json` lists `oracleSessions`. */
const stubOracle = () => {
	const bin = path.join(kit.dir, "claude");
	fs.writeFileSync(
		bin,
		kit.oracleFails
			? '#!/bin/sh\necho "claude: no daemon" >&2\nexit 1\n'
			: `#!/bin/sh\ncat ${shellQuote(path.join(kit.dir, "agents.json"))}\n`,
		{ mode: 0o755 },
	);
	fs.writeFileSync(
		path.join(kit.dir, "agents.json"),
		JSON.stringify(
			kit.oracleSessions.map((entry) => {
				const [id = "", pid] = entry.split("@");
				return {
					sessionId: id,
					...(pid ? { pid: Number(pid) } : {}),
					/* In the fixture repo, which declares no draw, so each is
					 * charged the default and no problem is printed (#2221). */
					...(kit.repoRoot ? { cwd: kit.repoRoot } : {}),
					...(kit.oracleNames[id] ? { name: kit.oracleNames[id] } : {}),
					/*
					 * `status: busy` deliberately: that is the real `shell` session's
					 * pairing (https://github.com/lucmoseley/workflow-core-tracker/blob/0a69e0d4be03/docs/research/session-state-status-skew.md), so a `status` limb re-added to either
					 * reader would drop these and fail the admission and claim tests in
					 * pick-next-claims.test.ts.
					 */
					...(kit.oracleFinished.includes(id)
						? { kind: "background", state: "done", status: "busy" }
						: {}),
					...(kit.oracleWorking.includes(id) ? { state: "working" } : {}),
				};
			}),
		),
	);
	return { WFC_CLAUDE_BIN: bin, CLAUDE_CODE_SESSION_ID: kit.oracleSelfId };
};
/** Dirs a case locked to 0o000, which rmSync cannot empty until unlocked. */
const lockedDirs: string[] = [];
const stubClaims = (fx: Fixture) => {
	const home = path.join(kit.dir, "home", ".claude");
	const repo =
		kit.claimsRepo ?? kit.repoRoot ?? path.join(kit.dir, "claims-repo");
	fs.mkdirSync(repo, { recursive: true });
	const config = path.join(repo, ".claude", "workflow-core.json");
	if (!fs.existsSync(config)) {
		fs.mkdirSync(path.dirname(config), { recursive: true });
		fs.writeFileSync(config, JSON.stringify(FIXTURE_DRAW));
	}
	const claimsDir = path.join(
		home,
		"projects",
		projectSlug(repo),
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
	const locksDir = path.join(home, "projects", projectSlug(repo), "locks");
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

	const debtsDir = path.join(home, "projects", projectSlug(repo), "debts");
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
	if (fx.debtsUnreadable) {
		fs.chmodSync(debtsDir, 0o000);
		lockedDirs.push(debtsDir);
	}

	return { CLAUDE_CONFIG_DIR: home, CLAUDE_PROJECT_DIR: repo };
};

/**
 * One dispatched job's own local `state.json`, under the same throwaway
 * `CLAUDE_CONFIG_DIR` `stubClaims` points every run at (mantahostels#3488) — the path
 * `dispatchLiveness` reads via `lib/hung-jobs.js#readJobs`.
 */
export const writeJobState = (
	jobId: string,
	rec: { state: string; sessionId?: string },
) => {
	const home = path.join(kit.dir, "home", ".claude");
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
	const root = kit.repoRoot ?? kit.dir;
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
	const ps = writePsStub(kit.dir, kit.psOut ? kit.psOut.split("\n") : [], {
		fails: kit.psFails,
	});
	const meminfo = path.join(kit.dir, "meminfo");
	fs.writeFileSync(
		meminfo,
		kit.meminfoText ??
			`MemTotal:        8114464 kB\nMemFree:          554820 kB\n${
				kit.memAvailableKb === null
					? ""
					: `MemAvailable: ${kit.memAvailableKb} kB\n`
			}`,
	);
	/*
	 * A directory with no numbered subdirs, so `daemonSpareOverheadMb`'s
	 * `readPssKb(pid)` reads never resolve against this host's real /proc — a
	 * fixture pid (111, say) could otherwise coincide with a live process here
	 * and read a real smaps_rollup, making the reservation figure non-hermetic
	 * (mantahostels#1295).
	 */
	const proc = path.join(kit.dir, "proc");
	fs.mkdirSync(proc, { recursive: true });
	for (const [pid, kb] of Object.entries(kit.procPssKb))
		writeSmapsRollup(proc, pid, kb);
	for (const [pid, cwd] of Object.entries(kit.procCwds))
		writeCwd(proc, pid, cwd);
	const loadavg = path.join(kit.dir, "loadavg");
	fs.writeFileSync(loadavg, loadavgLine(kit.load1));
	return {
		WFC_PS: ps,
		WFC_MEMINFO: meminfo,
		WFC_PROC: proc,
		WFC_LOADAVG: loadavg,
		WFC_LOAD_CEILING: "48",
		WFC_SESSION_CEILING: kit.sessionCeiling,
		WFC_SESSION_FLOOR: kit.sessionFloor,
		// The suite queue's dir, so no live lander's marker here holds memory (#2416).
		TMPDIR: kit.dir,
	};
};

/*
 * `ownRepo` drops the `--repo` flag, so the run reads as this tree's own
 * repository. The write-set cache is keyed on the tree alone, so it serves only
 * that case — see "skips the store entirely against another repository" in
 * pick-next-output.test.ts.
 */
export const run = async (
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
		GH_STUB_DIR: kit.dir,
		...stubMachine(),
		...stubOracle(),
		...stubClaims(fx),
		...(kit.repoRoot ? { WFC_REPO_ROOT: kit.repoRoot } : {}),
		/*
		 * Off for run cost and determinism, not for correctness: mantahostels#1960 removed the
		 * plain aged-cache hit `readListing()` served, so nothing in this seam can
		 * answer a second call with a first call's cached success (mantahostels#1946). One test in
		 * pick-next-claims.test.ts opts back in: "reflects a live failure on the
		 * second read rather than the first read's cached success".
		 */
		WFC_ORACLE_CACHE: opts.oracleCache ? "1" : "0",
		...opts.env,
	};
	if (kit.noProjectDir) delete env.CLAUDE_PROJECT_DIR;
	const r = await runInProcessAsync(SCRIPT, [...repoArgs, ...args], {
		env,
		...(kit.runCwd ? { cwd: kit.runCwd } : {}),
	});
	const out = `${r.stdout}${r.stderr}`;
	return {
		status: r.status,
		out,
		json: () => JSON.parse(r.stdout || "{}"),
		/** The frontier's issue numbers, in printed order. */
		order: () =>
			(out.split("\nEXCLUDED", 1)[0]?.match(/^#(\d+) /gm) ?? []).map((s) =>
				Number(s.slice(1)),
			),
		calls: () =>
			fs.existsSync(CALL_LOG())
				? fs.readFileSync(CALL_LOG(), "utf8").trim().split("\n")
				: [],
	};
};

export const daysAgo = (n: number) =>
	new Date(Date.now() - n * 86_400_000).toISOString();

/** Registers the stub server, the git template and each case's sandbox. */
export function installPickNextHarness() {
	beforeAll(async () => {
		ghServer = await serveGhStub(GH_HANDLER);
	});
	afterAll(() => ghServer.close());
	beforeAll(() => {
		repoTemplate = fs.mkdtempSync(
			path.join(os.tmpdir(), "pick-next-template-"),
		);
		spawnSync("git", ["init", "-q"], { cwd: repoTemplate });
	});
	afterAll(() => fs.rmSync(repoTemplate, { recursive: true, force: true }));
	beforeEach(() => {
		Object.assign(kit, kitDefaults());
		kit.dir = fs.mkdtempSync(path.join(os.tmpdir(), "pick-next-test-"));
		// Hermetic by default: an empty tree tracks no file, so no body resolves.
		stubRepo([]);
	});
	afterEach(() => {
		for (const d of lockedDirs.splice(0)) fs.chmodSync(d, 0o700);
		fs.rmSync(kit.dir, { recursive: true, force: true });
		for (const r of roots.splice(0))
			fs.rmSync(r, { recursive: true, force: true });
		kit.repoRoot = null;
	});
}
