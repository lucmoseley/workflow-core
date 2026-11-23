// @vitest-environment node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { stubGhScript } from "./gh-stub";
import { defineTemplate } from "./git-fixture";

const { readFiringAlarms } = require("./queue-alarms.js");

const OLD = "b".repeat(40);

let tmp: string;
let work: string;
let main: string;
let log: string;
let runs: string;

const git = (cwd: string, args: string[]) =>
	execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const run = (hour: number, conclusion: string, headSha = main) => ({
	databaseId: hour,
	conclusion,
	createdAt: new Date(Date.UTC(2026, 10, 7, hour)).toISOString(),
	headSha,
});

const quietRuns = (rows: object[]) => {
	const workflows = path.join(work, ".github", "workflows");
	fs.mkdirSync(workflows, { recursive: true });
	fs.writeFileSync(path.join(workflows, "landing-quiet.yml"), "");
	fs.writeFileSync(runs, JSON.stringify({ "landing-quiet.yml": rows }));
};

const pushed = defineTemplate((dir) => {
	const remote = path.join(dir, "remote.git");
	const clone = path.join(dir, "work");
	git(dir, ["init", "-q", "--bare", "-b", "main", remote]);
	git(dir, ["clone", "-q", remote, clone]);
	git(clone, ["config", "user.email", "t@t"]);
	git(clone, ["config", "user.name", "t"]);
	git(clone, ["commit", "-q", "--allow-empty", "-m", "seed"]);
	git(clone, ["push", "-q", "origin", "HEAD:main"]);
});

beforeEach(() => {
	tmp = pushed.instantiate(
		fs.mkdtempSync(path.join(os.tmpdir(), "queue-alarms-")),
	);
	work = path.join(tmp, "work");
	log = path.join(tmp, "calls.log");
	runs = path.join(tmp, "runs.json");
	main = git(work, ["rev-parse", "HEAD"]);
	const { env } = stubGhScript(
		tmp,
		`#!/usr/bin/env node
const fs = require("node:fs");
const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, a.join(" ") + "\\n");
if (a[0] !== "run" || a[1] !== "list") process.exit(1);
const all = JSON.parse(fs.readFileSync(${JSON.stringify(runs)}, "utf8"));
process.stdout.write(JSON.stringify(all[a[a.indexOf("--workflow") + 1]] ?? []));
`,
	);
	vi.stubEnv("WFC_GH", env.WFC_GH);
});

afterEach(() => {
	vi.unstubAllEnvs();
	fs.rmSync(tmp, { recursive: true, force: true });
});

it("reads no run, nor main, where the checkout has no alarm workflow", () => {
	expect(readFiringAlarms(work)).toEqual({ main: null, alarms: [] });
	expect(fs.existsSync(log)).toBe(false);
});

it("fires on the failed scheduled runs on main at the remote's main, newest first, counting them", () => {
	quietRuns([run(9, "failure"), run(8, "failure"), run(7, "failure", OLD)]);

	expect(readFiringAlarms(work)).toEqual({
		main,
		alarms: [
			{
				name: "Landing quiet 14h",
				run: 9,
				at: Date.UTC(2026, 10, 7, 9),
				count: 2,
			},
		],
	});
	expect(fs.readFileSync(log, "utf8")).toMatch(
		/^run list --workflow landing-quiet\.yml --branch main --event schedule /,
	);
});

it("fires on none once main has moved past every failed run", () => {
	quietRuns([run(9, "failure", OLD)]);

	expect(readFiringAlarms(work).alarms).toEqual([]);
});

it("fires on none where the newest run at main's sha passed, nor on a cancelled one", () => {
	quietRuns([run(9, "success"), run(8, "failure")]);
	expect(readFiringAlarms(work).alarms).toEqual([]);

	quietRuns([run(9, "cancelled")]);
	expect(readFiringAlarms(work).alarms).toEqual([]);
});
