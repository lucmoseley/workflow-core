// @vitest-environment node
/*
 * file-morning-review.js, driven through its command line against a stub gh
 * (#2011). Filing goes through the real file-issue.js, so its label refusals
 * and similar-title check run on the review issue as on any other. Break it
 * and the loop files no review, or two in a day, or a hand run leaves the
 * founder's `reverse <n>` comments unanswered (#3388), or a close made during
 * a filing reaches no review (#3813).
 */

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { freshSandbox } from "./lib/arbiter-testkit";
import { HOUR, morningReviewFixture } from "./lib/morning-review-fixture";
import { raiseHold } from "./lib/repo-holds.js";
import { WSL_KERNEL, writeOsrelease, writeWsl } from "./lib/wsl-fake";

const SCRIPT = path.resolve(__dirname, "file-morning-review.js");

const sb = freshSandbox();

const { ago, readCreated, refillFile, run, runEnv, seed, stub, wfc } =
	morningReviewFixture(sb, SCRIPT);

const readsFile = () => refillFile(".morning-review-reads.json");
const lockFile = () => refillFile(".morning-review-filing.pid");
/* A guess: two full filings on a loaded machine, each some 10 s of real node
 * and stub gh starts. */
const TWO_FILINGS_TIMEOUT_MS = 120_000;

/** One filing, with the machine's clock at `at`. */
const reviewAt = (at: string) => {
	vi.useFakeTimers({ toFake: ["Date"], now: new Date(at) });
	const r = run();
	vi.useRealTimers();
	expect(r.status).toBe(0);
};

