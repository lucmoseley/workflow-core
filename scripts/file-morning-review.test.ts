// @vitest-environment node
/*
 * file-morning-review.js, driven through its command line against a stub gh
 * (#2011). Filing goes through the real file-issue.js, so its label refusals
 * and similar-title check run on the review issue as on any other. Break it
 * and the loop files no review, or two in a day.
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { freshSandbox } from "./lib/arbiter-testkit";
import {
	readingLine,
	signalLine,
	writeJournalctl,
} from "./lib/earlyoom-journal-fake";
import { stubGhScript } from "./lib/gh-stub";
import { runInProcess } from "./lib/run-in-process";

const SCRIPT = path.resolve(__dirname, "file-morning-review.js");

const sb = freshSandbox();

/** The fixture home: one included checkout, `wfc`, filing on acme/wfc. */
const home = () => path.join(sb.dir, "fixture-home");
const wfc = () => path.join(home(), "wfc");
const stub = (name: string) => path.join(sb.dir, "gh", name);

/**
 * `gh` over one tracker's review issues (`reviews.json`), closes
 * (`closed.json`), and open `urgent` and `parked` issues (`urgent.json`,
 * `parked.json`) with their timelines (`timelines.json`), logging every call to `calls.log`. A review's create appends to `reviews.json`, so a second
 * run sees the first's issue, and a comment appends to its issue there unless
 * `fail-comment` exists. file-issue.js's similar-title list also holds an open
 * lookalike, #1995, among enough unrelated titles that it scores above the
 * cut.
 */
const STUB = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const f = (n) => path.join(process.env.STUB_DIR, n);
const a = process.argv.slice(2);
const read = (n) => JSON.parse(fs.readFileSync(f(n), "utf8"));
const say = (o) => { process.stdout.write(JSON.stringify(o)); process.exit(0); };
fs.appendFileSync(f("calls.log"), a.join(" ") + "\\n");
const timeline = (a[1] ?? "").split("/");
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

const localDate = (d: Date) =>
	[d.getFullYear(), d.getMonth() + 1, d.getDate()]
		.map((v) => String(v).padStart(2, "0"))
		.join("-");
const TODAY = `Morning review — ${localDate(new Date())}`;
const HOUR = 60 * 60 * 1000;
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
		path.join(wfc(), ".claude", "tmp", "markers", "delegated-decisions.jsonl"),
		`${[entry(ago(30), 1, "Before the window"), entry(ago(2), 2, "Inside the window")].map((e) => JSON.stringify(e)).join("\n")}\n{"at": "torn\n`,
	);
	fs.mkdirSync(path.join(sb.dir, "gh"), { recursive: true });
	fs.writeFileSync(stub("reviews.json"), JSON.stringify(reviews));
	fs.writeFileSync(stub("urgent.json"), "[]");
	fs.writeFileSync(stub("parked.json"), "[]");
	fs.writeFileSync(stub("timelines.json"), "{}");
	/* One earlyoom kill 3 h ago, its incident ticketed as #61. */
	const killedAt = Date.now() - 3 * HOUR;
	writeJournalctl(path.join(sb.dir, "gh"), [
		readingLine(killedAt),
		signalLine(killedAt, 9, "2.1.310"),
	]);
	const { incidentTitle } = require("./lib/earlyoom-kills.js");
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
	runInProcess(SCRIPT, argv, {
		cwd: wfc(),
		env: {
			...process.env,
			...stubGhScript(sb.dir, STUB).env,
			HOME: home(),
			CLAUDE_PROJECT_DIR: wfc(),
			STUB_DIR: path.join(sb.dir, "gh"),
			WFC_JOURNALCTL: stub("journalctl"),
			WFC_REFILL_DIR: path.join(sb.dir, "refill"),
			MEMWATCH_MINUTE_LOG: path.join(sb.dir, "refill", "memwatch-minute.jsonl"),
		},
	});

