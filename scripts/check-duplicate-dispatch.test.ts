// @vitest-environment node
/*
 * The duplicate-dispatch gate (mantahostels#1337) — the check that stops a `/pick-next`
 * batch launching an issue that is already running.
 *
 * Every gate case runs the program as scripts/dispatch-sessions.sh does, through
 * run-in-process, against a stub `claude` at WFC_CLAUDE_BIN, so the oracle is
 * read through `lib/agent-liveness.js` throughout — its sessionId filter, its
 * empty-list refusal and the `requireSelf` waiver included (mantahostels#1400).
 * The launch-prompt parsing cases call lib/dispatch-ledger.js, the program's
 * own module, directly.
 *
 * scripts/dispatch-sessions.sh runs it before every `/pick-next` launch, so
 * loosening a case lets a resumed set relaunch issues already running —
 * duplicate sessions contending on files the live ones are mid-write on.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	writeAdopterCheckout as writeCheckout,
	writeIssueClaim,
	writeTornClaim,
} from "./lib/claim-store-testkit";
import ledger from "./lib/dispatch-ledger";
import { stubGhScript } from "./lib/gh-stub";
import { runInProcess } from "./lib/run-in-process.js";

const SCRIPT = path.join(__dirname, "check-duplicate-dispatch.js");

let root: string;

function writeLedger(lines: object[]) {
	fs.mkdirSync(path.dirname(ledger.ledgerPath(root)), { recursive: true });
	fs.writeFileSync(
		ledger.ledgerPath(root),
		`${lines.map((l) => JSON.stringify(l)).join("\n")}\n`,
	);
}

/**
 * A stub `claude`, injected at WFC_CLAUDE_BIN, reporting these sessions.
 * Each record carries a `sessionId`: the lib drops one without it (mantahostels#1400).
 */
function stubOracle(names: string[]) {
	stubOracleRaw(names.map((name, i) => ({ sessionId: `s${i}`, name })));
}

/** The same stub, with the records given verbatim — for a malformed shape. */
function stubOracleRaw(records: unknown) {
	const quoted = JSON.stringify(records).replaceAll("'", "'\\''");
	fs.writeFileSync(
		path.join(root, "claude"),
		`#!/bin/sh\nprintf '%s' '${quoted}'\n`,
		{ mode: 0o755 },
	);
}

/** A stub `claude` that will not run, so the live limb goes blind. */
function stubOracleDown() {
	fs.writeFileSync(path.join(root, "claude"), "#!/bin/sh\nexit 1\n", {
		mode: 0o755,
	});
}

/*
 * One session, naming no issue — what an otherwise idle machine reports, and
 * what isolates the ledger limb. NOT an empty list: a running daemon lists at
 * least the session the read ran in, so the lib refuses `[]` rather than
 * reading it as "nothing is running" (mantahostels#1400).
 */
const idle = ["Idle harness: nothing running"];

/**
 * A stub `gh` answering `issues/<n>/parent` from `parents`: a parent map's
 * URL, `{url, labels}` for a parent of another kind, or "fail" for an HTTP
 * error. An issue it omits has no parent, answered as GitHub does, a 404.
 */
function stubParents(
	parents: Record<number, string | { url: string; labels: string[] }> = {},
) {
	fs.writeFileSync(path.join(root, "parents.json"), JSON.stringify(parents));
	return stubGhScript(
		root,
		`#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(path.join(root, "gh-calls"))}, process.argv.slice(2).join(" ") + "\\n");
const parents = JSON.parse(fs.readFileSync(${JSON.stringify(path.join(root, "parents.json"))}, "utf8"));
const n = Number((process.argv[3] || "").match(/issues\\/(\\d+)\\/parent$/)?.[1]);
const p = parents[n];
if (p === "fail") { process.stderr.write("gh: Server Error (HTTP 502)\\n"); process.exit(1); }
if (!p) { process.stderr.write("gh: No parent issue found (HTTP 404)\\n"); process.exit(1); }
const { url, labels } = typeof p === "string" ? { url: p, labels: ["wayfinder:map"] } : p;
process.stdout.write(JSON.stringify({ url, labels: labels.map((name) => ({ name })) }));
`,
	).gh;
}

