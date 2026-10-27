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
import {
	readingLine,
	signalLine,
	writeFailingJournalctl,
	writeJournalctl,
} from "./lib/earlyoom-journal-fake";
import { stubGhScript } from "./lib/gh-stub";
import { runInProcess } from "./lib/run-in-process";

const SCRIPT = path.resolve(__dirname, "file-memory-kill-tickets.js");

const sb = freshSandbox();
const repo = () => path.join(sb.dir, "wfc");
const stub = (name: string) => path.join(sb.dir, "gh", name);

/**
 * `gh` over one tracker's incident tickets (`tickets.json`), logging every
 * call to `calls.log`. A create appends to `tickets.json`, so a second run
 * sees the first's ticket. The similar-title list holds the tickets among
 * enough unrelated titles that an earlier incident's scores above the cut.
 */
const STUB = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const f = (n) => path.join(process.env.STUB_DIR, n);
const a = process.argv.slice(2);
const read = (n) => JSON.parse(fs.readFileSync(f(n), "utf8"));
const say = (o) => { process.stdout.write(JSON.stringify(o)); process.exit(0); };
fs.appendFileSync(f("calls.log"), a.join(" ") + "\\n");
if (fs.existsSync(f("down"))) { process.stderr.write("HTTP 502\\n"); process.exit(1); }
if (a[0] === "api" && a[1] === "repos/acme/wfc/labels") say([[{ name: "takes:triage" }]]);
if (a[0] === "issue" && a[1] === "list" && a.includes("--search")) say(read("tickets.json"));
if (a[0] === "issue" && a[1] === "list") say([
	...read("tickets.json"),
	...Array.from({ length: 100 }, (_, i) => ({ number: i + 1, title: "Fix widget " + i, state: "CLOSED" })),
]);
if (a[0] === "issue" && a[1] === "create") {
	const tickets = read("tickets.json");
	const number = 900 + tickets.length;
	const title = a[a.indexOf("--title") + 1];
	const labels = a.flatMap((x, i) => (a[i - 1] === "--label" ? [x] : []));
	fs.writeFileSync(f("created-" + number + ".json"), JSON.stringify({ title, labels, body: fs.readFileSync(0, "utf8") }));
	fs.writeFileSync(f("tickets.json"), JSON.stringify([...tickets, { number, title, state: "OPEN" }]));
	process.stdout.write("https://github.com/acme/wfc/issues/" + number + "\\n");
	process.exit(0);
}
process.stderr.write("gh stub: unsupported: " + a.join(" ") + "\\n");
process.exit(1);
`;

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
			readingLine(now - m * MIN),
			signalLine(now - m * MIN, 100 + i, i % 2 ? "2.1.310" : "MainThread"),
		]),
	);
}

const run = (argv: string[] = []) =>
	runInProcess(SCRIPT, argv, {
		cwd: repo(),
		env: {
			...process.env,
			...stubGhScript(sb.dir, STUB).env,
			CLAUDE_PROJECT_DIR: repo(),
			STUB_DIR: path.join(sb.dir, "gh"),
			WFC_JOURNALCTL: stub("journalctl"),
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
			expect(c.labels).toEqual(["takes:triage"]);
			expect(c.body).toContain("Standalone: a memory kill incident");
		}
		expect(created[0].body).toContain(
			"By kind: Claude host 1, test or build 1, other 0.",
		);
		/* The second incident's title resembles the first's: file-issue.js
		 * refused it once, so it was filed on the re-run naming the first. */
		expect(first.stdout).toMatch(/: filed #900\.\n.*: filed #901\.\n$/s);

		const second = run();
		expect(second.status).toBe(0);
		expect(second.stdout).toBe("");
		expect(readCreated()).toHaveLength(2);
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
