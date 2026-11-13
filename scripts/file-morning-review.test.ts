// @vitest-environment node
/*
 * file-morning-review.js, driven through its command line against a stub gh
 * (#2011): its boundary set (§X11, #5148). Each case crosses the production
 * adapters the shell wires: gh at WFC_GH, the real file-issue.js through
 * lib/file-through.js, so its label refusals and similar-title check run on
 * the review issue as on any other, and the three checkers spawned. The
 * core's branches are lib/morning-review-filing.test.ts's. Break it and the
 * loop files no review, or two in a day, or a hand run leaves the founder's
 * `reverse <n>` comments unanswered (#3388).
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { freshSandbox } from "./lib/arbiter-testkit";
import { morningReviewFixture } from "./lib/morning-review-fixture";
import { WSL_KERNEL, writeOsrelease, writeWsl } from "./lib/wsl-fake";

const SCRIPT = path.resolve(__dirname, "file-morning-review.js");

const sb = freshSandbox();

const { ago, readCreated, refillFile, run, runEnv, seed, stub, wfc } =
	morningReviewFixture(sb, SCRIPT);

const lockFile = () => refillFile(".morning-review-filing.pid");
/* A guess: two full filings on a loaded machine, each some 10 s of real node
 * and stub gh starts. */
const TWO_FILINGS_TIMEOUT_MS = 120_000;

const localDate = (d: Date) =>
	[d.getFullYear(), d.getMonth() + 1, d.getDate()]
		.map((v) => String(v).padStart(2, "0"))
		.join("-");
const TODAY = `Morning review — ${localDate(new Date())}`;

