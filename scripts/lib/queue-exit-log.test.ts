// @vitest-environment node
/*
 * queue-exit-log.test.ts — the queue-exit store's logger and path (#1215).
 * The four exits themselves are driven through `main` in run-vitest.test.ts;
 * this file holds what the store promises on its own: the 14-day series
 * survives pruning, a failed write never throws, and a worktree's run lands
 * in the canonical checkout's file.
 *
 * Every case writes to a log under the system temp dir, and the worktree case
 * builds a throwaway repo with a real `git worktree`, so the machine's own
 * queue-exit log is never touched.
 *
 * `report-suite-queue-wait.js`, launched at every session start by
 * `sweep-debts-detached.sh`, sums this log into the daily queue-wait alarm
 * (#1157); a loosened case lets lines drop or land in a worktree's file, and
 * the alarm under-reads the wait it exists to surface.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { queueExitLogPath, queueExitLogger } = require("./queue-exit-log.js");

const dirs: string[] = [];
afterEach(() => {
	while (dirs.length > 0)
		fs.rmSync(dirs.pop() as string, { recursive: true, force: true });
});
const tmp = () => {
	const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "qexit-")));
	dirs.push(d);
	return d;
};
const DAY_MS = 24 * 60 * 60 * 1000;
const read = (file: string) =>
	fs
		.readFileSync(file, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l));

describe("queueExitLogger's store (#1215)", () => {
	/* The logger stamps and prunes off `Date`, so the clock is faked (§X9). */
	const now = Date.parse("2026-10-10T00:00:00Z");
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(now);
	});
	afterEach(() => vi.useRealTimers());
	const at = (ago: number) => new Date(now - ago).toISOString();
	const hourMs = DAY_MS / 24;
	const logTo = (file: string | null) => {
		const said: string[] = [];
		const log = queueExitLogger({
			file,
			kind: "bare",
			session: null,
			label: "t",
			err: { write: (s: string) => said.push(s) },
		});
		return { log, said };
	};

	it("keeps 30 days, over the 14-day series #1157 files, once the oldest is a day past it", () => {
		const file = path.join(tmp(), "log.jsonl");
		const ages = [32 * DAY_MS, 30 * DAY_MS + hourMs, 30 * DAY_MS - hourMs];
		fs.writeFileSync(
			file,
			ages.map((ago) => `${JSON.stringify({ at: at(ago) })}\n`).join(""),
		);
		const { log, said } = logTo(file);
		log("opened", 0);
		const lines = read(file);
		expect(lines.map((l) => l.at)).toEqual([at(30 * DAY_MS - hourMs), at(0)]);
		expect(lines[1]).toMatchObject({ reason: "opened", kind: "bare" });
		expect(said).toEqual([]);
	});

	it("leaves the file alone until the oldest line is a day past retention", () => {
		const file = path.join(tmp(), "log.jsonl");
		const old = at(31 * DAY_MS - hourMs);
		fs.writeFileSync(file, `${JSON.stringify({ at: old })}\nnot json\n`);
		logTo(file).log("opened", 0);
		expect(fs.readFileSync(file, "utf8").split("\n")[1]).toBe("not json");
	});

	it("says a line that did not land rather than throwing, and is silent with no log", () => {
		const unwritable = path.join(tmp(), "no", "log.jsonl");
		const missed = logTo(unwritable);
		expect(() => missed.log("killed", 0)).not.toThrow();
		expect(missed.said.join("")).toContain(`not logged to ${unwritable}`);
		const none = logTo(null);
		expect(() => none.log("killed", 0)).not.toThrow();
		expect(none.said).toEqual([]);
	});
});

describe("queueExitLogPath", () => {
	it("roots a worktree's log in the canonical checkout's markers", () => {
		const repo = tmp();
		for (const args of [
			["init", "-q"],
			["-c", "user.email=t@e", "-c", "user.name=t", "commit", "-q"].concat([
				"--allow-empty",
				"-m",
				"root",
			]),
			["worktree", "add", "-q", "--detach", path.join(repo, "wt")],
		])
			spawnSync("git", args, { cwd: repo });
		const want = path.join(
			repo,
			".claude",
			"tmp",
			"markers",
			".suite-queue-exits.jsonl",
		);
		expect(queueExitLogPath(repo)).toBe(want);
		expect(queueExitLogPath(path.join(repo, "wt"))).toBe(want);
	});

	it("is null outside a git checkout", () => {
		expect(queueExitLogPath(tmp())).toBeNull();
	});
});