/** Appends a still-caught decision to a checkout's ledger, stamped `at`. */
const appendDecision = (
	root: string,
	at: string,
	issue: number,
	question: string,
) => {
	const repo = `acme/${path.basename(root)}`;
	fs.appendFileSync(
		path.join(root, ".claude", "tmp", "markers", "delegated-decisions.jsonl"),
		`${JSON.stringify({
			at,
			repo,
			issue,
			comment: `https://github.com/${repo}/issues/${issue}#issuecomment-1`,
			question,
			taken: { option: "(A) keep", figure: 52 },
			runnerUp: { option: "(B) drop", figure: 48 },
			rungs: { rulings: "none", web: "none", subagent: "none" },
			stillClose: true,
			reverse: "drop it",
		})}\n`,
	);
};

const localDate = (d: Date) =>
	[d.getFullYear(), d.getMonth() + 1, d.getDate()]
		.map((v) => String(v).padStart(2, "0"))
		.join("-");
const TODAY = `Morning review — ${localDate(new Date())}`;

/** The fixture checkout as a real git repository with a standards file to commit. */
function tableRepo() {
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
	return { git, table, commit };
}

describe("file-morning-review.js (#2011)", () => {
	it("files today's review once, through file-issue.js, windowed from the previous review issue", () => {
		seed([
			{
				number: 5,
				title: "Morning review — 2000-01-01",
				state: "OPEN",
				createdAt: ago(24),
				body: "",
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
		expect(
			issue.body.split("Standalone: the day's away-mode review"),
		).toHaveLength(2);
		expect(issue.body).toMatch(/-->\n$/);
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
				"- `The refill loop is not running, so it serves no tracker. node scripts/refill-loop.js start restarts it.`",
				"- `acme/wfc: 1 idle past 2 days (the refill loop does not serve it); oldest #12 (Stranded effort), idle 5.0 days; skip reason: none, the launch filter passes it`",
				"",
			].join("\n"),
		);
	});

	it("has no WSL currency section where the checker SKIPs: not WSL (#4082)", () => {
		seed([]);
		expect(run().status).toBe(0);
		expect(readCreated()[0].body).not.toContain("## WSL currency");
	});

	it("files the WSL currency section, a failed read named rather than dropped (#4082)", () => {
		seed([]);
		const wsl = path.join(sb.dir, "wsl");
		expect(
			run([], {
				WFC_PROC: writeOsrelease(wsl, WSL_KERNEL),
				WFC_WSL_EXE: writeWsl(wsl, { version: "2.7.11.0" }),
			}).status,
		).toBe(0);
		const { body } = readCreated()[0];
		expect(body).toContain("## WSL currency");
		expect(body).toContain("WSL currency not read");
		expect(body).toContain("the latest release: ");
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
		const { table, commit } = tableRepo();
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

	it("lists an issue urgent 8 days under Stuck urgent with pick-next's reason, one with no labeled event at its creation's age, marked at most, not one urgent 6 days nor one whose timeline will not read, and writes no label (#2693, #3760)", () => {
		seed([]);
		const labelled = (hours: number) => [
			{ event: "labeled", label: { name: "urgent" }, created_at: ago(hours) },
		];
		fs.writeFileSync(
			stub("urgent.json"),
			JSON.stringify([
				{ number: 50, title: "Stuck for a week", createdAt: ago(9 * 24) },
				{ number: 51, title: "Fresh enough", createdAt: ago(9 * 24) },
				{
					number: 52,
					title: "Labelled off the timeline",
					createdAt: ago(50 * 24),
				},
				{
					number: 53,
					title: "Timeline will not read",
					createdAt: ago(50 * 24),
				},
			]),
		);
		fs.writeFileSync(
			stub("timelines.json"),
			JSON.stringify({
				50: labelled(8 * 24),
				51: labelled(6 * 24),
				52: [
					{
						event: "labeled",
						label: { name: "wayfinder:map" },
						created_at: ago(50 * 24),
					},
				],
				53: "fail",
			}),
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
			"- acme/wfc#50 — `Stuck for a week` — 8 days — `parked — an away-mode refill loop skips it; a normal-mode one resumes it ahead of new work, oldest park first (pick-next, 2026-10-24T06:00:00Z)`",
		);
		expect(section).not.toContain("#51");
		expect(section).toContain(
			"- acme/wfc#52 — `Labelled off the timeline` — at most 50 days — pick-next does not say why\n",
		);
		expect(section).not.toContain("#53");
		expect(r.stdout).toMatch(
			/\*\*Not read, so missing below:\*\*\n(- .*\n)*- acme\/wfc: `#53's urgent age: /,
		);
		const calls = fs.readFileSync(stub("calls.log"), "utf8");
		expect(calls).not.toMatch(/issue edit|--(add|remove)-label|labels\/urgent/);
	});

	it("lists every open parked issue with its age, one whose label start will not read as age unknown, one labelled after the window's end as under a day, and writes no label (#2725, #3802)", () => {
		seed([]);
		fs.writeFileSync(
			stub("parked.json"),
			JSON.stringify([
				{ number: 60, title: "Waits on a round" },
				{ number: 61, title: "Labelled off the timeline" },
				{ number: 62, title: "Parked during the filing" },
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
				/* After the window's end, as a label applied mid-filing reads. */
				62: [
					{ event: "labeled", label: { name: "parked" }, created_at: ago(-1) },
				],
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
		expect(section).toContain(
			"- acme/wfc#62 — `Parked during the filing` — under a day\n",
		);
		const calls = fs.readFileSync(stub("calls.log"), "utf8");
		expect(calls).not.toMatch(/issue edit|--(add|remove)-label|labels\/parked/);
	});

	it("resumes a failed run from the day's kept reads, re-reading only what failed (#3765)", () => {
		seed([]);
		fs.writeFileSync(stub("fail-review-create"), "");
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
		const readTimelineReads = () =>
			fs
				.readFileSync(stub("calls.log"), "utf8")
				.split("\n")
				.filter((l) => l.includes("/timeline"))
				.map((l) => l.match(/issues\/(\d+)\/timeline/)?.[1]);
		expect(run().status).toBe(1);
		expect(readTimelineReads()).toEqual(["60", "61"]);
		fs.rmSync(stub("fail-review-create"));
		fs.writeFileSync(stub("calls.log"), "");
		/* The timeline gone: a kept age is the only way #60's still reads. */
		fs.writeFileSync(stub("timelines.json"), JSON.stringify({ 61: [] }));
		expect(run().status).toBe(0);
		expect(readTimelineReads()).toEqual(["61"]);
		expect(readCreated()[0].body).toContain(
			"- acme/wfc#60 — `Waits on a round` — 3 days\n",
		);
	});

	it("leaves the kept reads as it found them on --dry-run, and takes none of them (#3813)", () => {
		seed([]);
		expect(run(["--dry-run"]).status).toBe(0);
		expect(fs.existsSync(readsFile())).toBe(false);

		fs.writeFileSync(stub("fail-review-create"), "");
		expect(run().status).toBe(1);
		const kept = JSON.parse(fs.readFileSync(readsFile(), "utf8"));
		for (const key of Object.keys(kept.reads))
			kept.reads[key] = { line: "a stale count line" };
		const found = JSON.stringify(kept);
		fs.writeFileSync(readsFile(), found);

		const dry = run(["--dry-run"]);
		expect(dry.status).toBe(0);
		expect(dry.stdout).not.toContain("a stale count line");
		expect(fs.readFileSync(readsFile(), "utf8")).toBe(found);
	});

	describe("an event readable only after a window's reads (#3827)", () => {
		afterEach(() => vi.useRealTimers());
		const row = (primitive: string) =>
			`| ${primitive} | \`${primitive}\` | \`a.js\` | §0 | Standards axis criterion |`;

		it("puts a commit stamped before a window's end that reaches HEAD after it in the next review only", () => {
			seed([]);
			const { table, commit } = tableRepo();
			commit(table(row("Old")), "2026-10-10T01:00:00Z");
			reviewAt("2026-10-10T07:00:00.000Z");
			const sha = commit(
				table(row("Old"), row("Late")),
				"2026-10-10T06:59:00Z",
			);
			reviewAt("2026-10-11T07:00:00.000Z");
			reviewAt("2026-10-12T07:00:00.000Z");

			const created = readCreated();
			expect(created).toHaveLength(3);
			expect(created[0].body).not.toContain("Late");
			expect(created[1].body).toContain(
				`local row added: \`'Late'\` — job \`Late\` — ${sha}`,
			);
			expect(created[2].body).not.toContain("Late");
		});

		it("reads the default branch's table commits once, whichever branch the checkout is on", () => {
			seed([]);
			const { git, table, commit } = tableRepo();
			git(["checkout", "-q", "-b", "main"]);
			git([
				"symbolic-ref",
				"refs/remotes/origin/HEAD",
				"refs/remotes/origin/main",
			]);
			commit(table(row("Old")), "2026-10-10T01:00:00Z");
			reviewAt("2026-10-10T07:00:00.000Z");
			const landed = commit(
				table(row("Old"), row("Landed")),
				"2026-10-10T08:00:00Z",
			);
			git(["checkout", "-q", "-b", "side", "HEAD~1"]);
			commit(table(row("Old"), row("Unmerged")), "2026-10-10T09:00:00Z");
			reviewAt("2026-10-11T07:00:00.000Z");
			git(["checkout", "-q", "main"]);
			reviewAt("2026-10-12T07:00:00.000Z");

			const [, onSide, back] = readCreated();
			expect(onSide.body).toContain(`job \`Landed\` — ${landed}`);
			expect(onSide.body).not.toContain("Unmerged");
			expect(back.body).not.toContain("Landed");
			expect(back.body).not.toContain("Found by commit time");
		});

		it("falls back on commit time, saying so, where the last review's commit left HEAD", () => {
			seed([]);
			const { git, table, commit } = tableRepo();
			commit(table(row("Old")), "2026-10-10T01:00:00Z");
			reviewAt("2026-10-10T07:00:00.000Z");
			git(["commit", "-q", "--amend", "-m", "rewritten"]);
			reviewAt("2026-10-11T07:00:00.000Z");
			expect(readCreated()[1].body).toMatch(
				/Found by commit time, as [0-9a-f]{40}, where the last review read to, is not on the branch read: /,
			);
		});

		it("puts a close stamped just before a window's end in the next review only, where the search index missed it", () => {
			seed([]);
			const late = {
				number: 79,
				title: "Closed as the review read",
				url: "https://github.com/acme/wfc/issues/79",
				closedAt: "2026-10-10T06:59:00.000Z",
				comments: [{ body: "**Door:** one-way — late" }],
			};
			fs.writeFileSync(stub("closed.json"), JSON.stringify([]));
			reviewAt("2026-10-10T07:00:00.000Z");
			fs.writeFileSync(stub("closed.json"), JSON.stringify([late]));
			reviewAt("2026-10-11T07:00:00.000Z");
			reviewAt("2026-10-12T07:00:00.000Z");

			const created = readCreated();
			expect(created[0].body).not.toContain("acme/wfc#79");
			expect(created[1].body).toContain("acme/wfc#79");
			expect(created[2].body).not.toContain("acme/wfc#79");
		});

		it("puts a ledger line appended after a window's end, for an older comment, in the next review only", () => {
			seed([]);
			reviewAt("2026-10-10T07:00:00.000Z");
			/* The stamp record-delegated-decision.js gives a re-run: its append's. */
			appendDecision(wfc(), "2026-10-10T08:00:00.000Z", 3, "Re-run decision");
			reviewAt("2026-10-11T07:00:00.000Z");
			reviewAt("2026-10-12T07:00:00.000Z");

			const created = readCreated();
			expect(created[1].body).toContain("Re-run decision");
			expect(created[2].body).not.toContain("Re-run decision");
		});
	});

	describe("open repo holds (#3865)", () => {
		afterEach(() => vi.unstubAllEnvs());

		const Heading = "## Open repo holds";
		const readFiledBody = () => {
			const filed = run();
			expect(filed.status).toBe(0);
			const [issue] = readCreated();
			expect(issue.title).toBe(TODAY);
			return issue.body as string;
		};
		const raiseIn = (
			root: string,
			hold: Partial<Parameters<typeof raiseHold>[1]> = {},
		) => {
			vi.stubEnv("WFC_REFILL_DIR", runEnv().WFC_REFILL_DIR);
			return raiseHold(root, {
				kind: "park",
				act: "repair main",
				issue: 12,
				clearCheck: { issueClosed: 12 },
				session: "raiser",
				now: Date.now() - 3 * HOUR,
				...hold,
			});
		};
		const addCheckout = (name: string, tracker: string) => {
			const root = path.join(path.dirname(wfc()), name);
			fs.mkdirSync(path.join(root, ".git"), { recursive: true });
			fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
			fs.writeFileSync(
				path.join(root, ".claude", "workflow-core.json"),
				JSON.stringify({ contract: 1, founder: "T", tracker }),
			);
			return root;
		};

		it("lists each hold's act, issue, kind, age, attached count and notice state, for every served checkout", () => {
			seed([]);
			raiseIn(wfc());
			raiseIn(addCheckout("second", "acme/other"), {
				kind: "probe",
				act: "repair the shared .git: fetch origin: no route",
				issue: 13,
				clearCheck: { issueClosed: 13 },
				now: Date.now() - 25 * HOUR,
			});

			const body = readFiledBody();

			expect(body).toContain(Heading);
			expect(body).toContain(
				"- wfc: `repair main` — acme/wfc#12 — park — age 3h 0m — 1 attached — notice: raise not sent, clear not sent",
			);
			expect(body).toContain(
				"- second: `repair the shared .git: fetch origin: no route` — acme/other#13 — probe, which stops launches — age 25h 0m — 1 attached — notice: raise not sent, clear not sent",
			);
		});

		it("still lists a hold where the checkout's tracker reads fail, as the store is local", () => {
			seed([]);
			raiseIn(wfc());
			fs.rmSync(stub("closed.json"));

			expect(readFiledBody()).toContain("- wfc: `repair main` — acme/wfc#12");
		});

		it("lists a hold under a bare issue number where the checkout's tracker will not resolve", () => {
			seed([]);
			const root = addCheckout("second", "acme/other");
			fs.writeFileSync(
				path.join(root, ".claude", "workflow-core.json"),
				JSON.stringify({ contract: 1, founder: "T" }),
			);
			raiseIn(root);

			expect(readFiledBody()).toContain("- second: `repair main` — #12 — park");
		});

		it("lists a hold in a checkout a loop serves by name outside discovery", () => {
			seed([]);
			const outside = path.join(sb.dir, "elsewhere", "third");
			fs.mkdirSync(path.join(outside, ".git"), { recursive: true });
			fs.mkdirSync(path.join(outside, ".claude"), { recursive: true });
			fs.writeFileSync(
				path.join(outside, ".claude", "workflow-core.json"),
				JSON.stringify({ contract: 1, founder: "T", tracker: "acme/other" }),
			);
			raiseIn(outside);
			fs.mkdirSync(path.dirname(refillFile("x")), { recursive: true });
			fs.writeFileSync(
				refillFile(".refill-loop-control.json"),
				JSON.stringify({
					noProgressFrom: Date.now(),
					scope: { mode: "normal", repos: [outside] },
				}),
			);

			expect(readFiledBody()).toContain(
				"- third: `repair main` — acme/other#12",
			);
		});

		it("files the review and says so where the hold store will not read", () => {
			seed([]);
			fs.mkdirSync(path.dirname(refillFile("repo-holds")), { recursive: true });
			fs.writeFileSync(refillFile("repo-holds"), "a file, not a directory\n");

			const body = readFiledBody();

			expect(body).toContain("**Not read, so missing below:**");
			expect(body).toMatch(
				/- acme\/wfc: `repo holds: .*not a directory.*repair the directory/i,
			);
			expect(body).not.toContain(Heading);
		});

		it("lists the holds that read beside a record that will not", () => {
			seed([]);
			raiseIn(wfc());
			const [store = ""] = fs.readdirSync(refillFile("repo-holds"));
			fs.writeFileSync(
				path.join(refillFile("repo-holds"), store, "torn.json"),
				"{",
			);

			const body = readFiledBody();

			expect(body).toContain("- wfc: `repair main`");
			expect(body).toMatch(
				/- acme\/wfc: `repo holds: .*torn\.json.*remove the file/,
			);
		});
	});

	describe("a repo that does not read (#3831)", () => {
		afterEach(() => vi.useRealTimers());

		const second = () => path.join(path.dirname(wfc()), "second");
		/** No tracker makes the checkout's read fail, with its config in place. */
		const writeSecondConfig = (text: string) =>
			fs.writeFileSync(
				path.join(second(), ".claude", "workflow-core.json"),
				text,
			);
		const configureSecond = (config: object) =>
			writeSecondConfig(
				JSON.stringify({ contract: 1, founder: "T", ...config }),
			);
		const close = (number: number, closedAt: string) => ({
			number,
			title: `Close ${number}`,
			url: `https://github.com/acme/wfc/issues/${number}`,
			closedAt,
			comments: [{ body: `**Door:** one-way — close ${number}` }],
		});
		const once = (body: string, text: string) =>
			expect(body.split(text)).toHaveLength(2);
		const hidden = (body: string) => body.slice(body.indexOf("<!--"));
		const bodies = () => readCreated().map((c: { body: string }) => c.body);
		const previousReview = (body = "") => ({
			number: 800,
			title: "Morning review — 2026-10-10",
			state: "CLOSED",
			createdAt: "2026-10-10T07:00:00.000Z",
			body: `Window: 2026-10-09T07:00:00.000Z → 2026-10-10T07:00:00.000Z, from #1\n${body}`,
			labels: [],
		});
		const makeSecond = () => {
			fs.mkdirSync(path.join(second(), ".git"), { recursive: true });
			fs.mkdirSync(path.join(second(), ".claude", "tmp", "markers"), {
				recursive: true,
			});
		};
		const stubCloses = (...issues: object[]) =>
			fs.writeFileSync(stub("closed.json"), JSON.stringify(issues));
		const dotGit = () => path.join(second(), ".git");
		const configPath = () =>
			path.join(second(), ".claude", "workflow-core.json");
		const makeLinkedWorktree = () => {
			fs.rmSync(dotGit(), { recursive: true });
			fs.writeFileSync(dotGit(), "gitdir: elsewhere\n");
		};
		const Absences = [
			{
				absence: "its .git missing",
				why: "no .git",
				remove: () => fs.rmSync(dotGit(), { recursive: true }),
				restore: () => fs.mkdirSync(dotGit()),
			},
			{
				absence: "its config deleted",
				why: "no workflow-core config",
				remove: () => fs.rmSync(configPath()),
				restore: () => configureSecond({ tracker: "acme/second" }),
			},
		];

		it("lists its closes and decisions in the first review to read it, and a repo that read throughout lists each event once", () => {
			seed([previousReview()]);
			makeSecond();
			configureSecond({});
			const c80 = close(80, "2026-10-10T12:00:00.000Z");
			const c81 = close(81, "2026-10-11T12:00:00.000Z");
			const c82 = close(82, "2026-10-12T12:00:00.000Z");

			appendDecision(second(), "2026-10-10T12:00:00.000Z", 3, "Second: failed");
			appendDecision(wfc(), "2026-10-10T12:00:00.000Z", 3, "Wfc: read");
			stubCloses(c80);
			reviewAt("2026-10-11T07:00:00.000Z");

			appendDecision(
				second(),
				"2026-10-11T12:00:00.000Z",
				4,
				"Second: failed again",
			);
			stubCloses(c80, c81);
			reviewAt("2026-10-12T07:00:00.000Z");

			appendDecision(second(), "2026-10-12T12:00:00.000Z", 5, "Second: read");
			stubCloses(c80, c81, c82);
			configureSecond({ tracker: "acme/second" });
			reviewAt("2026-10-13T07:00:00.000Z");
			reviewAt("2026-10-14T07:00:00.000Z");

			const [failed, failedAgain, recovered, after] = bodies();
			for (const body of [failed, failedAgain]) {
				expect(body).toContain(
					"Events unread since 2026-10-10T07:00:00.000Z in second.",
				);
				expect(body).not.toContain("acme/second#8");
				expect(body).not.toContain("Second:");
			}
			once(failed, "acme/wfc#80");
			once(failed, "Wfc: read");

			for (const event of [
				"Second: failed`",
				"Second: failed again",
				"Second: read",
				"acme/second#80",
				"acme/second#81",
				"acme/second#82",
				"acme/wfc#82",
			])
				once(recovered, event);
			expect(recovered).not.toContain("acme/wfc#80");
			expect(recovered).not.toContain("Wfc: read");
			expect(recovered).not.toContain("Events unread since");
			expect(recovered).toContain(
				"- acme/second: 3 from 2026-10-10T06:45:00.000Z, as the reviews since did not read it",
			);
			const searches = fs.readFileSync(stub("calls.log"), "utf8");
			expect(searches).toContain(
				"--repo acme/second --state closed --search closed:>=2026-10-10T06:45:00+00:00",
			);
			expect(searches).toContain(
				"--repo acme/wfc --state closed --search closed:>=2026-10-12T06:45:00+00:00",
			);

			for (const event of ["acme/second#8", "acme/wfc#8", "Second:"])
				expect(after).not.toContain(event);
		});

		describe("a part of a checkout that does not read (#3928)", () => {
			const dayOne = "2026-10-10T07:00:00.000Z";
			const dayTwo = "2026-10-11T07:00:00.000Z";
			const dayThree = "2026-10-12T07:00:00.000Z";
			const closesCalls = () =>
				fs
					.readFileSync(stub("calls.log"), "utf8")
					.split("\n")
					.filter(
						(l) => l.includes("--search closed:") && !l.includes("--label"),
					);
			const ledger = () =>
				path.join(
					wfc(),
					".claude",
					"tmp",
					"markers",
					"delegated-decisions.jsonl",
				);

			it("retries a closes read that fails once, listing its closes with nothing unread", () => {
				seed([previousReview()]);
				stubCloses(close(80, "2026-10-10T12:00:00.000Z"));
				fs.writeFileSync(stub("fail-closes-once"), "");
				reviewAt(dayTwo);
				const [body] = bodies();
				once(body, "acme/wfc#80");
				expect(body).toContain("- acme/wfc: 1");
				expect(body).not.toContain("`closes: ");
				expect(body).not.toContain("unread since");
				expect(closesCalls()).toHaveLength(2);
			});

			it("lists the decisions where closes fail every try, carries the closes alone, and repeats no decision", () => {
				seed([previousReview()]);
				appendDecision(wfc(), "2026-10-10T12:00:00.000Z", 3, "Wfc: day one");
				stubCloses(close(80, "2026-10-10T12:00:00.000Z"));
				fs.writeFileSync(stub("fail-closes"), "");
				reviewAt(dayTwo);

				appendDecision(wfc(), "2026-10-11T12:00:00.000Z", 4, "Wfc: day two");
				stubCloses(
					close(80, "2026-10-10T12:00:00.000Z"),
					close(81, "2026-10-11T12:00:00.000Z"),
				);
				fs.rmSync(stub("fail-closes"));
				reviewAt(dayThree);

				const [failed, recovered] = bodies();
				once(failed, "Wfc: day one");
				expect(failed).toMatch(/- acme\/wfc: `closes: /);
				expect(failed).toContain(`Closes unread since ${dayOne} in wfc.`);
				expect(failed).not.toContain("Events unread since");
				expect(failed).not.toContain("Decisions unread since");
				expect(failed).toContain("- acme/wfc: not read");
				expect(failed).not.toContain("acme/wfc#80");
				expect(hidden(failed)).toContain("Events read in wfc.");
				expect(closesCalls()).toHaveLength(3);

				once(recovered, "acme/wfc#80");
				once(recovered, "acme/wfc#81");
				once(recovered, "Wfc: day two");
				expect(recovered).not.toContain("Wfc: day one");
				expect(recovered).not.toContain("unread since");
				expect(closesCalls().at(-1)).toContain(
					"closed:>=2026-10-10T06:45:00+00:00",
				);
			});

			it("lists the closes where the ledger will not read, names and carries the decisions, and repeats no close", () => {
				seed([previousReview()]);
				appendDecision(wfc(), "2026-10-10T12:00:00.000Z", 3, "Wfc: carried");
				const text = fs.readFileSync(ledger(), "utf8");
				fs.rmSync(ledger());
				fs.mkdirSync(ledger());
				stubCloses(close(80, "2026-10-10T12:00:00.000Z"));
				reviewAt(dayTwo);

				fs.rmdirSync(ledger());
				fs.writeFileSync(ledger(), text);
				reviewAt(dayThree);

				const [failed, recovered] = bodies();
				once(failed, "acme/wfc#80");
				expect(failed).toMatch(/- acme\/wfc: `ledger: /);
				expect(failed).toContain(`Decisions unread since ${dayOne} in wfc.`);
				expect(failed).not.toContain("Closes unread since");
				expect(failed).not.toContain("Wfc: carried");
				expect(failed).toContain("- acme/wfc: not read, so the next review");

				once(recovered, "Wfc: carried");
				expect(recovered).not.toContain("acme/wfc#80");
				expect(recovered).not.toContain("unread since");
			});

			it("keeps each kind's own start where a whole read fails after a part did", () => {
				const closesStart = "2026-10-09T07:00:00.000Z";
				seed([
					previousReview(`Closes unread since ${closesStart} in second.\n`),
				]);
				makeSecond();
				configureSecond({});
				reviewAt(dayTwo);

				const [whole] = bodies();
				expect(whole).toContain(
					`Closes unread since ${closesStart} in second.`,
				);
				expect(whole).toContain(`Decisions unread since ${dayOne} in second.`);
				expect(whole).not.toContain("Events unread since");
			});
		});

		describe("a checkout discovery leaves out (#3834)", () => {
			it("names one whose config will not parse, on one line, keeps a failed read's start, and lands every event in the first review to read it", () => {
				seed([previousReview()]);
				makeSecond();
				const c80 = close(80, "2026-10-10T12:00:00.000Z");
				const c81 = close(81, "2026-10-11T12:00:00.000Z");
				const c82 = close(82, "2026-10-12T12:00:00.000Z");

				configureSecond({});
				appendDecision(
					second(),
					"2026-10-10T12:00:00.000Z",
					3,
					"Second: unread",
				);
				stubCloses(c80);
				reviewAt("2026-10-11T07:00:00.000Z");

				writeSecondConfig('{\n  "tracker": }\n');
				appendDecision(
					second(),
					"2026-10-11T12:00:00.000Z",
					4,
					"Second: broken",
				);
				stubCloses(c80, c81);
				reviewAt("2026-10-12T07:00:00.000Z");

				configureSecond({ tracker: "acme/second" });
				stubCloses(c80, c81, c82);
				reviewAt("2026-10-13T07:00:00.000Z");

				const [, broken, fixed] = bodies();
				expect(broken).toMatch(/^- second: `.*does not parse.*`$/m);
				expect(broken).toContain(
					"Events unread since 2026-10-10T07:00:00.000Z in second.",
				);
				expect(broken).not.toContain("Second:");
				expect(broken).not.toContain("acme/second#8");

				for (const event of [
					"Second: unread",
					"Second: broken",
					"acme/second#80",
					"acme/second#81",
					"acme/second#82",
				])
					once(fixed, event);
				expect(fixed).not.toContain("Events unread since");
			});

			it("starts one whose config never read at the window it first broke in", () => {
				seed([previousReview()]);
				makeSecond();
				writeSecondConfig("{");
				reviewAt("2026-10-11T07:00:00.000Z");
				reviewAt("2026-10-12T07:00:00.000Z");

				for (const { body } of readCreated())
					expect(body).toContain(
						"Events unread since 2026-10-10T07:00:00.000Z in second.",
					);
			});

			it("neither names nor carries one its owner opted out, and drops a start it had carried", () => {
				seed([
					previousReview(
						"Events unread since 2026-10-09T07:00:00.000Z in second.\n",
					),
				]);
				makeSecond();
				appendDecision(
					second(),
					"2026-10-09T12:00:00.000Z",
					3,
					"Second: unread",
				);
				configureSecond({ tracker: "acme/second", refillLoop: false });
				reviewAt("2026-10-11T07:00:00.000Z");

				configureSecond({ tracker: "acme/second" });
				reviewAt("2026-10-12T07:00:00.000Z");

				const [optedOut, back] = bodies();
				expect(optedOut).not.toMatch(/\bsecond\b/);
				expect(back).not.toContain("Second: unread");
				expect(back).not.toContain("Events unread since");
			});
		});

		describe("a carried checkout discovery no longer lists (#3835)", () => {
			const carried = "Events unread since 2026-10-09T07:00:00.000Z in second.";
			const seedCarried = () => {
				seed([previousReview(`${carried}\n`)]);
				makeSecond();
				configureSecond({ tracker: "acme/second" });
			};

			it.each(Absences)(
				"names one with $absence under the same start, and lands its events in the first review to read it",
				({ why, remove, restore }) => {
					seedCarried();
					const c80 = close(80, "2026-10-09T12:00:00.000Z");
					const c81 = close(81, "2026-10-11T12:00:00.000Z");
					appendDecision(
						second(),
						"2026-10-09T12:00:00.000Z",
						3,
						"Second: old",
					);
					appendDecision(
						second(),
						"2026-10-11T12:00:00.000Z",
						4,
						"Second: new",
					);
					stubCloses(c80, c81);

					remove();
					reviewAt("2026-10-11T07:00:00.000Z");
					reviewAt("2026-10-12T07:00:00.000Z");
					restore();
					reviewAt("2026-10-13T07:00:00.000Z");
					reviewAt("2026-10-14T07:00:00.000Z");

					const [absent, absentAgain, read, after] = bodies();
					for (const body of [absent, absentAgain]) {
						expect(body).toContain(`- second: \`${why}\``);
						expect(body).toContain(carried);
						expect(body).not.toContain("Second:");
						expect(body).not.toContain("acme/second#8");
					}
					for (const event of [
						"Second: old",
						"Second: new",
						"acme/second#80",
						"acme/second#81",
					])
						once(read, event);
					expect(read).not.toContain("Events unread since");
					expect(after).not.toContain("Second:");
					expect(after).not.toContain("acme/second#8");
				},
			);

			it("keeps a linked worktree out, unnamed, whether or not a line names it", () => {
				seedCarried();
				makeLinkedWorktree();
				reviewAt("2026-10-11T07:00:00.000Z");
				reviewAt("2026-10-12T07:00:00.000Z");

				for (const body of bodies()) {
					expect(body).not.toMatch(/\bsecond\b/);
					expect(body).not.toContain("Events unread since");
				}
			});

			it("ends the carry of one whose directory is gone: named once, with what it gives up, then never", () => {
				seedCarried();
				fs.rmSync(second(), { recursive: true });
				reviewAt("2026-10-11T07:00:00.000Z");
				reviewAt("2026-10-12T07:00:00.000Z");

				const [ended, later] = bodies();
				expect(ended).toContain(
					"- second: `directory gone, so its events since 2026-10-09T07:00:00.000Z reach no review`",
				);
				expect(ended).not.toContain("Events unread since");
				expect(later).not.toMatch(/\bsecond\b/);
			});
		});

		describe("a checkout's first absence from discovery (#3844)", () => {
			const firstReview = "2026-10-11T07:00:00.000Z";
			const seedSecond = (previous: string) => {
				seed([previousReview(previous)]);
				makeSecond();
				configureSecond({ tracker: "acme/second" });
			};

			it.each(Absences)(
				"names one read last review with $absence, and lands the absent window's events in the first review to read it",
				({ why, remove, restore }) => {
					seedSecond("");
					const c80 = close(80, "2026-10-10T12:00:00.000Z");
					const c81 = close(81, "2026-10-11T12:00:00.000Z");
					appendDecision(
						second(),
						"2026-10-10T12:00:00.000Z",
						3,
						"Second: before",
					);
					appendDecision(
						second(),
						"2026-10-11T12:00:00.000Z",
						4,
						"Second: absent",
					);
					stubCloses(c80, c81);

					reviewAt(firstReview);
					remove();
					reviewAt("2026-10-12T07:00:00.000Z");
					restore();
					reviewAt("2026-10-13T07:00:00.000Z");
					reviewAt("2026-10-14T07:00:00.000Z");

					const [read, absent, back, after] = bodies();
					expect(hidden(read)).toContain("Events read in second.");
					once(read, "Second: before");
					once(read, "acme/second#80");
					expect(absent).toContain(`- second: \`${why}\``);
					expect(absent).toContain(
						`Events unread since ${firstReview} in second.`,
					);
					expect(absent).not.toContain("Events read in second.");
					expect(absent).not.toContain("Second:");
					expect(absent).not.toContain("acme/second#8");
					once(back, "Second: absent");
					once(back, "acme/second#81");
					expect(back).not.toContain("Second: before");
					expect(back).not.toContain("acme/second#80");
					expect(back).not.toContain("Events unread since");
					expect(after).not.toContain("Second:");
					expect(after).not.toContain("acme/second#8");
				},
			);

			it.each([
				{
					out: "its owner opted out",
					leave: () =>
						configureSecond({ tracker: "acme/second", refillLoop: false }),
				},
				{
					out: "now a linked worktree",
					leave: makeLinkedWorktree,
				},
			])("keeps one read last review out, unnamed, $out", ({ leave }) => {
				seedSecond("<!--\nEvents read in second.\n-->\n");
				leave();
				reviewAt(firstReview);

				const [out] = bodies();
				expect(out).not.toMatch(/\bsecond\b/);
			});
		});
	});

	describe("the window between two reviews (#3813)", () => {
		afterEach(() => vi.useRealTimers());

		it("puts a close stamped after a filing's reads begin and before its issue exists in the next review only", () => {
			seed([]);
			const during = {
				number: 78,
				title: "Closed during the filing",
				url: "https://github.com/acme/wfc/issues/78",
				closedAt: "2026-10-10T07:05:00.000Z",
				comments: [{ body: "**Door:** one-way — made mid-filing" }],
			};
			fs.writeFileSync(stub("closed.json"), JSON.stringify([during]));

			reviewAt("2026-10-10T07:00:00.000Z");
			const reviews = JSON.parse(fs.readFileSync(stub("reviews.json"), "utf8"));
			reviews[0].createdAt = "2026-10-10T07:13:00.000Z";
			fs.writeFileSync(stub("reviews.json"), JSON.stringify(reviews));
			reviewAt("2026-10-11T07:00:00.000Z");

			const [first, next] = readCreated();
			expect(first.body).not.toContain("Closed during the filing");
			expect(next.body).toContain(
				"Window: 2026-10-10T07:00:00.000Z → 2026-10-11T07:00:00.000Z",
			);
			expect(next.body).toContain(
				"- acme/wfc#78 — `Closed during the filing` — `made mid-filing`",
			);
		});

		it("falls back to the previous issue's creation where its Window line will not read", () => {
			const createdAt = ago(5);
			seed([
				{
					number: 5,
					title: "Morning review — 2000-01-01",
					state: "OPEN",
					createdAt,
					body: "Edited by hand.\n",
				},
			]);
			expect(run().status).toBe(0);
			const [issue] = readCreated();
			expect(issue.body).toContain(`Window: ${createdAt} → `);
			expect(issue.body).toContain(
				"- acme/wfc: `#5's Window line, so an event during its filing`",
			);
		});
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

		it("files nothing and exits 1 while another filing holds the lock, so the loop's next tick retries", () => {
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
				const r = run();
				expect(r.status).toBe(1);
				expect(r.stderr).toContain(
					`another run is filing today's review (pid ${holder.pid}). Nothing filed: re-run once it ends.`,
				);
				expect(readCreated()).toHaveLength(0);

				const dry = run(["--dry-run"]);
				expect(dry.status).toBe(0);
				expect(dry.stdout).toContain(`${TODAY}\n\n## Question`);
			} finally {
				holder.kill();
			}
		});

		it("takes over the lock of a filing that died", () => {
			seed([]);
			fs.mkdirSync(path.dirname(lockFile()), { recursive: true });
			fs.writeFileSync(lockFile(), "999999999");
			expect(run().status).toBe(0);
			expect(readCreated()).toHaveLength(1);
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
			expect(r.stderr).toContain(
				"the reply failed (GraphQL: Could not resolve",
			);
			expect(readCreated().map((c) => c.title)).toContain(TODAY);
		});

		it("answers reversals and exits non-zero when the filing fails", () => {
			seed([reviewWithRequest()]);
			fs.writeFileSync(stub("fail-review-create"), "");
			const r = run();
			expect(r.status).toBe(1);
			expect(r.stderr).toContain("GraphQL: Could not resolve");
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

	it("prints the body and files nothing on --dry-run, counting the real core's primitives", () => {
		seed([]);
		const r = run(["--dry-run"], { WFC_SCRIPT_ROOT: "" });
		expect(r.status).toBe(0);
		expect(r.stdout).toMatch(
			/`primitives: [1-9]\d* enforced, \d+ open breaches/,
		);
		expect(r.stdout).toContain(`${TODAY}\n\n## Question`);
		expect(r.stdout).toContain("no previous review issue");
		expect(readCreated()).toHaveLength(0);
	});
});
