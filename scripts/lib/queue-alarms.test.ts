// @vitest-environment node
/*
 * The off-machine queue alarms' reader (#4772). Loosen it and a red alarm
 * reaches only the founder's inbox again, or an alarm from before `main`
 * last moved keeps a stall ticket open.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubGhScript } from "./gh-stub";

const { firingAlarm, readFiringAlarms } = require("./queue-alarms.js");

const MAIN = "a".repeat(40);
const OLD = "b".repeat(40);
const run = (databaseId: number, conclusion: string, headSha = MAIN) => ({
	databaseId,
	conclusion,
	createdAt: new Date(Date.UTC(2026, 10, 7, databaseId)).toISOString(),
	headSha,
});

describe("firingAlarm", () => {
	it("fires on the failed runs at main's sha, newest first, counting them", () => {
		expect(
			firingAlarm(
				"Landing quiet 14h",
				[run(9, "failure"), run(8, "failure"), run(7, "failure", OLD)],
				MAIN,
			),
		).toEqual({
			name: "Landing quiet 14h",
			run: 9,
			at: Date.UTC(2026, 10, 7, 9),
			count: 2,
		});
	});

	it("fires on none once main has moved past every failed run", () => {
		expect(
			firingAlarm("Landing quiet 14h", [run(9, "failure", OLD)], MAIN),
		).toBeNull();
	});

	it("fires on none where the newest run at main's sha passed, nor on a cancelled one", () => {
		expect(
			firingAlarm(
				"Queue ref waiting 2h",
				[run(9, "success"), run(8, "failure")],
				MAIN,
			),
		).toBeNull();
		expect(
			firingAlarm("Queue ref waiting 2h", [run(9, "cancelled")], MAIN),
		).toBeNull();
	});
});

describe("readFiringAlarms", () => {
	let tmp: string;
	let work: string;
	const git = (cwd: string, args: string[]) =>
		execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

	beforeEach(() => {
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), "queue-alarms-"));
		const remote = path.join(tmp, "remote.git");
		work = path.join(tmp, "work");
		git(tmp, ["init", "-q", "--bare", "-b", "main", remote]);
		git(tmp, ["clone", "-q", remote, work]);
		git(work, ["config", "user.email", "t@t"]);
		git(work, ["config", "user.name", "t"]);
		git(work, ["commit", "-q", "--allow-empty", "-m", "seed"]);
		git(work, ["push", "-q", "origin", "HEAD:main"]);
		const log = path.join(tmp, "calls.log");
		const { env } = stubGhScript(
			tmp,
			`#!/usr/bin/env node
const fs = require("node:fs");
const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, a.join(" ") + "\\n");
if (a[0] === "run" && a[1] === "list" && a[a.indexOf("--workflow") + 1] === "landing-quiet.yml")
	process.stdout.write(JSON.stringify([
		{ databaseId: 42, conclusion: "failure", createdAt: "2026-11-07T08:50:00Z", headSha: ${JSON.stringify(git(work, ["rev-parse", "HEAD"]))} },
	]));
else process.exit(1);
`,
		);
		vi.stubEnv("WFC_GH", env.WFC_GH);
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		fs.rmSync(tmp, { recursive: true, force: true });
	});

	it("reads no run where the checkout has no alarm workflow", () => {
		expect(readFiringAlarms(work)).toEqual([]);
		expect(fs.existsSync(path.join(tmp, "calls.log"))).toBe(false);
	});

	it("reads each present workflow's scheduled runs on main against the remote's main", () => {
		const workflows = path.join(work, ".github", "workflows");
		fs.mkdirSync(workflows, { recursive: true });
		fs.writeFileSync(path.join(workflows, "landing-quiet.yml"), "");

		expect(readFiringAlarms(work)).toEqual([
			{
				name: "Landing quiet 14h",
				run: 42,
				at: Date.parse("2026-11-07T08:50:00Z"),
				count: 1,
			},
		]);
		expect(fs.readFileSync(path.join(tmp, "calls.log"), "utf8")).toMatch(
			/^run list --workflow landing-quiet\.yml --branch main --event schedule /,
		);
	});
});
