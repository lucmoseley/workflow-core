/*
 * The morning review scripts' shared fixture (#2011, #2017): a fixture home
 * with one included checkout, `wfc`, filing on acme/wfc, and a stub `gh` over
 * its review issues, closes, labelled issues and comments. Each script's test
 * drives its own script against it.
 */

import fs from "node:fs";
import path from "node:path";
import type { freshSandbox } from "./arbiter-testkit";
import {
	readingLine,
	signalLine,
	writeJournalctl,
} from "./earlyoom-journal-fake";
import { stubGhScript } from "./gh-stub";
import { runInProcess } from "./run-in-process";

/**
 * `gh` over one tracker's review issues (`reviews.json`), closes
 * (`closed.json`), and open `urgent` and `parked` issues (`urgent.json`,
 * `parked.json`) with their timelines (`timelines.json`), the idle alarm's
 * GraphQL read of its open issues (`idle.json`'s nodes), logging every call
 * to `calls.log`. A review's create appends to `reviews.json`, so a second
 * run sees the first's issue, and fails where `fail-review-create` exists; a
 * comment appends to its issue there unless `fail-comment` exists.
 * file-issue.js's similar-title list also holds an open lookalike, #1995,
 * among enough unrelated titles that it scores above the cut.
 */
const Stub = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const f = (n) => path.join(process.env.STUB_DIR, n);
const a = process.argv.slice(2);
const read = (n) => JSON.parse(fs.readFileSync(f(n), "utf8"));
const say = (o) => { process.stdout.write(JSON.stringify(o)); process.exit(0); };
fs.appendFileSync(f("calls.log"), a.join(" ") + "\\n");
const timeline = (a[1] ?? "").split("/");
if (a[0] === "api" && a[1] === "graphql") say([{ data: { repository: { issues: { pageInfo: { hasNextPage: false }, nodes: read("idle.json") } } } }]);
if (a[0] === "api" && timeline[5] === "timeline") say([read("timelines.json")[timeline[4]] ?? []]);
if (a[0] === "issue" && a[1] === "list" && a[a.indexOf("--label") + 1] === "urgent") say(read("urgent.json"));
if (a[0] === "issue" && a[1] === "list" && a[a.indexOf("--label") + 1] === "parked") say(read("parked.json"));
if (a[0] === "api" && a[1] === "repos/acme/wfc/labels") say([[{ name: "takes:wayfinder" }, { name: "takes:implement" }]]);
if (a[0] === "issue" && a[1] === "list" && a.includes('in:title "Memory kill incident from"')) say(read("kills.json"));
if (a[0] === "issue" && a[1] === "list" && a.includes("--search") && !a.includes("--label")) say(read("closed.json"));
if (a[0] === "issue" && a[1] === "list" && a.includes("--label"))
	say(read("reviews.json").filter((i) => a[a.indexOf("--state") + 1] === "all" || i.state === a[a.indexOf("--state") + 1].toUpperCase()));