describe("file-morning-review.js (#2011)", () => {
	it("files today's review once, through file-issue.js, windowed from the previous review issue", async () => {
		seed([
			{
				number: 5,
				title: "Morning review — 2000-01-01",
				state: "OPEN",
				createdAt: ago(24),
				body: "",
			},
		]);
		fs.writeFileSync(stub("lookalike"), "");
		const first = await run();
		expect(first.stderr).toBe("");
		expect(first.status).toBe(0);
		expect(first.stdout).toMatch(/#1995 \([\d.]+\) Away mode/);
		const [issue, ...more] = readCreated();
		expect(more).toHaveLength(0);
		expect(issue.title).toBe(TODAY);
		expect(issue.labels).toEqual([
			"takes:wayfinder",
			"origin:morning-review-script",
		]);
		expect(issue.body).toMatch(/^## Question\n/);
		expect(issue.body).toContain("from #5, the previous review issue");
		expect(issue.body).toContain("1. acme/wfc#2 — `Inside the window`");
		expect(issue.body).not.toContain("Before the window");
		expect(issue.body).toContain(
			"- acme/wfc#77 — `Drop the old ledger` — `deleted data; cannot`",
		);
		expect(
			issue.body.split("Standalone: the day's away-mode review"),
		).toHaveLength(2);
		expect(issue.body).toMatch(/-->\n$/);
		expect(issue.body).toMatch(
			/## Memory kills\n\n1 in the window — Claude host 1\.\n\n- `Memory kill incident from [^`]+` — 1 kill: Claude host 1 — #61\n/,
		);
		expect(issue.body).toContain("- acme/wfc: `1 torn ledger line(s) skipped`");
		/* The fixture's .git is no repository: the history fails open to a why. */
		expect(issue.body).toMatch(
			/### acme\/wfc\n\n.+\n\nRow changes not read: `git: /,
		);

		const second = await run();
		expect(second.status).toBe(0);
		expect(second.stdout).toContain("is today's review issue already");
		expect(readCreated()).toHaveLength(1);
	});

	it("names the open earlier reviews distinct up front, so file-issue.js files on its first run (#4601)", async () => {
		seed([
			{
				number: 5,
				title: "Morning review — 2000-01-01",
				state: "OPEN",
				createdAt: ago(24),
				body: "",
			},
		]);
		fs.writeFileSync(stub("calls.log"), "");
		const r = await run();
		expect(r.status).toBe(0);
		expect(r.stdout).toMatch(/#5 \([\d.]+\) Morning review — 2000-01-01/);
		/* file-issue.js reads the tracker's labels once a run: a refused first run reads them twice. */
		const labelReads = fs
			.readFileSync(stub("calls.log"), "utf8")
			.split("\n")
			.filter((l) => l.startsWith("api repos/acme/wfc/labels"));
		expect(labelReads).toHaveLength(1);
	});

	it("files the idle alarm's section, read with the loop stopped (#3644)", async () => {
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
		expect((await run()).status).toBe(0);
		const [issue] = readCreated();
		expect(issue.body).toContain(
			[
				"## Idle efforts",
				"",
				"Each tracker's open efforts nothing has launched lately, the oldest, and why the refill loop skips it:",
				"",
				"- `The refill loop is not running, so it serves no tracker. node scripts/refill-loop.js start restarts it.`",
				"- `acme/wfc: 1 idle past 2 days (the refill loop does not serve it); oldest #12 (Stranded effort), idle 5.0 days; skip reason: none, the launch filter passes it`",
				"",
			].join("\n"),
		);
	});

	it("files the WSL currency section, a failed read named rather than dropped (#4082)", async () => {
		seed([]);
		const wsl = path.join(sb.dir, "wsl");
		expect(
			(
				await run([], {
					WFC_PROC: writeOsrelease(wsl, WSL_KERNEL),
					WFC_WSL_EXE: writeWsl(wsl, { version: "2.7.11.0" }),
				})
			).status,
		).toBe(0);
		const { body } = readCreated()[0];
		expect(body).toContain("## WSL currency");
		expect(body).toContain("WSL currency not read");
		expect(body).toContain("the latest release: ");
	});

	describe("two filings at once (#3813)", () => {
		const reviewCreates = () =>
			fs
				.readFileSync(stub("calls.log"), "utf8")
				.split("\n")
				.filter(
					(l) => l.startsWith("issue create") && l.includes("Morning review"),
				);

		it(
			"leaves one issue for the day when both really run",
			async () => {
				seed([]);
				const filing = () =>
					new Promise<{ status: number | null; stderr: string }>(
						(resolve, reject) => {
							// spawn-kept: two processes at once — the race under test is between real pids, which runInProcess's one-at-a-time call cannot make
							const child = spawn(process.execPath, [SCRIPT], {
								cwd: wfc(),
								env: { ...runEnv(), CLAUDE_PROJECT_DIR: wfc() },
								stdio: ["ignore", "ignore", "pipe"],
							});
							let stderr = "";
							child.stderr.on("data", (d) => {
								stderr += d;
							});
							child.on("error", reject);
							child.on("close", (status) => resolve({ status, stderr }));
						},
					);
				const runs = await Promise.all([filing(), filing()]);
				expect(reviewCreates()).toHaveLength(1);
				expect(fs.existsSync(lockFile())).toBe(false);
				expect(runs.some((r) => r.status === 0)).toBe(true);
				for (const r of runs.filter((f) => f.status !== 0)) {
					expect(r.status).toBe(1);
					expect(r.stderr).toContain("another run is filing today's review");
				}
			},
			TWO_FILINGS_TIMEOUT_MS,
		);

		it("files nothing and exits 1 while another filing holds the lock, so the loop's next tick retries", async () => {
			seed([]);
			fs.mkdirSync(path.dirname(lockFile()), { recursive: true });
			// spawn-kept: two processes at once — the lock's holder is a real live pid, read by its command line, beside the call under test
			const holder = spawn(
				process.execPath,
				["-e", "setInterval(() => {}, 1000)", path.basename(SCRIPT)],
				{ stdio: "ignore" },
			);
			try {
				fs.writeFileSync(lockFile(), String(holder.pid));
				const r = await run();
				expect(r.status).toBe(1);
				expect(r.stderr).toContain(
					`another run is filing today's review (pid ${holder.pid}). Nothing filed: re-run once it ends.`,
				);
				expect(readCreated()).toHaveLength(0);

				const dry = await run(["--dry-run"]);
				expect(dry.status).toBe(0);
				expect(dry.stdout).toContain(`${TODAY}\n\n## Question`);
			} finally {
				holder.kill();
			}
		});
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

		it("files today's review and a takes:implement ticket for each unanswered reverse <n>", async () => {
			seed([reviewWithRequest()]);
			const r = await run();
			expect(r.stderr).toBe("");
			expect(r.status).toBe(0);
			expect(readCreated().map((c) => c.title)).toEqual([
				TODAY,
				"Reverse a delegated decision on #2: Inside the window",
			]);
			expect(readReplies()).toHaveLength(1);
		});

		it("exits non-zero when the answering fails after a filing", async () => {
			seed([reviewWithRequest()]);
			fs.writeFileSync(stub("fail-comment"), "");
			const r = await run();
			expect(r.status).toBe(1);
			expect(r.stderr).toContain(
				"the reply failed (GraphQL: Could not resolve",
			);
			expect(readCreated().map((c) => c.title)).toContain(TODAY);
		});

		it("answers reversals and exits non-zero when the filing fails", async () => {
			seed([reviewWithRequest()]);
			fs.writeFileSync(stub("fail-review-create"), "");
			const r = await run();
			expect(r.status).toBe(1);
			expect(r.stderr).toContain("GraphQL: Could not resolve");
			expect(readCreated().map((c) => c.title)).toEqual([
				"Reverse a delegated decision on #2: Inside the window",
			]);
			expect(readReplies()).toHaveLength(1);
		});

		it("files and answers nothing on --dry-run", async () => {
			seed([reviewWithRequest()]);
			const r = await run(["--dry-run"]);
			expect(r.status).toBe(0);
			expect(r.stdout).toContain("would file in acme/wfc: Reverse");
			expect(readCreated()).toHaveLength(0);
			expect(readReplies()).toHaveLength(0);
		});
	});

	it("prints the body and files nothing on --dry-run, counting the real core's primitives", async () => {
		seed([]);
		const r = await run(["--dry-run"], { WFC_SCRIPT_ROOT: "" });
		expect(r.status).toBe(0);
		expect(r.stdout).toMatch(
			/`primitives: [1-9]\d* enforced, \d+ open breaches/,
		);
		expect(r.stdout).toContain(`${TODAY}\n\n## Question`);
		expect(r.stdout).toContain("no previous review issue");
		expect(readCreated()).toHaveLength(0);
	});
});
