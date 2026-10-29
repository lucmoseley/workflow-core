// @vitest-environment node
/*
 * file-morning-review.js, driven through its command line against a stub gh
 * (#2011). Filing goes through the real file-issue.js, so its label refusals
 * and similar-title check run on the review issue as on any other. Break it
 * and the loop files no review, or two in a day, or a hand run leaves the
 * founder's `reverse <n>` comments unanswered (#3388).
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { freshSandbox } from "./lib/arbiter-testkit";
import { HOUR, morningReviewFixture } from "./lib/morning-review-fixture";

const SCRIPT = path.resolve(__dirname, "file-morning-review.js");

const sb = freshSandbox();

const { ago, readCreated, run, seed, stub, wfc } = morningReviewFixture(
	sb,
	SCRIPT,
);

const localDate = (d: Date) =>
	[d.getFullYear(), d.getMonth() + 1, d.getDate()]
		.map((v) => String(v).padStart(2, "0"))
		.join("-");
const TODAY = `Morning review — ${localDate(new Date())}`;

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
		/* The fixture's .git is no repository: the history fails open to a why. */
		expect(issue.body).toMatch(
			/### acme\/wfc\n\n.+\n\nRow changes not read: `git: /,
		);

		const second = run();
		expect(second.status).toBe(0);
		expect(second.stdout).toContain("is today's review issue already");
		expect(readCreated()).toHaveLength(1);
	});

	it("files the idle alarm's section, read with the loop stopped (#3644)", () => {
		/* The section is "check-idle-efforts.js"'s --json, which the review spawns. */
		seed([]);
		fs.writeFileSync(
			stub("idle.json"),
			JSON.stringify([
				{
					number: 12,
					title: "Stranded effort",
					createdAt: ago(5 * 24),
					body: "",
					labels: { nodes: [{ name: "takes:implement" }] },
					blockedBy: { totalCount: 0, nodes: [] },
					subIssues: { nodes: [] },
				},
			]),
		);
		expect(run().status).toBe(0);
		const [issue] = readCreated();
		expect(issue.body).toContain(
			[
				"## Idle efforts",
				"",
				"Each tracker's open efforts nothing has launched lately, the oldest, and why the refill loop skips it:",
				"",
				"- `The refill loop is not running, so it serves no tracker.`",
				"- `acme/wfc: 1 idle past 2 days (the refill loop does not serve it); oldest #12 (Stranded effort), idle 5.0 days; skip reason: none, the launch filter passes it`",
				"",
			].join("\n"),
		);
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

	it("lists the window's primitives-table row changes off the checkout's git history, numbered on from the decisions (#3465)", () => {
		seed([]);
		const root = wfc();
		fs.rmSync(path.join(root, ".git"), { recursive: true });
		const git = (args: string[], env: object = {}) =>
			execFileSync("git", args, {
				cwd: root,
				env: {
					...process.env,
					GIT_AUTHOR_NAME: "T",
					GIT_AUTHOR_EMAIL: "t@example.com",
					GIT_COMMITTER_NAME: "T",
					GIT_COMMITTER_EMAIL: "t@example.com",
					...env,
				},
				encoding: "utf8",
			});
		const table = (...rows: string[]) =>
			[
				"# Standards",
				"",
				"## Primitives",
				"",
				"| Job | Primitive | Exemplar | Rule | Enforcing check |",
				"|---|---|---|---|---|",
				...rows,
				"",
			].join("\n");
		const commit = (text: string, at: string) => {
			fs.mkdirSync(path.join(root, "docs"), { recursive: true });
			fs.writeFileSync(path.join(root, "docs", "code-standards.md"), text);
			git(["add", "docs/code-standards.md"]);
			git(["commit", "-qm", "table", "--date", at], {
				GIT_COMMITTER_DATE: at,
			});
			return git(["rev-parse", "--short", "HEAD"]).trim();
		};
		git(["init", "-q"]);
		const kept =
			"| Argv | `cli-args.js` | `a.js` | §0 | Standards axis criterion |";
		commit(table(kept), ago(30));
		const sha = commit(
			table(
				kept.replace("`a.js`", "`b.js`"),
				"| Clock | `now()` | `c.js` | §0 | Standards axis criterion |",
			),
			ago(1),
		);
		const r = run(["--dry-run"]);
		expect(r.status).toBe(0);
		const section = r.stdout.slice(
			r.stdout.indexOf("## Primitives"),
			r.stdout.indexOf("## Closed tickets"),
		);
		expect(section).toMatch(/### acme\/wfc\n\n`primitives: /);
		expect(section).toContain(
			`2. acme/wfc — local row rewritten (Exemplar): \`'cli-args.js'\` — job \`Argv\` — ${sha}\n3. acme/wfc — local row added: \`'now()'\` — job \`Clock\` — ${sha}\n`,
		);
	});

	it("files nothing when today's review issue is already closed", () => {
		seed([{ number: 6, title: TODAY, state: "CLOSED", createdAt: ago(1) }]);
		const r = run();
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("#6 is today's review issue already");
		expect(readCreated()).toHaveLength(0);
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

	describe("answering reversals on the same run (#3388)", () => {
		const reviewWithRequest = () => ({
			number: 5,
			title: "Morning review — 2000-01-01",
			state: "OPEN",
			createdAt: ago(24),
			body: "1. acme/wfc#2 — `Inside the window` — taken: `(A) keep` (52%) — [#2 comment](https://github.com/acme/wfc/issues/2#issuecomment-1)\n",
			comments: [
				{
					url: "https://github.com/acme/wfc/issues/5#issuecomment-50",
					body: "reverse 1",
				},
			],
		});
		const readReplies = () =>
			JSON.parse(fs.readFileSync(stub("reviews.json"), "utf8"))
				.find((i: { number: number }) => i.number === 5)
				.comments.slice(1);

		it("files today's review and a takes:implement ticket for each unanswered reverse <n>", () => {
			seed([reviewWithRequest()]);
			const r = run();
			expect(r.stderr).toBe("");
			expect(r.status).toBe(0);
			expect(readCreated().map((c) => c.title)).toEqual([
				TODAY,
				"Reverse a delegated decision on #2: Inside the window",
			]);
			expect(readReplies()).toHaveLength(1);
		});

		it("exits non-zero when the answering fails after a filing", () => {
			seed([reviewWithRequest()]);
			fs.writeFileSync(stub("fail-comment"), "");
			const r = run();
			expect(r.status).toBe(1);
			expect(r.stderr).toContain("the reply failed (HTTP 502)");
			expect(readCreated().map((c) => c.title)).toContain(TODAY);
		});

		it("answers reversals and exits non-zero when the filing fails", () => {
			seed([reviewWithRequest()]);
			fs.writeFileSync(stub("fail-review-create"), "");
			const r = run();
			expect(r.status).toBe(1);
			expect(r.stderr).toContain("HTTP 502");
			expect(readCreated().map((c) => c.title)).toEqual([
				"Reverse a delegated decision on #2: Inside the window",
			]);
			expect(readReplies()).toHaveLength(1);
		});

		it("files and answers nothing on --dry-run", () => {
			seed([reviewWithRequest()]);
			const r = run(["--dry-run"]);
			expect(r.status).toBe(0);
			expect(r.stdout).toContain("would file in acme/wfc: Reverse");
			expect(readCreated()).toHaveLength(0);
			expect(readReplies()).toHaveLength(0);
		});
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