/** The `issues/<n>/parent` calls the gate made. */
const readParentCalls = () =>
	fs.existsSync(path.join(root, "gh-calls"))
		? fs.readFileSync(path.join(root, "gh-calls"), "utf8").trim().split("\n")
		: [];

/** The throwaway config dir every run's claim store lives under. */
const configDir = () => path.join(root, "config");

/** An arbiter claim by `sessionId` on `issue`, in `checkout`'s store. */
const writeClaim = (checkout: string, issue: number, sessionId: string) =>
	writeIssueClaim(configDir(), checkout, issue, sessionId);

function runCli(args: string[], env: Record<string, string> = {}) {
	return runInProcess(SCRIPT, args, {
		env: {
			...process.env,
			WFC_CLAUDE_BIN: path.join(root, "claude"),
			WFC_DISPATCH_ROOT: root,
			CLAUDE_PROJECT_DIR: root,
			CLAUDE_CONFIG_DIR: configDir(),
			WFC_GH: fs.existsSync(path.join(root, "bin", "gh"))
				? path.join(root, "bin", "gh")
				: stubParents(),
			...env,
		},
	});
}

/**
 * The gate's verdict on a set, as its report says it: each refused issue with
 * the limb that caught it, and each warning line.
 */
function verdict(issues: string, extra: string[] = []) {
	const r = runCli(["--issues", issues, ...extra]);
	const out = `${r.stdout}${r.stderr}`;
	const hits = [...out.matchAll(/^ {2}#(\d+) — (.*)$/gm)].map((m) => ({
		issue: Number(m[1]),
		via: m[2]?.startsWith("already running as") ? "live" : "ledger",
		detail: m[2] ?? "",
	}));
	const warnings = out.split("\n").filter((l) => l.startsWith("WARNING:"));
	return { status: r.status, out, hits, warnings };
}

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "dup-dispatch-"));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("reading issue numbers out of a launch prompt", () => {
	it("takes every integer, so a merged bundle is covered", () => {
		expect(ledger.issuesIn("/implement 341 353 366")).toEqual([341, 353, 366]);
	});

	it("finds none in a prompt carrying none", () => {
		expect(ledger.issuesIn("/pick-next")).toEqual([]);
	});

	it("reads the map in `/wayfinder <map> <ticket>` as context, and claims a bare map (#3217)", () => {
		expect(ledger.issuesIn("/wayfinder 3209 3212")).toEqual([3212]);
		expect(ledger.issuesIn("/wayfinder 3209")).toEqual([3209]);
	});
});

describe("two tickets on one map launch in parallel (#3217)", () => {
	it("passes `/wayfinder <map> <ticket>` while another ticket on the map runs", () => {
		stubOracle(["Wayfinder 3209, 3210: charting"]);
		const r = verdict("/wayfinder 3209 3212");
		expect(r.status).toBe(0);
		expect(r.hits).toEqual([]);
	});

	it("passes it over a ledgered launch of another ticket on the map", () => {
		stubOracle(idle);
		runCli([
			"--record",
			"--issues",
			"/wayfinder 3209 3210",
			"--prompt",
			"/wayfinder 3209 3210",
		]);
		expect(verdict("/wayfinder 3209 3212").status).toBe(0);
		const repeat = verdict("/wayfinder 3209 3210");
		expect(repeat.status).toBe(1);
		expect(repeat.hits.map(({ issue, via }) => ({ issue, via }))).toEqual([
			{ issue: 3210, via: "ledger" },
		]);
		expect(repeat.out).toContain("--force");
	});

	it("still refuses the map-only form on a running map", () => {
		stubOracle(["Wayfinder 3209, 3210: charting"]);
		const r = verdict("/wayfinder 3209");
		expect(r.status).toBe(1);
		expect(r.hits.map(({ issue, via }) => ({ issue, via }))).toEqual([
			{ issue: 3209, via: "live" },
		]);
		expect(r.out).toContain("--force");
	});

	it("reads each member's map on its own line, not only the first", () => {
		stubOracle(["Wayfinder 3209, 3210: charting"]);
		const out = path.join(root, "drop");
		runCli([
			"--issues",
			"/implement 1\n/wayfinder 3209 3212",
			"--drop-index-out",
			out,
		]);
		expect(fs.readFileSync(out, "utf8")).toBe("");
	});
});

