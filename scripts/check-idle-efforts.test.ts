// @vitest-environment node
/*
 * check-idle-efforts.test.ts — the idle alarm's program (#3641): that it
 * reads every adopting checkout's tracker once, each checkout's dispatch
 * ledger as the launch log, a held launch as running, and a stopped loop as
 * serving nothing, and reports through runCheck without gating.
 *
 * Its judgement is lib/idle-efforts.test.ts's; this pins the readings the
 * shell hands it. `gh` is a stub injected through WFC_GH and the home
 * directory a temp one, so no real tracker or checkout is read. A break here
 * strands an effort unreported while the core's own tests stay green.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stubGhScript } from "./lib/gh-stub";
import { runInProcessAsync } from "./lib/run-in-process.js";

const SCRIPT = path.resolve(__dirname, "check-idle-efforts.js");
const DAY = 24 * 60 * 60 * 1000;

let dir: string;
let home: string;

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

function checkout(name: string, tracker: string, ledger: object[] = []) {
	const root = path.join(home, name);
	fs.mkdirSync(path.join(root, ".git"), { recursive: true });
	fs.mkdirSync(path.join(root, ".claude", "tmp", "markers", ".pick-next"), {
		recursive: true,
	});
	fs.writeFileSync(
		path.join(root, ".claude", "workflow-core.json"),
		JSON.stringify({ contract: 1, tracker }),
	);
	fs.writeFileSync(
		path.join(
			root,
			".claude",
			"tmp",
			"markers",
			".pick-next",
			"dispatched.jsonl",
		),
		ledger.map((r) => `${JSON.stringify(r)}\n`).join(""),
	);
}

const launch = (n: number, at: number) => ({
	ts: ago(at),
	issues: [n],
	model: "opus",
	prompt: `/implement ${n}`,
	session: null,
	jobId: `job${n}`,
});

const node = (number: number, labels = ["takes:implement"]) => ({
	number,
	title: `issue ${number}`,
	createdAt: ago(10 * DAY),
	body: "",
	labels: { nodes: labels.map((name) => ({ name })) },
	blockedBy: { totalCount: 0, nodes: [] },
	subIssues: { nodes: [] },
});

/** A stub gh answering the issues query per repo, logging each call. */
function stubGh(issues: Record<string, ReturnType<typeof node>[]>) {
	const fixture = path.join(dir, "fixture.json");
	fs.writeFileSync(fixture, JSON.stringify(issues));
	return stubGhScript(
		dir,
		`#!/usr/bin/env node
const fs = require("node:fs");
const argv = process.argv.slice(2);
const field = (k) => (argv.find((a) => a.startsWith(k + "=")) || "").slice(k.length + 1);
const repo = field("owner") + "/" + field("name");
fs.appendFileSync(${JSON.stringify(path.join(dir, "calls.log"))}, repo + "\\n");
const fx = JSON.parse(fs.readFileSync(${JSON.stringify(fixture)}, "utf8"));
if (!(repo in fx)) { process.stderr.write("HTTP 404: Could not resolve to a Repository\\n"); process.exit(1); }
process.stdout.write(JSON.stringify([{ data: { repository: { issues: { pageInfo: { hasNextPage: false }, nodes: fx[repo] } } } }]));
`,
	);
}

async function run(
	issues: Record<string, ReturnType<typeof node>[]>,
	args: string[] = [],
) {
	const stub = stubGh(issues);
	const refill = path.join(dir, "refill");
	fs.mkdirSync(refill);
	const env: NodeJS.ProcessEnv = {
		...process.env,
		...stub.env,
		HOME: home,
		WFC_REFILL_DIR: refill,
		CLAUDE_PROJECT_DIR: dir,
		GITHUB_ACTIONS: "",
	};
	delete env.WFC_DISPATCH_ROOT;
	delete env.WFC_REPO_ROOT;
	const r = await runInProcessAsync(SCRIPT, args, { cwd: dir, env });
	return {
		status: r.status,
		out: `${r.stdout}${r.stderr}`,
		stdout: r.stdout,
		calls: fs
			.readFileSync(path.join(dir, "calls.log"), "utf8")
			.trim()
			.split("\n"),
	};
}

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "idle-efforts-test-"));
	home = path.join(dir, "home");
	fs.mkdirSync(home);
});
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

describe("check-idle-efforts.js", () => {
	it("reads a shared tracker once, its latest launch across checkouts, a held launch as running, and a stopped loop as serving nothing", async () => {
		checkout("core-a", "o/core", [launch(1, 5 * DAY)]);
		checkout("core-b", "o/core", [launch(1, DAY), launch(2, 30 * 60 * 1000)]);
		checkout("prod", "o/product");
		const r = await run({
			"o/core": [node(1), node(2), node(3)],
			"o/product": [node(8, ["takes:implement", "urgent"])],
		});
		expect(r.status).toBe(0);
		expect(r.calls.sort()).toEqual(["o/core", "o/product"]);
		expect(r.out).toContain(
			"The refill loop is not running, so it serves no tracker.",
		);
		expect(r.out).toContain(
			"o/core: 1 idle past 2 days (the refill loop does not serve it); oldest #3 (issue 3), idle 10.0 days; skip reason: none, the launch filter passes it",
		);
		expect(r.out).toContain("  urgent #8 (issue 8), idle 10.0 days");
		expect(r.out).toContain("WARN:");
	});

	it("emits the same findings under --json", async () => {
		checkout("prod", "o/product");
		const r = await run({ "o/product": [node(8)] }, ["--json"]);
		const json = JSON.parse(r.stdout);
		expect(json.outcome).toBe("WARN");
		expect(json.loopRunning).toBe(false);
		expect(json.trackers).toEqual([
			expect.objectContaining({
				repo: "o/product",
				served: false,
				idle: [expect.objectContaining({ number: 8, skip: null })],
			}),
		]);
	});

	it("names a tracker that will not read as unread, never as none idle, and does not gate", async () => {
		checkout("gone", "o/gone");
		const r = await run({});
		expect(r.status).toBe(0);
		expect(r.out).toContain(
			"o/gone: unread — HTTP 404: Could not resolve to a Repository",
		);
		expect(r.out).not.toContain("none idle");
	});

	it("is OK where nothing is idle", async () => {
		checkout("core", "o/core", [launch(1, DAY)]);
		const r = await run({ "o/core": [node(1)] });
		expect(r.status).toBe(0);
		expect(r.out).toContain("OK: no effort idle past 2 days.");
	});
});
