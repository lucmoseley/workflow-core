// @vitest-environment node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInProcess } from "./lib/run-in-process.js";

const SCRIPT = path.join(__dirname, "check-stale-suite-queue.js");
const DEAD_PID = 2 ** 30;

let root: string;
let dir: string;

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "wfc-queue-sweep-"));
	dir = path.join(root, "wfc-suite-queue");
	fs.mkdirSync(dir);
});

afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

function marker(pid: number, extra: Record<string, unknown> = {}) {
	const file = path.join(dir, `wfc-suite-queue-${pid}.json`);
	fs.writeFileSync(
		file,
		JSON.stringify({ pid, at: Date.now(), start: 0, ...extra }),
	);
	return file;
}

const run = (args: string[] = []) =>
	runInProcess(SCRIPT, args, {
		env: {
			...process.env,
			CLAUDE_PROJECT_DIR: root,
			GITHUB_ACTIONS: "",
			TMPDIR: root,
		},
	});

const report = (r: { stdout: string; stderr: string }) => r.stdout + r.stderr;

describe("what it reports", () => {
	it("names a marker whose pid does not exist", () => {
		marker(DEAD_PID);

		const r = run();
		const out = report(r);
		expect(out).toContain("STALE-QUEUE-MARKER");
		expect(out).toContain(`wfc-suite-queue-${DEAD_PID}.json`);
		expect(r.status).toBe(0);
	});

	it("says nothing about a marker whose pid is this very process", () => {
		marker(process.pid);

		const r = run();
		expect(report(r)).not.toContain("STALE-QUEUE-MARKER");
		expect(report(r)).toContain("OK:");
	});

	it("names a marker whose pid is alive but whose start time no longer matches", () => {
		marker(process.pid, { start: 1 });

		const out = report(run());
		expect(out).toContain("STALE-QUEUE-MARKER");
		expect(out).toContain(String(process.pid));
	});

	it("does not judge a marker with no start recorded, even against a dead pid's own reuse", () => {
		const file = marker(DEAD_PID, { start: 0 });

		expect(report(run())).toContain(file);
	});

	it("ignores a file that does not match the queue-marker naming", () => {
		fs.writeFileSync(path.join(dir, "unrelated.json"), "{}");

		expect(report(run())).toContain("OK:");
	});

	it("skips a marker that will not parse, rather than raising a finding", () => {
		fs.writeFileSync(
			path.join(dir, "wfc-suite-queue-99999999.json"),
			"not json",
		);

		const out = report(run());
		expect(out).not.toContain("STALE");
		expect(out).toContain("OK:");
	});

	it("skips a marker whose pid is not a number", () => {
		fs.writeFileSync(
			path.join(dir, "wfc-suite-queue-x.json"),
			JSON.stringify({ pid: "not-a-number" }),
		);

		expect(report(run())).toContain("OK:");
	});

	it("skips a marker with a numeric pid and no numeric at, matching readTurn", () => {
		fs.writeFileSync(
			path.join(dir, "wfc-suite-queue-11.json"),
			JSON.stringify({ pid: 11 }),
		);

		expect(report(run())).toContain("OK:");
	});

	it("reports an all-clear where no waiter has made the queue directory", () => {
		fs.rmSync(dir, { recursive: true, force: true });

		expect(report(run())).toContain("OK:");
	});

	it("SKIPs, rather than reporting an all-clear, when the queue directory cannot be read at all", () => {
		fs.rmSync(dir, { recursive: true, force: true });
		fs.writeFileSync(dir, "a file where the directory belongs");

		const out = report(run());
		expect(out).toContain("SKIP:");
		expect(out).not.toContain("OK:");
	});
});

describe("it never removes a marker (mantahostels#2034)", () => {
	it("leaves a stale marker on disk byte-for-byte", () => {
		const file = marker(DEAD_PID);
		const before = fs.readFileSync(file, "utf8");

		expect(report(run())).toContain("STALE-QUEUE-MARKER");

		expect(fs.existsSync(file)).toBe(true);
		expect(fs.readFileSync(file, "utf8")).toBe(before);
	});

	it("has no flag that deletes anything", () => {
		const file = marker(DEAD_PID);

		for (const flag of ["--sweep", "--fix", "--force", "--clean"]) run([flag]);

		expect(fs.existsSync(file)).toBe(true);
	});

	it("names the way out on a hand run: nothing removed, who does, when to act by hand", () => {
		marker(DEAD_PID);

		const out = report(run());
		expect(out).toContain("Nothing was removed");
		expect(out).toContain("next `--queue` suite clears it");
		expect(out).toContain("Delete by hand only if you are certain");
	});

	it("suppresses the way-out advice under --notify, where the itemised list already carries it", () => {
		marker(DEAD_PID);

		const out = run(["--notify"]).stdout;
		expect(out).toContain("STALE-QUEUE-MARKER (1) standing");
		expect(out).not.toContain("Nothing was removed");
	});
});

describe("--notify", () => {
	it("prints nothing at all when every marker is live", () => {
		marker(process.pid);

		const r = run(["--notify"]);
		expect(r.stdout.trim()).toBe("");
		expect(r.status).toBe(0);
	});

	it("prints the standing count on a stale marker, exiting 0", () => {
		marker(DEAD_PID);

		const r = run(["--notify"]);
		expect(r.stdout).toContain("STALE-QUEUE-MARKER (1) standing");
		expect(r.status).toBe(0);
	});
});