describe("the ledger limb — catches a set whose sessions have finished", () => {
	beforeEach(() => stubOracle(idle));

	it("refuses an issue launched inside the window, citing the ledgered prompt", () => {
		writeLedger([
			{ ts: new Date().toISOString(), issues: [833], prompt: "/implement 833" },
		]);
		const r = verdict("833");
		expect(r.status).toBe(1);
		expect(r.hits).toHaveLength(1);
		expect(r.hits[0]?.via).toBe("ledger");
		expect(r.hits[0]?.detail).toContain("/implement 833");
	});

	it("permits the same issue once the window has passed", () => {
		const old = new Date(Date.now() - 7 * 3600 * 1000).toISOString();
		writeLedger([{ ts: old, issues: [833], prompt: "/implement 833" }]);
		const r = verdict("833", ["--window-hours", "6"]);
		expect(r.status).toBe(0);
		expect(r.hits).toEqual([]);
	});

	it("catches an issue that has since CLOSED — what a live check cannot", () => {
		writeLedger([
			{ ts: new Date().toISOString(), issues: [565], prompt: "/wayfinder 565" },
		]);
		expect(verdict("565").hits).toHaveLength(1);
	});

	it("permits an issue whose launch the refill loop released, and holds the rest (#2744)", () => {
		const ts = new Date().toISOString();
		writeLedger([
			{ ts, issues: [833], prompt: "/implement 833", jobId: "job1" },
			{ ts, issues: [834], prompt: "/implement 834", jobId: "job2" },
			{ ts, released: "job1" },
		]);
		expect(verdict("833,834").hits.map((h) => h.issue)).toEqual([834]);
	});

	it("treats a ledger that has never been written as clear, not as broken", () => {
		const r = verdict("833");
		expect(r.status).toBe(0);
		expect(r.hits).toEqual([]);
		expect(r.warnings).toEqual([]);
	});

	it("skips a torn line rather than disarming every later entry", () => {
		fs.mkdirSync(path.dirname(ledger.ledgerPath(root)), { recursive: true });
		fs.writeFileSync(
			ledger.ledgerPath(root),
			"{not json\n" +
				JSON.stringify({
					ts: new Date().toISOString(),
					issues: [833],
					prompt: "/implement 833",
				}) +
				"\n",
		);
		expect(verdict("833").hits).toHaveLength(1);
	});
});

describe("the live limb — catches a launch made outside this script", () => {
	it("refuses an issue named by a running session", () => {
		stubOracle(["Wayfinder 963: privacy-ops — EPI's duties"]);
		const r = verdict("963");
		expect(r.status).toBe(1);
		expect(r.hits.map((h) => h.via)).toEqual(["live"]);
	});

	it("reads only the name prefix, so an issue cited in a title is not a hit", () => {
		stubOracle(["Wayfinder 963: does §B need an archive once #959 has moved"]);
		const r = verdict("959");
		expect(r.status).toBe(0);
		expect(r.hits).toEqual([]);
	});

	/* #1989: a rescuer titled after the ticket it re-dispatches. */
	it("never counts the calling session, by session id or by job dir", () => {
		stubOracleRaw([
			{ sessionId: "me-1", id: "job00001", name: "Rescue-sessions 1878: x" },
		]);
		const bySession = runCli(["--issues", "1878"], {
			CLAUDE_CODE_SESSION_ID: "me-1",
			CLAUDE_JOB_DIR: "",
		});
		expect(bySession.status).toBe(0);
		const byJob = runCli(["--issues", "1878"], {
			CLAUDE_CODE_SESSION_ID: "someone-else",
			CLAUDE_JOB_DIR: "/home/u/.claude3/jobs/job00001",
		});
		expect(byJob.status).toBe(0);
		const other = runCli(["--issues", "1878"], {
			CLAUDE_CODE_SESSION_ID: "someone-else",
			CLAUDE_JOB_DIR: "/home/u/.claude3/jobs/job99999",
		});
		expect(other.status).toBe(1);
		const said = `${other.stdout}${other.stderr}`;
		expect(said).toContain("#1878 — already running as");
		expect(said).toContain("--force");
	});

	it("counts an issue once when both limbs name it", () => {
		stubOracle(["Wayfinder 963: x"]);
		writeLedger([
			{ ts: new Date().toISOString(), issues: [963], prompt: "/wayfinder 963" },
		]);
		expect(verdict("963").hits).toHaveLength(1);
	});
});

