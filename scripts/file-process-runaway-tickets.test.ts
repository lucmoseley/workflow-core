// @vitest-environment node
/*
 * file-process-runaway-tickets.js, driven through its command line against a
 * stub gh and a written firing log (#3807). Filing goes through the real
 * file-issue.js. Break it and a runaway memwatch killed goes unreported, or one
 * files a ticket a tick.
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { freshSandbox } from "./lib/arbiter-testkit";
import { stubGhScript } from "./lib/gh-stub";
import { INCIDENT_GH_STUB } from "./lib/incident-gh-stub";
import { runInProcess } from "./lib/run-in-process";

const SCRIPT = path.resolve(__dirname, "file-process-runaway-tickets.js");

const sb = freshSandbox();
const repo = () => path.join(sb.dir, "wfc");
const stub = (name: string) => path.join(sb.dir, "gh", name);
const logFile = () => path.join(sb.dir, "runaway.jsonl");

const MIN = 60 * 1000;
const at = (minutesAgo: number) =>
	new Date(Date.now() - minutesAgo * MIN)
		.toISOString()
		.replace(/\.\d+Z$/, "+0000");
const firing = (since: number, ts: number, over: object = {}) =>
	JSON.stringify({
		ts: at(ts),
		since: at(since),
		procs: 750,
		argv: "bash /tmp/ap.sh head",
		size: 700,
		parents: [{ pid: 9, kids: 1, argv: "bash /tmp/ap.sh head" }],
		killed: [11, 12],
		...over,
	});

function seed(lines: string[]) {
	fs.mkdirSync(path.join(repo(), ".git"), { recursive: true });
	fs.mkdirSync(path.join(repo(), ".claude"), { recursive: true });
	fs.writeFileSync(
		path.join(repo(), ".claude", "workflow-core.json"),
		JSON.stringify({ contract: 1, founder: "T", tracker: "acme/wfc" }),
	);
	fs.mkdirSync(path.join(sb.dir, "gh"), { recursive: true });
	fs.writeFileSync(stub("tickets.json"), "[]");
	fs.writeFileSync(logFile(), `${lines.join("\n")}\n`);
}

const run = (argv: string[] = []) =>
	runInProcess(SCRIPT, argv, {
		cwd: repo(),
		env: {
			...process.env,
			...stubGhScript(sb.dir, INCIDENT_GH_STUB).env,
			CLAUDE_PROJECT_DIR: repo(),
			STUB_DIR: path.join(sb.dir, "gh"),
			WFC_RUNAWAY_LOG: logFile(),
		},
	});

const readCreated = () =>
	fs
		.readdirSync(path.join(sb.dir, "gh"))
		.filter((n) => n.startsWith("created-"))
		.map((n) => JSON.parse(fs.readFileSync(stub(n), "utf8")));

describe("file-process-runaway-tickets.js (#3807)", () => {
	it("files one takes:triage ticket per episode naming the argv, however many ticks read it", () => {
		seed([
			firing(30, 20),
			firing(30, 19, { killed: [13] }),
			'{"ts": "torn',
			firing(9, 1, { argv: "other | `x`", killed: [] }),
		]);
		const first = run();
		expect(first.stderr).toBe("");
		expect(first.status).toBe(0);
		const created = readCreated();
		expect(created).toHaveLength(2);
		for (const c of created) {
			expect(c.title).toMatch(/^Process runaway from .* UTC \([0-9a-f]{8}\)$/);
			expect(c.labels).toEqual(["takes:triage"]);
			expect(c.body).toContain("Standalone: a process runaway");
		}
		expect(created[0].body).toContain("SIGKILL to 3 processes");
		expect(created[0].body).toContain(
			"Largest group, 700 processes: `bash /tmp/ap.sh head`",
		);
		/* A process's own argv cannot break out of the code span or the table. */
		expect(created[1].body).toContain("`other ? ?x?`");
		expect(created[1].body).toContain("It killed nothing");

		const second = run();
		expect(second.status).toBe(0);
		expect(second.stdout).toBe("");
		expect(readCreated()).toHaveLength(2);

		/* A later firing in a filed episode files nothing more. */
		fs.appendFileSync(logFile(), `${firing(30, 1)}\n`);
		expect(run().status).toBe(0);
		expect(readCreated()).toHaveLength(2);

		/* A second group under the same `since` reaches a ticket of its own. */
		fs.appendFileSync(logFile(), `${firing(30, 1, { argv: "another" })}\n`);
		expect(run().status).toBe(0);
		expect(readCreated()).toHaveLength(3);
	});

	it("files nothing for an episode a ticket of its title already covers", () => {
		seed([firing(30, 20)]);
		const [title] = run(["--dry-run"]).stdout.split("\n");
		fs.writeFileSync(
			stub("tickets.json"),
			JSON.stringify([{ number: 41, title, state: "CLOSED" }]),
		);
		expect(run().status).toBe(0);
		expect(readCreated()).toHaveLength(0);
	});

	it("files nothing for an episode past its lookback", () => {
		seed([firing(5000, 4990)]);
		const r = run();
		expect(r.status).toBe(0);
		expect(r.stdout).toBe("");
	});

	it("exits 1 filing nothing where the tracker cannot be read", () => {
		seed([firing(30, 20)]);
		fs.writeFileSync(stub("down"), "");
		const r = run();
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("Nothing filed.");
		expect(readCreated()).toHaveLength(0);
	});

	it("passes quietly where memwatch has never fired, and says so where the log will not read", () => {
		seed([]);
		fs.rmSync(logFile());
		expect(run().status).toBe(0);
		expect(fs.existsSync(stub("calls.log"))).toBe(false);
		fs.mkdirSync(logFile());
		const r = run();
		expect(r.status).toBe(0);
		expect(r.stderr).toContain("memwatch's runaway log unread, nothing filed");
		fs.rmSync(logFile(), { recursive: true });
	});
});
