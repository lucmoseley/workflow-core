import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect } from "vitest";
import {
	GH_GRAPHQL_NO_REPO,
	GH_LOGGED_OUT,
	GH_NOT_FOUND,
	GH_PARENT_NOT_FOUND,
	LINKS_GRAPHQL_FAKE,
	RECORDED_SHAPES,
} from "./gh-fake";
import { type GhStubServer, serveGhStub, stubGhScript } from "./gh-stub";
import { buildLoadavgLine, writeCwd, writeSmapsRollup } from "./proc-fake";
import { projectSlug } from "./project-slug.js";
import { writePsStub } from "./ps-stub";
import { runInProcessAsync } from "./run-in-process";
import { shellQuote } from "./sh-quote.js";

const kitDefaults = () => ({
	dir: "",
	psOut: "",
	psFails: false,
	memAvailableKb: (4096 * 1024) as number | null,
	meminfoText: null as string | null,
	load1: 0.5,
	sessionCeiling: "0",
	repoRoot: null as string | null,
	oracleSessions: ["self"] as string[],
	oracleFails: false,
	oracleNames: {} as Record<string, string>,
	oracleFinished: [] as string[],
	procPssKb: {} as Record<string, number>,
	procCwds: {} as Record<string, string>,
	oracleSelfId: "self",
	claimsRepo: null as string | null,
	noProjectDir: false,
	runCwd: null as string | null,
});

export const kit = kitDefaults();

export const kitHome = () => path.join(kit.dir, "home");

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
	parentUrl?: string;
	repoUrl?: string;
	pull_request?: object;
	summaryBlockedBy?: number;
	openSubIssues?: number;
}

export interface Fixture {
	issues: Issue[];
	deps?: Record<
		number,
		{ number: number; state: "open" | "closed"; repo?: string }[]
	>;
	foreignDeps?: Record<
		string,
		{ number: number; state: "open" | "closed"; repo?: string }[]
	>;
	timeline?: Record<
		number,
		{ label: string; created_at: string; actor: string }[]
	>;
	failDeps?: number[];
	failTimeline?: number[];
	failDepsOnce?: number[];
	failGraphql?: boolean;
	failGraphqlOnce?: boolean;
	graphqlAnswers?: "empty" | "noRepo";
	failList?: boolean;
	openCount?: number;
	claims?: Record<number, string>;
	corruptClaim?: boolean;
	heldFiles?: Record<string, string>;
	staleFiles?: Record<
		string,
		{ path: string; sessionId: string; hoursAgo: number }
	>;
	parents?: Record<number, { url: string; labels: string[] }>;
	subIssues?: Record<
		number,
		Array<{ number: number; state: string; repo?: string }>
	>;
	failSubIssues?: number[];
	emptySubIssues?: number[];
	dispatched?: Array<{
		issues: number[];
		prompt?: string;
		hoursAgo?: number;
		jobId?: string;
		released?: boolean;
	}>;
	dispatchLedgerUnreadable?: boolean;
}

const FIXTURE_FILE = "fixture.json";
const CALL_LOG_FILE = "calls.log";
export const CALL_LOG = () => path.join(kit.dir, CALL_LOG_FILE);

export const restCalls = (calls: string[]) =>
	calls.filter((c) => !c.startsWith("api graphql "));