/* #2310 */
describe("the claim limb — refuses an issue a live session holds, directly or through its parent", () => {
	const hereUrl = "https://api.github.com/repos/o/here";
	beforeEach(() => {
		writeCheckout(root, "o/here");
		stubOracleRaw([
			{ sessionId: "holder", name: "Wayfinder 20: chart the map" },
			{ sessionId: "ended", name: "Old", kind: "background", state: "done" },
		]);
	});

	it("refuses an issue a live session claims, naming the holder", () => {
		writeClaim(root, 21, "holder");
		const r = verdict("21");
		expect(r.status).toBe(1);
		expect(r.out).toContain(
			"#21 — claimed by session `Wayfinder 20: chart the map`",
		);
		expect(readParentCalls()).toEqual([]);
	});

	it("refuses an issue whose parent map a live session claims, naming parent and holder", () => {
		writeClaim(root, 20, "holder");
		stubParents({ 21: `${hereUrl}/issues/20` });
		const r = verdict("21");
		expect(r.status).toBe(1);
		expect(r.out).toContain(
			"#21 — its parent map #20 is claimed by session `Wayfinder 20: chart the map`",
		);
		expect(readParentCalls()).toEqual([
			"api repos/{owner}/{repo}/issues/21/parent",
		]);
	});

	it("refuses nothing on a live claim on a parent that is no map", () => {
		writeClaim(root, 20, "holder");
		stubParents({ 21: { url: `${hereUrl}/issues/20`, labels: ["kind:spec"] } });
		const r = verdict("21");
		expect(r.status).toBe(0);
		expect(r.out).toContain("OK: no issue in this set is already dispatched");
	});

	it("refuses nothing on a claim whose holder has ended or is no longer listed", () => {
		writeClaim(root, 21, "ended");
		writeClaim(root, 20, "gone");
		stubParents({ 21: `${hereUrl}/issues/20` });
		const r = verdict("21");
		expect(r.status).toBe(0);
		expect(r.warnings).toEqual([]);
	});

	it("never refuses on the calling session's own claim", () => {
		writeClaim(root, 20, "holder");
		stubParents({ 21: `${hereUrl}/issues/20` });
		const r = runCli(["--issues", "21"], { CLAUDE_CODE_SESSION_ID: "holder" });
		expect(r.status).toBe(0);
		expect(`${r.stdout}${r.stderr}`).toContain(
			"OK: no issue in this set is already dispatched",
		);
	});

	it("asks for each member's parent once", () => {
		stubParents({ 21: `${hereUrl}/issues/20` });
		const r = runCli(["--issues", "/implement 21\n/implement 22"]);
		expect(`${r.stdout}${r.stderr}`).toContain(
			"OK: no issue in this set is already dispatched",
		);
		expect(readParentCalls()).toEqual([
			"api repos/{owner}/{repo}/issues/21/parent",
			"api repos/{owner}/{repo}/issues/22/parent",
		]);
	});

	it("reads a parent in another repo from that repo's own store", () => {
		const home = path.join(root, "home");
		const there = path.join(home, "there");
		writeCheckout(there, "o/there");
		writeClaim(there, 7, "holder");
		/* The same number in this repo's store is not that parent. */
		writeClaim(root, 7, "ended");
		stubParents({ 21: "https://api.github.com/repos/o/there/issues/7" });
		const r = runCli(["--issues", "21"], { HOME: home });
		expect(`${r.stdout}${r.stderr}`).toContain(
			"#21 — its parent map o/there#7 is claimed by session `Wayfinder 20: chart the map`",
		);
		expect(r.status).toBe(1);
	});

	it("passes with a WARN where no checkout holds the parent repo's store", () => {
		const home = path.join(root, "home");
		fs.mkdirSync(home, { recursive: true });
		stubParents({ 21: "https://api.github.com/repos/o/elsewhere/issues/7" });
		const r = runCli(["--issues", "21"], { HOME: home });
		const out = `${r.stdout}${r.stderr}`;
		expect(r.status).toBe(0);
		expect(out).toContain(
			`WARNING: no checkout under ${home} tracks o/elsewhere, so the claim on parent o/elsewhere#7 was not read`,
		);
	});

	it("passes with a WARN where the parent repo's store reads only in part", () => {
		const home = path.join(root, "home");
		const there = path.join(home, "there");
		writeCheckout(there, "o/there");
		writeClaim(there, 8, "holder");
		writeTornClaim(configDir(), there);
		stubParents({ 21: "https://api.github.com/repos/o/there/issues/7" });
		const r = runCli(["--issues", "21"], { HOME: home });
		expect(r.status).toBe(0);
		expect(`${r.stdout}${r.stderr}`).toContain(
			"WARNING: the claim on parent o/there#7 was not read: 1 issue-claim record could not be read and was dropped",
		);
	});

	it("passes with a WARN where the parent cannot be read", () => {
		stubParents({ 21: "fail" });
		const r = verdict("21");
		expect(r.status).toBe(0);
		expect(r.warnings.join(" ")).toContain(
			"the parent of #21 could not be read (gh: Server Error (HTTP 502))",
		);
	});
});

