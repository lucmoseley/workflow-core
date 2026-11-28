// @vitest-environment node
// #5872
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkScratchDir } from "./lib/git-fixture";
import { fakeIssueBody } from "./lib/issue-body-testkit";
import { runInProcessAsync } from "./lib/run-in-process";

const SCRIPT = path.join(__dirname, "stale-ticket-run.js");
const DAY_MS = 86_400_000;
const NOW = "2026-11-28T06:00:00.000Z";
const ago = (days: number) =>
	new Date(Date.parse(NOW) - days * DAY_MS).toISOString();
const GATED =
	"**Gated on:** #8 closes — check: `true` — abandon if: never\n**Gate basis:** basis\n";

let dir: string;
const at = (...p: string[]) => path.join(dir, ...p);

const checkout = (name: string, tracker: string) => {
	const root = at("home", name);
	fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
	execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
	fs.writeFileSync(
		path.join(root, ".claude", "workflow-core.json"),
		JSON.stringify({ tracker }),
	);
	return root;
};

const raw = (
	number: number,
	title: string,
	body: string,
	labels: string[],
) => ({
	number,
	title,
	state: "open",
	labels: labels.map((name) => ({ name })),
	body,
	created_at: ago(30),
	updated_at: ago(1),
	assignees: [],
});
const ISSUES = [
	raw(2, "A gated ticket", GATED, ["takes:implement"]),
	raw(
		4,
		"A ticket on a broken gate",
		"**Gated on:** the sky turns green — check: `true` — abandon if: never\n**Gate basis:** basis\n",
		["takes:implement"],
	),
	raw(6, "A ticket with no takes label", "", []),
];

interface Route {
	is?: string;
	when?: string;
	cwd?: string;
	out?: string;
	fail?: boolean;
}

const ENVELOPES: Record<string, unknown> = {
	"pick-next.js": {
		frontier: [],
		pulledIn: [],
		pulledInUnread: [],
		conflictGraph: { candidates: [], inFlight: [] },
	},
	"check-gates.js": {
		rows: [{ number: 4, state: "NO-OUTPUT", reading: "", closed: false }],
	},
	"check-issue-labels.js": {
		findings: [
			{
				severity: "FAIL",
				tag: "NO-TAKES",
				message: "no takes: label",
				number: 6,
			},
		],
	},
	"check-open-maps.js": { findings: [] },
	"check-issue-orphans.js": { findings: [] },
	"retire-stale-containers.js": { stale: [] },
	"check-stale-claims.js": { stale: [] },
};

function seedChildren(over: Record<string, unknown>) {
	const children = at("children");
	fs.mkdirSync(children);
	for (const [name, envelope] of Object.entries({ ...ENVELOPES, ...over }))
		fs.writeFileSync(
			path.join(children, name),
			`process.stdout.write(${JSON.stringify(JSON.stringify(envelope))});\n`,
		);
	return children;
}

function writeStub(extra: Route[]) {
	const list = JSON.stringify([ISSUES]);
	const routes = [
		{
			is: "api repos/{owner}/{repo}",
			out: JSON.stringify({ full_name: "o/a" }),
		},
		{ when: "repos/{owner}/{repo}/issues", cwd: "/a", out: list },
		{ when: "api repos/o/a/issues?state=open", out: list },
		{ when: "api repos/o/a/issues/8 --jq .state", out: "closed" },
		{ when: "issue view 2 --repo o/a --json body --jq", out: GATED },
		{
			when: "issue view 2 --repo o/a --json body",
			out: JSON.stringify({ body: GATED }),
		},
		{ when: "issue create", out: "https://github.com/o/core/issues/77" },
		{ when: "--slurp", out: "[]" },
	];
	fs.writeFileSync(at("routes.json"), JSON.stringify([...extra, ...routes]));
	const stub = at("gh");
	fs.writeFileSync(
		stub,
		`#!/usr/bin/env node
const fs = require("node:fs");
const argv = process.argv.slice(2).join(" ");
fs.appendFileSync(${JSON.stringify(at("gh.log"))}, argv + "\\n");
const hit = JSON.parse(fs.readFileSync(${JSON.stringify(at("routes.json"))}, "utf8")).find(
	(r) => (r.is ? argv === r.is : argv.includes(r.when)) && (!r.cwd || process.cwd().endsWith(r.cwd)),
);
if (hit && hit.fail) {
	process.stderr.write("gh refused\\n");
	process.exit(1);
}
process.stdout.write(hit ? hit.out + "\\n" : argv.includes("--json") ? "[]\\n" : "");
`,
	);
	fs.chmodSync(stub, 0o755);
	return stub;
}

async function run(
	args: string[],
	{
		real = false,
		routes = [],
		envelopes = {},
		history = at("refill", ".gate-history.jsonl"),
	}: {
		real?: boolean;
		routes?: Route[];
		envelopes?: Record<string, unknown>;
		history?: string;
	} = {},
) {
	const issueBody = fakeIssueBody(dir, GATED);
	const core = at("home", "core");
	const r = await runInProcessAsync(SCRIPT, args, {
		cwd: core,
		env: {
			...process.env,
			...(real ? {} : { WFC_STALE_RUN_CHILDREN: seedChildren(envelopes) }),
			WFC_GATE_HISTORY: history,
			WFC_NOW: NOW,
			HOME: at("home"),
			CLAUDE_PROJECT_DIR: core,
			WFC_REPO_ROOT: core,
			WFC_REFILL_DIR: at("refill"),
			WFC_GH: writeStub(routes),
			WFC_ISSUE_BODY: issueBody.script,
		},
	});
	const log = fs.existsSync(at("gh.log"))
		? fs.readFileSync(at("gh.log"), "utf8")
		: "";
	return { ...r, log, issueBody };
}