export const expectGraphqlReadsOnly = (calls: string[]) => {
	for (const call of calls.filter((c) => c.startsWith("api graphql "))) {
		expect(call).toMatch(/ -f query=query\(/);
		expect(call).not.toMatch(/mutation/);
	}
};

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
${LINKS_GRAPHQL_FAKE}
${RECORDED_SHAPES}
const fail = () => serveHandlerAnswer(${JSON.stringify(GH_NOT_FOUND)});
if (p === "graphql") {
  if (fx.failGraphql) return fail();
  if (fx.failGraphqlOnce && bump("graphql") === 1) return fail();
  if (fx.graphqlAnswers === "empty") return;
  if (fx.graphqlAnswers === "noRepo") return serveHandlerAnswer(${JSON.stringify(GH_GRAPHQL_NO_REPO)});
  const failing = [...(fx.failDeps || []), ...(fx.failDepsOnce || [])];
  return serveHandlerAnswer(answerLinks(argv, (_repo, n) =>
    failing.includes(n) ? null : { blockedBy: (fx.deps || {})[n] || [] }));
}
if (/dependencies\\/blocked_by/.test(p)) {
  const n = num(/issues\\/(\\d+)\\/dependencies/);
  if ((fx.failDeps || []).includes(n)) return fail();
  if ((fx.failDepsOnce || []).includes(n) && bump("deps" + n) === 1) return fail();
  return page("blockedByPage", edges((fx.deps || {})[n] || []));
}
if (/\\/parent$/.test(p)) {
  const parent = (fx.parents || {})[num(/issues\\/(\\d+)\\/parent/)];
  if (!parent) return serveHandlerAnswer(${JSON.stringify(GH_PARENT_NOT_FOUND)});
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
  if (fx.failList) return serveHandlerAnswer(${JSON.stringify(GH_LOGGED_OUT)});
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

const stubGh = (fx: Fixture) => {
	fs.writeFileSync(path.join(kit.dir, FIXTURE_FILE), JSON.stringify(fx));
	return stubGhScript(kit.dir, ghServer.script);
};
const buildPsLine = (comm: string, args: string) => `${comm} ${args}`;
export const sessionProcs = (id: string, exe = "claude") => [
	buildPsLine(
		"2.1.233",
		`${exe} bg-pty-host --bg-pty-host /tmp/${id}.pty.sock 200`,
	),
	buildPsLine("2.1.233", `${exe} bg-spare --bg-spare /tmp/${id}.claim.sock`),
];
export const roots: string[] = [];
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
export const stubBrokenRepo = () => {
	kit.repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pick-next-norepo-"));
	roots.push(kit.repoRoot);
};
// #2231
export const FIXTURE_DRAW = { sessionMeanMb: 429, sessionSigmaMb: 154 };
export const WORKING_PAIR_KB = 640 * 1024;
// #2223
export const IDLE_PAIR_MB = 106;
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
				};
			}),
		),
	);
	return { WFC_CLAUDE_BIN: bin, CLAUDE_CODE_SESSION_ID: kit.oracleSelfId };
};
const stubClaims = (fx: Fixture) => {
	const home = path.join(kitHome(), ".claude");
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

	return { CLAUDE_CONFIG_DIR: home, CLAUDE_PROJECT_DIR: repo };
};

export const writeJobState = (
	jobId: string,
	rec: { state: string; sessionId?: string },
) => {
	const home = path.join(kitHome(), ".claude");
	const jobDir = path.join(home, "jobs", jobId);
	fs.mkdirSync(jobDir, { recursive: true });
	fs.writeFileSync(path.join(jobDir, "state.json"), JSON.stringify(rec));
};

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
	const proc = path.join(kit.dir, "proc");
	fs.mkdirSync(proc, { recursive: true });
	for (const [pid, kb] of Object.entries(kit.procPssKb))
		writeSmapsRollup(proc, pid, kb);
	for (const [pid, cwd] of Object.entries(kit.procCwds))
		writeCwd(proc, pid, cwd);
	const loadavg = path.join(kit.dir, "loadavg");
	fs.writeFileSync(loadavg, buildLoadavgLine(kit.load1));
	return {
		WFC_PS: ps,
		WFC_MEMINFO: meminfo,
		WFC_PROC: proc,
		WFC_LOADAVG: loadavg,
		WFC_LOAD_CEILING: "48",
		WFC_SESSION_CEILING: kit.sessionCeiling,
		TMPDIR: kit.dir,
	};
};

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
	fs.mkdirSync(kitHome(), { recursive: true });
	const env: NodeJS.ProcessEnv = {
		...process.env,
		HOME: kitHome(),
		...stub.env,
		GH_STUB_DIR: kit.dir,
		...stubMachine(),
		...stubOracle(),
		...stubClaims(fx),
		...(kit.repoRoot ? { WFC_REPO_ROOT: kit.repoRoot } : {}),
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
		stubRepo([]);
	});
	afterEach(() => {
		fs.rmSync(kit.dir, { recursive: true, force: true });
		for (const r of roots.splice(0))
			fs.rmSync(r, { recursive: true, force: true });
		kit.repoRoot = null;
	});
}