/* #752 */
describe("the ledger limb keys on issue and command; the live limb on issue alone", () => {
	const at = () => new Date().toISOString();

	it("reads the command off the leading /<skill>, and none off a bare list", () => {
		expect(ledger.commandOf("/triage 34")).toBe("triage");
		expect(ledger.commandOf("/implement 341 then 353")).toBe("implement");
		expect(ledger.commandOf("/workflow-core:triage 34")).toBe("triage");
		expect(ledger.commandOf("341,353")).toBeNull();
		expect(ledger.commandOf(undefined)).toBeNull();
	});

	it("launches the next stage on an issue whose triage launch is ledgered", () => {
		stubOracle(idle);
		writeLedger([{ ts: at(), issues: [34], prompt: "/triage 34" }]);
		const r = verdict("/wayfinder 34");
		expect(r.status).toBe(0);
		expect(r.hits).toEqual([]);
	});

	it("still drops a repeat of the same command on the same issue", () => {
		stubOracle(idle);
		writeLedger([{ ts: at(), issues: [34], prompt: "/triage 34" }]);
		expect(verdict("/triage 34").hits.map((h) => h.via)).toEqual(["ledger"]);
	});

	it("drops a bare repeat of a namespaced launch of the same skill", () => {
		stubOracle(idle);
		writeLedger([
			{ ts: at(), issues: [34], prompt: "/workflow-core:triage 34" },
		]);
		expect(verdict("/triage 34").hits).toHaveLength(1);
	});

	it("still drops on a live session, whatever the command", () => {
		stubOracle(["Triage 34: x"]);
		writeLedger([{ ts: at(), issues: [34], prompt: "/triage 34" }]);
		expect(verdict("/wayfinder 34").hits.map((h) => h.via)).toEqual(["live"]);
	});

	it("holds on an entry whose command cannot be read", () => {
		stubOracle(idle);
		writeLedger([
			{ ts: at(), issues: [34], prompt: "34" },
			{ ts: at(), issues: [35] },
		]);
		const r = verdict("/wayfinder 34\n/wayfinder 35");
		expect(r.hits.map((h) => h.issue)).toEqual([34, 35]);
	});

	it("holds a member whose own command cannot be read", () => {
		stubOracle(idle);
		writeLedger([{ ts: at(), issues: [34], prompt: "/triage 34" }]);
		expect(verdict("34").hits).toHaveLength(1);
	});

	it("imports entryHolds from the seam in picker and launcher, and defines no copy", () => {
		for (const src of [
			fs.readFileSync(SCRIPT, "utf8"),
			fs.readFileSync(path.join(__dirname, "pick-next.js"), "utf8"),
		]) {
			expect(src).toMatch(
				/\bentryHolds\b[\s\S]*?\}\s*=\s*require\("\.\/lib\/dispatch-ledger"\)/,
			);
			expect(src).not.toMatch(/function (commandOf|entryHolds)\b/);
		}
	});
});