if (a[0] === "issue" && a[1] === "comment") {
	if (fs.existsSync(f("fail-comment"))) { process.stderr.write("HTTP 502\\n"); process.exit(1); }
	const reviews = read("reviews.json");
	const issue = reviews.find((i) => String(i.number) === a[2]);
	issue.comments = [...(issue.comments ?? []), { url: "ack-" + (issue.comments ?? []).length, body: fs.readFileSync(0, "utf8") }];
	fs.writeFileSync(f("reviews.json"), JSON.stringify(reviews));
	process.exit(0);
}
if (a[0] === "issue" && a[1] === "list") say([
	...read("reviews.json"),
	{ number: 1995, title: "Away mode: the morning review issue", state: "OPEN" },
	...Array.from({ length: 100 }, (_, i) => ({ number: i + 1, title: "Fix widget " + i, state: "CLOSED" })),
]);
if (a[0] === "issue" && a[1] === "create") {
	const reviews = read("reviews.json");
	const number = 900 + reviews.length;
	const title = a[a.indexOf("--title") + 1];
	if (title.startsWith("Morning review") && fs.existsSync(f("fail-review-create"))) { process.stderr.write("HTTP 502\\n"); process.exit(1); }
	const labels = a.flatMap((x, i) => (a[i - 1] === "--label" ? [x] : []));
	fs.writeFileSync(f("created-" + number + ".json"), JSON.stringify({ title, labels, body: fs.readFileSync(0, "utf8") }));
	if (title.startsWith("Morning review"))
		fs.writeFileSync(f("reviews.json"), JSON.stringify([...reviews, { number, title, state: "OPEN", createdAt: new Date().toISOString(), labels: [] }]));
	process.stdout.write("https://github.com/acme/wfc/issues/" + number + "\\n");
	process.exit(0);
}
process.stderr.write("gh stub: unsupported: " + a.join(" ") + "\\n");
process.exit(1);
`;

export const HOUR = 60 * 60 * 1000;

export function morningReviewFixture(
	sb: ReturnType<typeof freshSandbox>,
	script: string,
) {
	/** The fixture home: one included checkout, `wfc`, filing on acme/wfc. */
	const home = () => path.join(sb.dir, "fixture-home");
	const wfc = () => path.join(home(), "wfc");
	const stub = (name: string) => path.join(sb.dir, "gh", name);

	const ago = (hours: number) =>
		new Date(Date.now() - hours * HOUR).toISOString();

	function seed(reviews: object[]) {
		fs.mkdirSync(path.join(wfc(), ".git"), { recursive: true });
		fs.mkdirSync(path.join(wfc(), ".claude", "tmp", "markers"), {
			recursive: true,
		});
		fs.writeFileSync(
			path.join(wfc(), ".claude", "workflow-core.json"),
			JSON.stringify({ contract: 1, founder: "T", tracker: "acme/wfc" }),
		);
		const entry = (at: string, issue: number, question: string) => ({
			at,
			repo: "acme/wfc",
			issue,
			comment: `https://github.com/acme/wfc/issues/${issue}#issuecomment-1`,
			question,
			taken: { option: "(A) keep", figure: 52 },
			runnerUp: { option: "(B) drop", figure: 48 },
			rungs: { rulings: "none", web: "none", subagent: "none" },
			stillClose: true,
			reverse: "drop it",
		});
		fs.writeFileSync(
			path.join(
				wfc(),
				".claude",
				"tmp",
				"markers",
				"delegated-decisions.jsonl",
			),
			`${[entry(ago(30), 1, "Before the window"), entry(ago(2), 2, "Inside the window")].map((e) => JSON.stringify(e)).join("\n")}\n{"at": "torn\n`,
		);
		fs.mkdirSync(path.join(sb.dir, "gh"), { recursive: true });
		fs.writeFileSync(stub("reviews.json"), JSON.stringify(reviews));
		fs.writeFileSync(stub("urgent.json"), "[]");
		fs.writeFileSync(stub("parked.json"), "[]");
		fs.writeFileSync(stub("timelines.json"), "{}");
		fs.writeFileSync(stub("idle.json"), "[]");
		/* One earlyoom kill 3 h ago, its incident ticketed as #61. */
		const killedAt = Date.now() - 3 * HOUR;
		writeJournalctl(path.join(sb.dir, "gh"), [
			readingLine(killedAt),
			signalLine(killedAt, 9, "2.1.310"),
		]);
		const { incidentTitle } = require("./earlyoom-kills.js");
		fs.writeFileSync(
			stub("kills.json"),
			JSON.stringify([
				{
					number: 61,
					title: incidentTitle({ first: new Date(killedAt).toISOString() }),
				},
			]),
		);
		fs.writeFileSync(
			stub("closed.json"),
			JSON.stringify([
				{
					number: 77,
					title: "Drop the old ledger",
					url: "https://github.com/acme/wfc/issues/77",
					closedAt: ago(1),
					comments: [{ body: "**Door:** one-way — deleted data; cannot" }],
				},
			]),
		);
	}

	const run = (argv: string[] = []) =>
		runInProcess(script, argv, {
			cwd: wfc(),
			env: {
				...process.env,
				...stubGhScript(sb.dir, Stub).env,
				HOME: home(),
				CLAUDE_PROJECT_DIR: wfc(),
				STUB_DIR: path.join(sb.dir, "gh"),
				WFC_JOURNALCTL: stub("journalctl"),
				WFC_REFILL_DIR: path.join(sb.dir, "refill"),
				MEMWATCH_MINUTE_LOG: path.join(
					sb.dir,
					"refill",
					"memwatch-minute.jsonl",
				),
			},
		});

	const readCreated = () =>
		fs
			.readdirSync(path.join(sb.dir, "gh"))
			.filter((n) => n.startsWith("created-"))
			.map((n) => JSON.parse(fs.readFileSync(stub(n), "utf8")));

	return { ago, home, readCreated, run, seed, stub, wfc };
}
