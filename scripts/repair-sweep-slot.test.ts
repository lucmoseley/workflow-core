// @vitest-environment node
/*
 * Pins the refill tick's repair of a dropped sweep slot (#4447): a slot with no
 * run past the grace is fired once, a slot GitHub delivers late inside the
 * grace is not doubled, and the dispatch carries the title the ledger reads as
 * that slot's run. Drives the real script against a stub `gh`.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stubGhScript } from "./lib/gh-stub";
import { runInProcess } from "./lib/run-in-process";
import { shellQuote } from "./lib/sh-quote.js";
import { slotKey, slotRunTitle } from "./lib/sweep-ledger.js";

const SCRIPT = path.join(__dirname, "repair-sweep-slot.js");

let dir: string;
let repo: string;
let calls: string;
let sweeps: string;
let gh: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "repair-sweep-slot-"));
	repo = path.join(dir, "repo");
	fs.mkdirSync(path.join(repo, ".github", "workflows"), { recursive: true });
	fs.writeFileSync(
		path.join(repo, ".github", "workflows", "scheduled-checks.yml"),
		"",
	);
	execFileSync("git", ["init", "-q"], { cwd: repo });
	calls = path.join(dir, "calls");
	sweeps = path.join(dir, "sweeps.json");
	fs.writeFileSync(calls, "");
	fs.writeFileSync(sweeps, "[]");
	gh = stubGhScript(
		dir,
		"#!/bin/sh\n" +
			`echo "$@" >> ${shellQuote(calls)}\n` +
			`[ "$1 $2" = "run list" ] && exec cat ${shellQuote(sweeps)}\n` +
			"exit 0\n",
	).gh;
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const repair = (iso: string, ghBin = gh) =>
	runInProcess(SCRIPT, [], {
		cwd: repo,
		env: {
			...process.env,
			CLAUDE_PROJECT_DIR: repo,
			WFC_GH: ghBin,
			WFC_NOW: iso,
		},
	});

const callLines = () =>
	fs.readFileSync(calls, "utf8").split("\n").filter(Boolean);
const dispatches = () =>
	callLines().filter((l) => l.startsWith("workflow run"));
const setSweeps = (rows: object[]) =>
	fs.writeFileSync(sweeps, JSON.stringify(rows));
const scheduled = (iso: string) => ({ createdAt: iso, event: "schedule" });

describe("a slot with no run past the grace is fired once (#4447)", () => {
	it("fires the 15:00 slot at 20:30, titled for it, and only once", () => {
		setSweeps([scheduled("2026-08-21T09:04:00Z")]);

		const first = repair("2026-08-21T20:30:00Z");
		expect(first.status).toBe(0);
		expect(first.stdout).toContain(
			"slot 2026-08-21T15:00Z missed, sweep fired",
		);
		expect(dispatches()).toHaveLength(1);
		expect(dispatches()[0]).toMatch(
			/^workflow run scheduled-checks\.yml -f slot=2026-08-21T15:00Z\b/,
		);

		const before = callLines().length;
		const second = repair("2026-08-21T20:35:00Z");
		expect(second.status).toBe(0);
		expect(second.stdout).toBe("");
		expect(callLines()).toHaveLength(before);
	});

	it("does not fire again where a repair from elsewhere already delivered it", () => {
		setSweeps([
			{
				createdAt: "2026-08-21T20:05:00Z",
				event: "workflow_dispatch",
				displayTitle: "sweep slot 2026-08-21T15:00Z",
			},
		]);

		expect(repair("2026-08-21T20:30:00Z").stdout).toBe("");
		expect(dispatches()).toHaveLength(0);
	});

	it("spends the day's sweep budget, and leaves the slot missed once it is out", () => {
		const common = path.join(repo, ".git");
		fs.writeFileSync(
			path.join(common, ".sweep-autofire"),
			JSON.stringify({ last: 0, day: "2026-08-21", count: 3 }),
		);

		const out = repair("2026-08-21T20:30:00Z");
		expect(out.status).toBe(0);
		expect(out.stdout).toContain("not repaired: 3 sweeps already fired");
		expect(dispatches()).toHaveLength(0);
		expect(repair("2026-08-21T20:35:00Z").stdout).toBe("");
	});

	it("counts its fire against that budget", () => {
		repair("2026-08-21T20:30:00Z");

		expect(
			JSON.parse(
				fs.readFileSync(path.join(repo, ".git", ".sweep-autofire"), "utf8"),
			).count,
		).toBe(1);
	});

	it("fires nothing where the runs will not read, and judges the slot again next tick", () => {
		const failing = stubGhScript(
			path.join(dir, "failing"),
			"#!/bin/sh\necho boom >&2\nexit 1\n",
		).gh;

		const out = repair("2026-08-21T20:30:00Z", failing);
		expect(out.status).toBe(1);
		expect(out.stderr).toContain("slot 2026-08-21T15:00Z not judged");

		expect(repair("2026-08-21T20:35:00Z").stdout).toContain("sweep fired");
	});
});

describe("a slot GitHub delivers late inside the grace is not doubled (#4447)", () => {
	it("leaves the 15:00 slot alone at 19:30, inside its grace, with no run yet", () => {
		setSweeps([scheduled("2026-08-21T09:00:00Z")]);

		expect(repair("2026-08-21T19:30:00Z").stdout).toBe("");
		expect(dispatches()).toHaveLength(0);
	});

	it("reads a run that started late in the slot as its delivery", () => {
		setSweeps([scheduled("2026-08-21T17:40:00Z")]);

		expect(repair("2026-08-21T20:30:00Z").stdout).toBe("");
		expect(dispatches()).toHaveLength(0);
	});
});

describe("an adopter with no sweep workflow (#4447)", () => {
	it("does nothing and asks GitHub nothing", () => {
		fs.rmSync(path.join(repo, ".github"), { recursive: true });

		expect(repair("2026-08-21T20:30:00Z").status).toBe(0);
		expect(callLines()).toHaveLength(0);
	});
});

describe("the workflow titles a repair as the ledger reads it (#4447)", () => {
	it("turns the `slot` input into slotRunTitle's title", () => {
		const workflow = fs.readFileSync(
			path.join(
				__dirname,
				"..",
				".github",
				"workflows",
				"scheduled-checks.yml",
			),
			"utf8",
		);
		const runName = /^run-name: .*format\('([^']*)', inputs\.slot\)/m.exec(
			workflow,
		);
		expect(runName, "no slot run-name in scheduled-checks.yml").not.toBeNull();
		expect(workflow).toMatch(/workflow_dispatch:\n {4}inputs:\n {6}slot:/);

		const at = Date.UTC(2026, 7, 21, 15);
		expect((runName as RegExpExecArray)[1].replace("{0}", slotKey(at))).toBe(
			slotRunTitle(at),
		);
	});
});