describe("it fails open, and says which half went blind", () => {
	it("permits the launch when the oracle is down, with a warning", () => {
		stubOracleDown();
		const r = verdict("833");
		expect(r.status).toBe(0);
		expect(r.hits).toEqual([]);
		expect(r.warnings.join(" ")).toContain("agents --json");
	});

	it("names the binary it tried, so a wrong WFC_CLAUDE_BIN is visible (mantahostels#1374)", () => {
		const r = runCli(["--issues", "833"], {
			WFC_CLAUDE_BIN: path.join(root, "no-such-claude"),
		});
		expect(`${r.stdout}${r.stderr}`).toContain("no-such-claude agents --json");
	});

	it("still applies the ledger while the oracle is down", () => {
		stubOracleDown();
		writeLedger([
			{ ts: new Date().toISOString(), issues: [833], prompt: "/implement 833" },
		]);
		const r = verdict("833");
		expect(r.status).toBe(1);
		expect(r.hits).toHaveLength(1);
		expect(r.warnings).toHaveLength(1);
	});

	it("permits a clean set with no warnings at all", () => {
		stubOracle(idle);
		const r = verdict("999");
		expect(r.status).toBe(0);
		expect(r.hits).toEqual([]);
		expect(r.warnings).toEqual([]);
	});
});

describe("recording a launch", () => {
	const recordLaunch = (issue: number) =>
		runCli([
			"--record",
			"--issues",
			String(issue),
			"--model",
			"opus",
			"--prompt",
			`/implement ${issue}`,
		]);

	it("appends rather than overwriting", () => {
		stubOracle(idle);
		recordLaunch(341);
		recordLaunch(353);
		const r = verdict("341,353");
		expect(r.hits.map((h) => h.issue).sort()).toEqual([341, 353]);
	});
});

