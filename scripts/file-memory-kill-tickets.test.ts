// @vitest-environment node
/*
 * file-memory-kill-tickets.js, driven through its command line against a stub
 * gh and a stub journalctl (#3094). Filing goes through the real
 * file-issue.js, so its label and similar-title refusals run on each incident
 * ticket. Break it and a kill incident goes unticketed, or one files twice.
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { freshSandbox } from "./lib/arbiter-testkit";
import { stubGhScript } from "./lib/gh-stub";
import { INCIDENT_GH_STUB } from "./lib/incident-gh-stub";
import {
	buildReadingLine,
	buildSignalLine,
	ONE_BOOT,
	writeFailingJournalctl,
	writeJournalctl,
} from "./lib/journalctl-fake";
import { runInProcess } from "./lib/run-in-process";

const SCRIPT = path.resolve(__dirname, "file-memory-kill-tickets.js");

const sb = freshSandbox();
const repo = () => path.join(sb.dir, "wfc");
const stub = (name: string) => path.join(sb.dir, "gh", name);

const MIN = 60 * 1000;
/** Kills `minutesAgo` each, written where the stub journalctl serves them. */
function seed(minutesAgo: number[], tickets: object[] = []) {
	fs.mkdirSync(path.join(repo(), ".git"), { recursive: true });
	fs.mkdirSync(path.join(repo(), ".claude"), { recursive: true });
	fs.writeFileSync(
		path.join(repo(), ".claude", "workflow-core.json"),
		JSON.stringify({ contract: 1, founder: "T", tracker: "acme/wfc" }),
	);
	fs.mkdirSync(path.join(sb.dir, "gh"), { recursive: true });
	fs.writeFileSync(stub("tickets.json"), JSON.stringify(tickets));
	const now = Date.now();
	writeJournalctl(
		path.join(sb.dir, "gh"),
		minutesAgo.flatMap((m, i) => [
			buildReadingLine(now - m * MIN),
			buildSignalLine(now - m * MIN, 100 + i, i % 2 ? "2.1.310" : "MainThread"),
		]),
	);
}

const run = (argv: string[] = []) =>
	runInProcess(SCRIPT, argv, {
		cwd: repo(),
		env: {
			...process.env,
			...stubGhScript(sb.dir, INCIDENT_GH_STUB).env,
			CLAUDE_PROJECT_DIR: repo(),
			STUB_DIR: path.join(sb.dir, "gh"),
			WFC_JOURNALCTL: stub("journalctl"),
			WFC_REFILL_DIR: path.join(sb.dir, "refill"),
		},
	});

const readCreated = () =>
	fs
		.readdirSync(path.join(sb.dir, "gh"))
		.filter((n) => n.startsWith("created-"))
		.map((n) => JSON.parse(fs.readFileSync(stub(n), "utf8")));

describe("file-memory-kill-tickets.js (#3094)", () => {
	it("files one takes:triage ticket per incident that is over, and never a second", () => {
		/* Two incidents over, 100 min apart; one 5 min old, not over. */
		seed([300, 290, 190, 5]);
		const first = run();
		expect(first.stderr).toBe("");
		expect(first.status).toBe(0);
		const created = readCreated();
		expect(created).toHaveLength(2);
		for (const c of created) {
			expect(c.title).toMatch(/^Memory kill incident from /);
			expect(c.labels).toEqual(["takes:triage", "origin:incident"]);
			expect(c.body).toContain("Standalone: a memory kill incident");
		}
		expect(created[0].body).toContain(
			"By kind: Claude host 1, node or python process 1.",
		);
		/* The second incident's title resembles the first's: file-issue.js
		 * refused it once, so it was filed on the re-run naming the first. */
		expect(first.stdout).toMatch(/: filed #900\.\n.*: filed #901\.\n$/s);

		const second = run();
		expect(second.status).toBe(0);
		expect(second.stdout).toBe("");
		expect(readCreated()).toHaveLength(2);
	});

	it("names a victim the headless run store holds as that run, with its job id (#4143)", () => {
		seed([300]);
		const runDir = path.join(sb.dir, "refill", ".headless-runs", "0aaaaaaa");
		fs.mkdirSync(runDir, { recursive: true });
		fs.writeFileSync(
			path.join(runDir, "run.json"),
			JSON.stringify({
				jobId: "0aaaaaaa",
				pid: 100,
				bootId: ONE_BOOT.id,
				launchedAt: Date.now() - 310 * MIN,
			}),
		);
		expect(run().status).toBe(0);
		const [created] = readCreated();
		expect(created.body).toContain("By kind: headless run 1 (job 0aaaaaaa).");
	});

	it("files nothing for an incident a ticket of its title already covers, open or closed", () => {
		seed([300]);
		const [title] = run(["--dry-run"]).stdout.split("\n");
		fs.writeFileSync(
			stub("tickets.json"),
			JSON.stringify([{ number: 41, title, state: "CLOSED" }]),
		);
		const r = run();
		expect(r.status).toBe(0);
		expect(readCreated()).toHaveLength(0);
		/* Recorded, so the next run asks the tracker nothing. */
		fs.writeFileSync(stub("calls.log"), "");
		expect(run().status).toBe(0);
		expect(fs.readFileSync(stub("calls.log"), "utf8")).toBe("");
	});

	it("exits 1 where an incident is not filed, and files it on the next run", () => {
		seed([300]);
		fs.writeFileSync(stub("fail-create"), "");
		const failed = run();
		expect(failed.status).toBe(1);
		expect(failed.stderr).toMatch(
			/^Memory kill incident from .*: not filed: file-issue: gh issue create failed \(HTTP 422\)/,
		);
		expect(readCreated()).toHaveLength(0);

		fs.rmSync(stub("fail-create"));
		const again = run();
		expect(again.status).toBe(0);
		expect(again.stdout).toMatch(/: filed #900\.\n$/);
	});

	it("exits 1 filing nothing where the tracker cannot be read", () => {
		seed([300]);
		fs.writeFileSync(stub("down"), "");
		const r = run();
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("Nothing filed.");
		expect(readCreated()).toHaveLength(0);
	});

	it("files nothing, saying why on stderr, where the journal does not read", () => {
		seed([300]);
		writeFailingJournalctl(path.join(sb.dir, "gh"));
		const r = run();
		expect(r.status).toBe(0);
		expect(r.stderr).toContain("earlyoom's journal unread, nothing filed");
		expect(fs.existsSync(stub("calls.log"))).toBe(false);
	});
});