const record = () => at("refill", ".stale-run-record.jsonl");

beforeEach(() => {
	dir = mkScratchDir("stale-ticket-run-");
	checkout("core", "o/core");
	checkout("a", "o/a");
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("stale-ticket-run", () => {
	it("prints a repo line per tracker and writes nothing on a dry run, its children run for real", async () => {
		const r = await run(["--dry-run"], { real: true });
		expect(r.stderr).toBe("");
		expect(r.status).toBe(0);
		expect(r.stdout).toMatch(/^o\/a: \d+ takeable, oldest \d+ d, /m);
		expect(r.stdout).toMatch(/^o\/core: /m);
		expect(r.stdout).toContain("would: cleared: o/a#2 gated on o/a#8");
		expect(r.stdout).toMatch(/^C1 {2}o\/a#4 gate NO-OUTPUT/m);
		expect(r.stdout).not.toMatch(/o\/a#2 gate /);
		expect(r.stdout).toMatch(/^C5 {2}o\/a#6 NO-TAKES/m);
		expect(r.stdout).toContain("hub: refresh");
		expect(r.log).not.toMatch(/issue (comment|create|close|edit)/);
		expect(r.issueBody.calls()).toEqual([]);
		expect(fs.existsSync(record())).toBe(false);
	});

	it("strips a gate on a closed blocker, files the hub and appends one record row", async () => {
		const r = await run([]);
		expect(r.status).toBe(0);
		expect(r.issueBody.calls().join("\n")).toContain("replace 2");
		expect(r.log).toMatch(
			/issue comment 2 --repo o\/a --body Cleared by the daily stale-ticket run/,
		);
		expect(r.log).toContain("issue create");
		expect(r.log).toContain("Stale tickets: daily report");
		expect(r.log).toContain("--label origin:stale-run --label takes:triage");
		expect(r.log).toMatch(
			/label create origin:stale-run --repo o\/core --color EDEDED .* --force/,
		);
		const rows = fs.readFileSync(record(), "utf8").trim().split("\n");
		expect(rows).toHaveLength(1);
		const row = JSON.parse(rows[0]);
		expect(row.acts).toEqual([
			"cleared: o/a#2 gated on o/a#8, which has closed",
		]);
		expect(row.repoLines).toHaveLength(2);
		expect(row.listed.map((l: { key: string }) => l.key)).toEqual([
			"o/a#4:C1",
			"o/a#6:C5",
		]);
		expect(row.hub.number).toBe(77);
	});

	it("warns of a failed act, records only the acts that landed, and still files the hub", async () => {
		const r = await run([], {
			routes: [{ when: "issue view 2 --repo o/a --json body", fail: true }],
		});
		expect(r.status).toBe(0);
		expect(r.stderr).toContain(
			"cleared: o/a#2 gated on o/a#8, which has closed — failed:",
		);
		const row = JSON.parse(fs.readFileSync(record(), "utf8").trim());
		expect(row.acts).toEqual([]);
		expect(row.hub.number).toBe(77);
	});

	describe("a count gate's reading history", () => {
		const Counted = {
			"check-gates.js": {
				rows: [
					{
						number: 4,
						state: "READING",
						reading: "3 of 50",
						command: "true",
						closed: false,
					},
				],
			},
		};

		it("lists a count gate unmoved in the history as data not accruing", async () => {
			const history = at("refill", ".gate-history.jsonl");
			fs.mkdirSync(path.dirname(history), { recursive: true });
			const since = Date.parse(ago(9));
			fs.writeFileSync(
				history,
				`${JSON.stringify({ repo: "o/a", issue: 4, command: "true", at: since, counts: [{ a: 3, b: 50, since }] })}\n`,
			);
			const r = await run(["--dry-run"], { envelopes: Counted, history });
			expect(r.status).toBe(0);
			expect(r.stdout).toMatch(
				/^C1 {2}o\/a#4 gate READING: 3 of 50; unmoved 9 d/m,
			);
			expect(r.stdout).toMatch(
				/^C7 {2}o\/a#4 data not accruing \(3 of 50, 9 d\)/m,
			);
		});

		it("warns when the history cannot be read, and still completes", async () => {
			const history = at("refill", "unreadable");
			fs.mkdirSync(history, { recursive: true });
			const r = await run(["--dry-run"], { envelopes: Counted, history });
			expect(r.status).toBe(0);
			expect(r.stderr).toContain("o/a#4: gate history unread");
			expect(r.stdout).toMatch(/^o\/a: /m);
		});
	});

	it("exits 1 when the host checkout resolves no tracker", async () => {
		fs.writeFileSync(at("home", "core", ".claude", "workflow-core.json"), "{}");
		const r = await run(["--dry-run"]);
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("stale-ticket run: no tracker resolves for");
	});

	it("refuses an unknown argument", async () => {
		const r = await run(["--bogus"]);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("usage: node");
	});
});