/* Black-box, per docs/code-standards-base.md §X3. */
describe("the CLI — §N4's outcome alphabet", () => {
	it("exits 0 and says so when nothing in the set is dispatched", () => {
		stubOracle(idle);
		const r = runCli(["--issues", "341,353"]);
		expect(r.status).toBe(0);
		expect(`${r.stdout}${r.stderr}`).toContain("OK:");
	});

	it("exits 1 naming the offending issue and the way out", () => {
		stubOracle(idle);
		writeLedger([
			{ ts: new Date().toISOString(), issues: [833], prompt: "/implement 833" },
		]);
		const r = runCli(["--issues", "833,341"]);
		expect(r.status).toBe(1);
		const out = `${r.stdout}${r.stderr}`;
		expect(out).toContain("#833");
		expect(out).toContain("/implement 833");
		expect(out).toContain("--force");
		expect(out).not.toContain("#341");
	});

	it("reads the oracle through WFC_CLAUDE_BIN, ignoring a `claude` on PATH (mantahostels#1374)", () => {
		stubOracle(["Implement 972: something"]);
		/* A PATH `claude` reporting nothing. A run still resolving the bare name
		 * would read this one and wave mantahostels#972 through. */
		const shadow = path.join(root, "shadow"); // under root, so afterEach takes it
		fs.mkdirSync(shadow);
		fs.writeFileSync(path.join(shadow, "claude"), "#!/bin/sh\nprintf '[]'\n", {
			mode: 0o755,
		});
		const r = runCli(["--issues", "972"], {
			// claude-route-exempt: asserts a bare `claude` on PATH goes unread
			PATH: `${shadow}:${process.env.PATH}`,
		});
		expect(r.status).toBe(1);
		expect(`${r.stdout}${r.stderr}`).toContain("Implement 972");
	});

	it("catches a live session the ledger never saw", () => {
		stubOracle(["Implement 972: something"]);
		const r = runCli(["--issues", "972"]);
		expect(r.status).toBe(1);
		expect(`${r.stdout}${r.stderr}`).toContain("Implement 972");
	});

	it("warns rather than reading an EMPTY list as an idle machine, saying a session launched elsewhere would not be caught (mantahostels#1400)", () => {
		stubOracleRaw([]);
		const r = runCli(["--issues", "341"]);
		const out = `${r.stdout}${r.stderr}`;
		expect(r.status).toBe(0);
		expect(out).toContain("listed no agents at all");
		expect(out).toContain("would not be caught");
	});

	it("warns when no record carries a sessionId — the shape has moved (mantahostels#1400)", () => {
		stubOracleRaw([{ name: "Implement 972: something" }]);
		const r = runCli(["--issues", "972"]);
		expect(r.status).toBe(0);
		expect(`${r.stdout}${r.stderr}`).toContain("sessionId");
	});

	it("still catches a duplicate named by a surviving record when a sibling is dropped (mantahostels#1400)", () => {
		stubOracleRaw([
			{ name: "Implement 111: no sessionId, so dropped" },
			{ sessionId: "s1", name: "Implement 972: something" },
		]);
		const r = runCli(["--issues", "972"]);
		expect(r.status).toBe(1);
		expect(`${r.stdout}${r.stderr}`).toContain("Implement 972");
	});

	it("misses one named ONLY by a dropped record, and says nothing — the mantahostels#1400 residual", () => {
		stubOracleRaw([
			{ name: "Implement 111: no sessionId, so dropped" },
			{ sessionId: "s1", name: "Idle harness: nothing running" },
		]);
		const r = runCli(["--issues", "111"]);
		expect(r.status).toBe(0);
		expect(`${r.stdout}${r.stderr}`).not.toContain("WARNING:");
	});

	it("exits 2 BROKEN with usage on a bad invocation, never 1 — nothing was checked", () => {
		stubOracle(idle);
		const r = runCli(["--bogus"]);
		expect(r.status).toBe(2);
		expect(`${r.stdout}${r.stderr}`).toMatch(/BROKEN:[\s\S]*usage:/);
	});

	it("exits 0 with a WARNING when the oracle is unreadable — it fails open", () => {
		stubOracleDown();
		const r = runCli(["--issues", "341"]);
		expect(r.status).toBe(0);
		expect(`${r.stdout}${r.stderr}`).toContain("WARNING:");
	});

	it("does not summarise a fail-open warning as a duplicate", () => {
		stubOracleDown();
		const out = runCli(["--issues", "341"]);
		expect(`${out.stdout}${out.stderr}`).toContain(
			"0 already-dispatched issue(s)",
		);
	});

	it("--record appends a launch and exits 0", () => {
		stubOracle(idle);
		const r = runCli([
			"--record",
			"--issues",
			"341",
			"--model",
			"opus",
			"--prompt",
			"/implement 341",
		]);
		expect(r.status).toBe(0);
		const written = fs.readFileSync(ledger.ledgerPath(root), "utf8").trim();
		expect(JSON.parse(written)).toMatchObject({
			issues: [341],
			model: "opus",
			prompt: "/implement 341",
		});
	});

	/* mantahostels#3488: the launched job's own id, distinct from `session` (the launcher's
	 * own id) — the field pick-next.js reads to say whether that launch is
	 * still alive. */
	it("--record with --job-id writes the launched job's own id", () => {
		stubOracle(idle);
		runCli([
			"--record",
			"--issues",
			"341",
			"--model",
			"opus",
			"--prompt",
			"/implement 341",
			"--job-id",
			"efbb4e5e",
		]);
		const written = fs.readFileSync(ledger.ledgerPath(root), "utf8").trim();
		expect(JSON.parse(written)).toMatchObject({ jobId: "efbb4e5e" });
	});

	it("--record with no --job-id writes jobId: null, not an absent field", () => {
		stubOracle(idle);
		runCli([
			"--record",
			"--issues",
			"341",
			"--model",
			"opus",
			"--prompt",
			"/implement 341",
		]);
		const written = fs.readFileSync(ledger.ledgerPath(root), "utf8").trim();
		expect(JSON.parse(written).jobId).toBeNull();
	});

	it("refuses the recorded set on the next run (mantahostels#1337)", () => {
		stubOracle(idle);
		runCli([
			"--record",
			"--issues",
			"341",
			"--model",
			"opus",
			"--prompt",
			"/implement 341",
		]);
		expect(runCli(["--issues", "341"]).status).toBe(1);
	});

	it("writes the offending member's index for the launcher to drop (mantahostels#1337)", () => {
		stubOracle(idle);
		writeLedger([
			{ ts: new Date().toISOString(), issues: [833], prompt: "/implement 833" },
		]);
		const out = path.join(root, "drop");
		const r = runCli([
			"--issues",
			"/implement 341\n/implement 833\n/wayfinder 1114",
			"--drop-index-out",
			out,
		]);
		expect(r.status).toBe(1);
		expect(fs.readFileSync(out, "utf8").trim()).toBe("1");
	});

	it("says DROPPING, not REFUSED, when the rest of the set still launches", () => {
		stubOracle(idle);
		writeLedger([
			{ ts: new Date().toISOString(), issues: [833], prompt: "/implement 833" },
		]);
		const r = runCli([
			"--issues",
			"/implement 341\n/implement 833",
			"--drop-index-out",
			path.join(root, "drop"),
		]);
		const out = `${r.stdout}${r.stderr}`;
		expect(out).toContain("DROPPING");
		expect(out).not.toContain("REFUSED");
	});

	it("still says REFUSED when every member is a duplicate (mantahostels#1337)", () => {
		stubOracle(idle);
		writeLedger([
			{ ts: new Date().toISOString(), issues: [833], prompt: "/implement 833" },
		]);
		const r = runCli([
			"--issues",
			"/implement 833",
			"--drop-index-out",
			path.join(root, "drop"),
		]);
		expect(`${r.stdout}${r.stderr}`).toContain("REFUSED");
	});

	it("launches /wayfinder over a ledgered /triage of the same issue, and refuses a repeat, naming the issue and offering --force (#752)", () => {
		stubOracle(idle);
		writeLedger([
			{ ts: new Date().toISOString(), issues: [34], prompt: "/triage 34" },
		]);
		const out = path.join(root, "drop");
		const next = runCli(["--issues", "/wayfinder 34", "--drop-index-out", out]);
		expect(next.status).toBe(0);
		expect(fs.readFileSync(out, "utf8")).toBe("");
		const repeat = runCli(["--issues", "/triage 34", "--drop-index-out", out]);
		expect(repeat.status).toBe(1);
		const said = `${repeat.stdout}${repeat.stderr}`;
		expect(said).toContain("REFUSED");
		expect(said).toContain("#34");
		expect(said).toContain("--force");
	});

	it("writes an empty drop file when nothing is a duplicate", () => {
		stubOracle(idle);
		const out = path.join(root, "drop");
		runCli(["--issues", "/implement 341", "--drop-index-out", out]);
		expect(fs.readFileSync(out, "utf8")).toBe("");
	});

	describe("naming which member to drop, not just which issue is a duplicate", () => {
		/** The indices the launcher is told to drop from `prompts`, one member a line. */
		function dropped(prompts: string[]) {
			const out = path.join(root, "drop");
			runCli(["--issues", prompts.join("\n"), "--drop-index-out", out]);
			return fs.readFileSync(out, "utf8").split("\n").filter(Boolean);
		}
		const at = () => new Date().toISOString();

		it("drops a whole member when any one of its issues is a duplicate", () => {
			/* One session covers both issues, so half of it cannot be launched. */
			stubOracle(idle);
			writeLedger([{ ts: at(), issues: [353], prompt: "/implement 353" }]);
			expect(dropped(["/implement 341 353", "/implement 366"])).toEqual(["0"]);
		});

		it("drops only the member running the ledgered command", () => {
			stubOracle(idle);
			writeLedger([{ ts: at(), issues: [34], prompt: "/triage 34" }]);
			expect(dropped(["/wayfinder 34", "/triage 34"])).toEqual(["1"]);
		});

		it("finds the matching entry behind a non-matching one on the same issue", () => {
			stubOracle(idle);
			writeLedger([
				{ ts: at(), issues: [34], prompt: "/triage 34" },
				{ ts: at(), issues: [34], prompt: "/wayfinder 34" },
			]);
			expect(dropped(["/triage 34", "/wayfinder 34"])).toEqual(["0", "1"]);
		});

		it("drops on a live session, whatever the command", () => {
			stubOracle(["Triage 34: x"]);
			writeLedger([{ ts: at(), issues: [34], prompt: "/triage 34" }]);
			expect(dropped(["/wayfinder 34"])).toEqual(["0"]);
		});
	});
});