const readCreated = () =>
	fs
		.readdirSync(path.join(sb.dir, "gh"))
		.filter((n) => n.startsWith("created-"))
		.map((n) => JSON.parse(fs.readFileSync(stub(n), "utf8")));

describe("file-morning-review.js (#2011)", () => {
	it("files today's review once, through file-issue.js, windowed from the previous review issue", () => {
		seed([
			{
				number: 5,
				title: "Morning review — 2000-01-01",
				state: "OPEN",
				createdAt: ago(24),
			},
		]);
		const first = run();
		expect(first.stderr).toBe("");
		expect(first.status).toBe(0);
		expect(first.stdout).toMatch(/#1995 \([\d.]+\) Away mode/);
		const [issue, ...more] = readCreated();
		expect(more).toHaveLength(0);
		expect(issue.title).toBe(TODAY);
		expect(issue.labels).toEqual(["takes:wayfinder"]);
		expect(issue.body).toMatch(/^## Question\n/);
		expect(issue.body).toContain("from #5, the previous review issue");
		expect(issue.body).toContain("1. acme/wfc#2 — `Inside the window`");
		expect(issue.body).not.toContain("Before the window");
		expect(issue.body).toContain(
			"- acme/wfc#77 — `Drop the old ledger` — `deleted data; cannot`",
		);
		expect(issue.body).toContain("Standalone: the day's away-mode review");
		expect(issue.body).toMatch(
			/## Memory kills\n\n1 in the window — Claude host 1, test or build 0, other 0\.\n\n- `Memory kill incident from [^`]+` — 1 kill: Claude host 1, test or build 0, other 0 — #61\n/,
		);
		expect(issue.body).toContain("- acme/wfc: `1 torn ledger line(s) skipped`");

		const second = run();
		expect(second.status).toBe(0);
		expect(second.stdout).toContain("is today's review issue already");
		expect(readCreated()).toHaveLength(1);
	});

	it("files the concurrency section from the refill loop's ticks and memwatch's minutes (#3321)", () => {
		seed([]);
		/* One base instant, so a minute line and its paired tick share a time. */
		const base = Date.now();
		const at = (min: number) =>
			new Date(base - (min / 60) * HOUR).toISOString();
		const lines = (rows: object[]) =>
			`${rows.map((r) => JSON.stringify(r)).join("\n")}\n`;
		fs.mkdirSync(path.join(sb.dir, "refill"), { recursive: true });
		/* Three days ago: 25 minutes at 6, inside the week only. Then the last
		 * hour: 30 minutes at 2, then 30 at 4. */
		fs.writeFileSync(
			path.join(sb.dir, "refill", "memwatch-minute.jsonl"),
			lines([
				{ ts: at(72 * 60), sessions: 6 },
				{ ts: at(72 * 60 - 10), sessions: 6 },
				...[60, 50, 40].map((m) => ({ ts: at(m), sessions: 2 })),
				...[30, 20, 10].map((m) => ({ ts: at(m), sessions: 4 })),
			]),
		);
		const tick = (min: number, binding: object | null, ceiling: number) => ({
			at: at(min),
			working: 4,
			ceiling,
			binding,
			also: [],
			memory: null,
		});
		const memory = { limit: "memory", why: "the spare pool holds most" };
		const last = tick(10, null, 6);
		fs.writeFileSync(
			path.join(sb.dir, "refill", "concurrency.jsonl"),
			lines([
				...[60, 50, 40, 30].map((m) => tick(m, memory, 4)),
				tick(20, null, 6),
				last,
			]),
		);
		expect(run().status).toBe(0);
		const [issue] = readCreated();
		expect(issue.body).toContain(
			[
				"## Concurrency",
				"",
				"Sustained concurrency, the founder's own sessions counted:",
				"",
				"- 3.0 over the last 24 h (1.0 h with any session working)",
				"- 3.9 over the last 7 days (1.4 h with any session working)",
				"",
				`Admission ceiling: 6 at the last refill-loop tick (${last.at}).`,
				"",
				"Hours with any session working over the last 24 h, by the limit binding then:",
				"",
				"- memory: 0.7 h",
				"- nothing (a slot was free): 0.3 h",
				"",
				"Share of those hours by how many sessions were working:",
				"",
				"- 2 working: 50%",
				"- 4 working: 50%",
				"",
				"## Parked",
			].join("\n"),
		);
	});

	it("files nothing when today's review issue is already closed", () => {
		seed([{ number: 6, title: TODAY, state: "CLOSED", createdAt: ago(1) }]);
		const r = run();
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("#6 is today's review issue already");
		expect(readCreated()).toHaveLength(0);
	});

	describe("reversals (#2017)", () => {
		const Request = "https://github.com/acme/wfc/issues/5#issuecomment-50";
		const openReview = () => ({
			number: 5,
			title: "Morning review — 2000-01-01",
			state: "OPEN",
			createdAt: ago(24),
			body: [
				"## Still-caught delegated decisions",
				"",
				"### acme/wfc",
				"",
				"1. acme/wfc#2 — `Inside the window` — taken: `(A) keep` (52%) — [#2 comment](https://github.com/acme/wfc/issues/2#issuecomment-1)",
				"",
			].join("\n"),
			comments: [{ url: Request, body: "reverse 1\nreverse 9" }],
		});
		const readReplies = () =>
			JSON.parse(fs.readFileSync(stub("reviews.json"), "utf8"))
				.find((i: { number: number }) => i.number === 5)
				.comments.slice(1)
				.map((c: { body: string }) => c.body);

		it("files a takes:implement ticket carrying the recipe and replies naming it", () => {
			seed([openReview()]);
			const r = run(["--reversals-only"]);
			expect(r.stderr).toBe("");
			expect(r.status).toBe(0);
			const [ticket, ...more] = readCreated();
			expect(more).toHaveLength(0);
			expect(ticket.labels).toEqual(["takes:implement"]);
			expect(ticket.title).toBe(
				"Reverse a delegated decision on #2: Inside the window",
			);
			expect(ticket.body).toContain("- To reverse: `drop it`");
			expect(ticket.body).toContain(
				`entry 1 of the morning review acme/wfc#5 ([#5 comment](${Request}))`,
			);
			const [filed, notFiled] = readReplies();
			expect(filed).toMatch(
				/^\*\*Reversal filed:\*\* entry 1 → acme\/wfc#9\d\d, for/,
			);
			expect(notFiled).toContain(
				"**Reversal not filed:** entry 9, for [#5 request]",
			);
			expect(notFiled).toContain("the review lists no entry 9");
		});

		it("files nothing for a request already answered", () => {
			seed([openReview()]);
			run(["--reversals-only"]);
			const again = run(["--reversals-only"]);
			expect(again.status).toBe(0);
			expect(readCreated()).toHaveLength(1);
			expect(readReplies()).toHaveLength(2);
		});

		it("answers a request on a review closed since it was written", () => {
			seed([{ ...openReview(), state: "CLOSED" }]);
			const r = run(["--reversals-only"]);
			expect(r.status).toBe(0);
			expect(readCreated()).toHaveLength(1);
			expect(readReplies()).toHaveLength(2);
		});

		it("files once when the reply fails, and replies on the next run", () => {
			seed([openReview()]);
			fs.writeFileSync(stub("fail-comment"), "");
			const failed = run(["--reversals-only"]);
			expect(failed.status).toBe(1);
			expect(failed.stderr).toContain("without filing it again");
			fs.rmSync(stub("fail-comment"));
			const again = run(["--reversals-only"]);
			expect(again.status).toBe(0);
			expect(readCreated()).toHaveLength(1);
			expect(readReplies()[0]).toMatch(
				/^\*\*Reversal filed:\*\* entry 1 → acme\/wfc#9\d\d/,
			);
		});

		it("files nothing while a live run holds the reversal lock", () => {
			seed([openReview()]);
			fs.writeFileSync(
				path.join(wfc(), ".claude", "tmp", "markers", "review-reversals.lock"),
				String(process.pid),
			);
			const r = run(["--reversals-only"]);
			expect(r.status).toBe(0);
			expect(r.stdout).toContain("another run is answering reversals");
			expect(readCreated()).toHaveLength(0);
		});
	});

	it("lists an issue urgent 8 days under Stuck urgent with pick-next's reason, not one urgent 6 days, and writes no label (#2693)", () => {
		seed([]);
		const labelled = (hours: number) => [
			{ event: "labeled", label: { name: "urgent" }, created_at: ago(hours) },
		];
		fs.writeFileSync(
			stub("urgent.json"),
			JSON.stringify([
				{ number: 50, title: "Stuck for a week" },
				{ number: 51, title: "Fresh enough" },
			]),
		);
		fs.writeFileSync(
			stub("timelines.json"),
			JSON.stringify({ 50: labelled(8 * 24), 51: labelled(6 * 24) }),
		);
		fs.mkdirSync(path.join(wfc(), ".claude", "tmp", "markers", ".pick-next"));
		fs.writeFileSync(
			path.join(
				wfc(),
				".claude",
				"tmp",
				"markers",
				".pick-next",
				"last-run.json",
			),
			JSON.stringify({
				repo: "{owner}/{repo}",
				argv: ["--json"],
				generatedAt: "2026-10-24T06:00:00Z",
				parked: [{ number: 50 }],
				frontier: [{ number: 50 }],
			}),
		);
		const r = run(["--dry-run"]);
		expect(r.status).toBe(0);
		const section = r.stdout.slice(r.stdout.indexOf("## Stuck urgent"));
		expect(section).toContain(
			"- acme/wfc#50 — `Stuck for a week` — 8 days — `parked — the refill loop never launches it (pick-next, 2026-10-24T06:00:00Z)`",
		);
		expect(section).not.toContain("#51");
		const calls = fs.readFileSync(stub("calls.log"), "utf8");
		expect(calls).not.toMatch(/issue edit|--(add|remove)-label|labels\/urgent/);
	});

	it("lists every open parked issue with its age, one whose label start will not read as age unknown, and writes no label (#2725)", () => {
		seed([]);
		fs.writeFileSync(
			stub("parked.json"),
			JSON.stringify([
				{ number: 60, title: "Waits on a round" },
				{ number: 61, title: "Labelled off the timeline" },
			]),
		);
		fs.writeFileSync(
			stub("timelines.json"),
			JSON.stringify({
				60: [
					{
						event: "labeled",
						label: { name: "parked" },
						created_at: ago(3 * 24 + 1),
					},
				],
				61: [],
			}),
		);
		const r = run(["--dry-run"]);
		expect(r.status).toBe(0);
		const section = r.stdout.slice(
			r.stdout.indexOf("## Parked"),
			r.stdout.indexOf("## Still-caught"),
		);
		expect(section).toContain("- acme/wfc#60 — `Waits on a round` — 3 days\n");
		expect(section).toContain(
			"- acme/wfc#61 — `Labelled off the timeline` — age unknown: `no 'labeled' event on the timeline`\n",
		);
		const calls = fs.readFileSync(stub("calls.log"), "utf8");
		expect(calls).not.toMatch(/issue edit|--(add|remove)-label|labels\/parked/);
	});

	it("prints the body and files nothing on --dry-run", () => {
		seed([]);
		const r = run(["--dry-run"]);
		expect(r.status).toBe(0);
		expect(r.stdout).toContain(`${TODAY}\n\n## Question`);
		expect(r.stdout).toContain("no previous review issue");
		expect(readCreated()).toHaveLength(0);
	});
});
