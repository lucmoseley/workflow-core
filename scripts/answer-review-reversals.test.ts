// @vitest-environment node
/*
 * answer-review-reversals.js, driven through its command line against a stub
 * gh (#2017). Filing goes through the real file-issue.js. Break it and a
 * founder's `reverse <n>` goes unanswered, or files its ticket twice.
 */

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { endedPid, freshSandbox } from "./lib/arbiter-testkit";
import { localDate } from "./lib/local-date.js";
import { buildReviewTitle } from "./lib/morning-review.js";
import { morningReviewFixture } from "./lib/morning-review-fixture";
import { runInProcess } from "./lib/run-in-process";

const SCRIPT = path.resolve(__dirname, "answer-review-reversals.js");
const FILING = path.resolve(__dirname, "file-morning-review.js");

const sb = freshSandbox();
const {
	ago,
	heldGh,
	home,
	readCreated,
	refillFile,
	run,
	runEnv,
	seed,
	stub,
	wfc,
} = morningReviewFixture(sb, SCRIPT);
const { run: runFiling } = morningReviewFixture(sb, FILING);

/* A guess: a node start and its gh reads, on a machine running full suites. */
const HOLDER_START_MS = 30_000;
const HOLDER_TEST_MS = 2 * HOLDER_START_MS;

const recordFile = () => refillFile("review-reversals-acme__wfc.jsonl");
const lockFile = () => {
	const file = refillFile("review-reversals-acme__wfc.lock");
	fs.mkdirSync(path.dirname(file), { recursive: true });
	return file;
};

const writeTrackerConfig = (root: string, tracker: string) => {
	fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
	fs.writeFileSync(
		path.join(root, ".claude", "workflow-core.json"),
		JSON.stringify({ contract: 1, founder: "T", tracker }),
	);
};

/**
 * A plain-terminal run from a second clone of acme/wfc, outside the harness,
 * its config spelling the tracker in another case.
 */
function runFromClone() {
	const clone = path.join(sb.dir, "clone");
	writeTrackerConfig(clone, "Acme/WFC");
	execFileSync("git", ["init", "-q", clone]);
	const { CLAUDE_PROJECT_DIR: _harnessOnly, ...env } = runEnv();
	return runInProcess(SCRIPT, [], { cwd: clone, env });
}

describe("answer-review-reversals.js (#2017)", () => {
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

	it("files a takes:implement ticket carrying the recipe and replies naming it", async () => {
		seed([openReview()]);
		const r = await run();
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

	it("files a primitives-table entry's reversal in that entry's repo, off the review line alone (#3465)", async () => {
		seed([
			{
				...openReview(),
				body: "## Primitives\n\n### acme/wfc\n\n2. acme/wfc — local row added: `'cli-args.js'` — job `Reading argv` — fff6666\n",
				comments: [{ url: Request, body: "reverse 2" }],
			},
		]);
		const r = await run();
		expect(r.stderr).toBe("");
		expect(r.status).toBe(0);
		const [ticket, ...more] = readCreated();
		expect(more).toHaveLength(0);
		expect(ticket.labels).toEqual(["takes:implement"]);
		expect(ticket.title).toBe(
			"Reverse a primitives-table change in fff6666: 'cli-args.js'",
		);
		expect(ticket.body).toContain(
			"commit fff6666 added the local primitives-table row in `docs/code-standards.md`. Remove the row it added",
		);
		expect(readReplies()[0]).toMatch(
			/^\*\*Reversal filed:\*\* entry 2 → acme\/wfc#9\d\d, for/,
		);
	});

	it("records an entry filed on another repo under the review's tracker (#3829)", async () => {
		seed([
			{
				...openReview(),
				body: "## Primitives\n\n### acme/other\n\n2. acme/other — local row added: `'cli-args.js'` — job `Reading argv` — fff6666\n",
				comments: [{ url: Request, body: "reverse 2" }],
			},
		]);
		const other = path.join(home(), "other");
		fs.mkdirSync(path.join(other, ".git"), { recursive: true });
		writeTrackerConfig(other, "acme/other");
		const r = await run();
		expect(r.stderr).toBe("");
		expect(r.status).toBe(0);
		expect(fs.readFileSync(recordFile(), "utf8")).toMatch(
			/"filed":"acme\/other#9\d\d"/,
		);
	});

	it("reads the record another checkout of the tracker wrote (#3829)", async () => {
		seed([openReview()]);
		fs.writeFileSync(stub("fail-comment"), "");
		expect((await run()).status).toBe(1);
		fs.rmSync(stub("fail-comment"));
		/* A failing search leaves only the record to name the ticket by. */
		fs.writeFileSync(stub("fail-issues-since"), "");
		const again = runFromClone();
		expect(again.stderr).toBe("");
		expect(again.status).toBe(0);
		expect(readCreated()).toHaveLength(1);
		expect(readReplies()[0]).toMatch(
			/^\*\*Reversal filed:\*\* entry 1 → acme\/wfc#9\d\d/,
		);
	});

	it("files nothing for a request already answered", async () => {
		seed([openReview()]);
		await run();
		const again = await run();
		expect(again.status).toBe(0);
		expect(readCreated()).toHaveLength(1);
		expect(readReplies()).toHaveLength(2);
	});

	it("answers a request on a review closed since it was written", async () => {
		seed([{ ...openReview(), state: "CLOSED" }]);
		const r = await run();
		expect(r.status).toBe(0);
		expect(readCreated()).toHaveLength(1);
		expect(readReplies()).toHaveLength(2);
	});

	it("files once for a review the open and closed reads both return (#3815)", async () => {
		seed([openReview(), { ...openReview(), state: "CLOSED" }]);
		expect((await run()).status).toBe(0);
		const calls = fs.readFileSync(stub("calls.log"), "utf8").split("\n");
		expect(calls.filter((c) => c.startsWith("issue create"))).toHaveLength(1);
	});

	it("files once when the reply fails, and replies on the next run", async () => {
		seed([openReview()]);
		fs.writeFileSync(stub("fail-comment"), "");
		const failed = await run();
		expect(failed.status).toBe(1);
		expect(failed.stderr).toContain("without filing it again");
		fs.rmSync(stub("fail-comment"));
		const again = await run();
		expect(again.status).toBe(0);
		expect(readCreated()).toHaveLength(1);
		expect(readReplies()[0]).toMatch(
			/^\*\*Reversal filed:\*\* entry 1 → acme\/wfc#9\d\d/,
		);
	});

	it("names a ticket whose create landed reporting failure, on the next run (#3828)", async () => {
		seed([openReview()]);
		fs.writeFileSync(stub("fail-after-create"), "");
		const failed = await run();
		expect(failed.status).toBe(1);
		expect(failed.stderr).toContain("left for the next run");
		expect(readCreated()).toHaveLength(1);
		fs.rmSync(stub("fail-after-create"));
		fs.writeFileSync(stub("fail-comment"), "");
		expect((await run()).status).toBe(1);
		expect(readCreated()).toHaveLength(1);
		fs.rmSync(stub("fail-comment"));
		/* Named off the record now: this run's read of the tracker would fail. */
		fs.writeFileSync(stub("fail-issues-since"), "");
		const named = await run();
		expect(named.stderr).toBe("");
		expect(named.status).toBe(0);
		expect(readCreated()).toHaveLength(1);
		expect(readReplies().at(-1)).toMatch(
			/^\*\*Reversal filed:\*\* entry 1 → acme\/wfc#9\d\d, for/,
		);
	});

	it("looks again before filing where the read for a landed ticket comes back empty (#3828)", async () => {
		const review = openReview();
		seed([review]);
		fs.writeFileSync(stub("fail-after-create"), "");
		await run();
		fs.rmSync(stub("fail-after-create"));
		fs.writeFileSync(stub("empty-issues-since"), "");
		expect((await run()).status).toBe(0);
		expect(readCreated()).toHaveLength(1);
		expect(fs.readFileSync(stub("calls.log"), "utf8")).toContain(
			`since=${review.createdAt}`,
		);
	});

	it("files a reversal whose title another request's ticket already carries (#3828)", async () => {
		seed([openReview()]);
		/* The URL holds this request's as a prefix, as `entry 1` does `entry 12`. */
		fs.writeFileSync(
			stub("created-800.json"),
			JSON.stringify({
				title: "Reverse a delegated decision on #2: Inside the window",
				labels: ["takes:implement"],
				body: `The founder reversed entry 1 of the morning review acme/wfc#5 ([#5 comment](${Request}0)): the delegated decision.`,
			}),
		);
		expect((await run()).status).toBe(0);
		expect(readCreated()).toHaveLength(2);
		expect(readReplies()[0]).toMatch(/entry 1 → acme\/wfc#9\d\d, for/);
	});

	it("files nothing where the look for a landed ticket fails (#3828)", async () => {
		seed([openReview()]);
		fs.writeFileSync(stub("fail-issues-since"), "");
		const r = await run();
		expect(r.status).toBe(1);
		expect(r.stderr).toContain(
			"entry 1 of #5: could not look for a ticket already filed (gh: Not Found (HTTP 404)), left for the next run",
		);
		expect(readCreated()).toHaveLength(0);
	});

	it.each([
		["this checkout", () => run()],
		["another checkout of the tracker (#3829)", runFromClone],
	])(
		"files nothing from %s while a live run holds the reversal lock",
		async (_from, runIt) => {
			seed([openReview()]);
			/* pid-lock.js reads a holder by its command line, so the holder runs
			 * a file of this script's name. */
			const holderScript = path.join(
				sb.dir,
				"holder",
				"answer-review-reversals.js",
			);
			fs.mkdirSync(path.dirname(holderScript), { recursive: true });
			fs.writeFileSync(holderScript, "setInterval(() => {}, 1000);\n");
			// spawn-kept: two processes at once — the live lock holder runs beside the call under test, and is killed by signal.
			const holder = spawn(process.execPath, [holderScript], {
				stdio: "ignore",
			});
			try {
				fs.writeFileSync(lockFile(), String(holder.pid));
				const r = await runIt();
				expect(r.status).toBe(0);
				expect(r.stdout).toContain("another run is answering reversals");
				expect(readCreated()).toHaveLength(0);
			} finally {
				holder.kill();
			}
		},
	);

	it.each([
		["file-morning-review.js", "answer-review-reversals.js", FILING, run],
		["answer-review-reversals.js", "file-morning-review.js", SCRIPT, runFiling],
	])(
		"with %s mid-answer, a run of %s leaves the answering to it (#3815)",
		async (_holder, _other, holderScript, runOther) => {
			/* Today's review is already filed, so a filing run goes straight to
			 * answering. */
			seed([
				{ ...openReview(), title: buildReviewTitle(localDate(new Date())) },
			]);
			fs.writeFileSync(stub("hold-create"), "");
			// spawn-kept: two processes at once — the lock's holder is a real program, read by its command line, while the other runs.
			const holder = spawn(process.execPath, [holderScript], {
				cwd: wfc(),
				env: { ...runEnv(), ...heldGh() },
				stdio: "ignore",
			});
			const exited = new Promise((done) => holder.on("exit", done));
			try {
				await vi.waitFor(
					() => expect(fs.existsSync(stub("holding"))).toBe(true),
					{ timeout: HOLDER_START_MS },
				);
				const r = await runOther();
				expect(r.status).toBe(0);
				expect(r.stdout).toContain("another run is answering reversals");
				expect(readCreated()).toHaveLength(0);
				fs.writeFileSync(stub("release"), "");
				expect(await exited).toBe(0);
				expect(readCreated()).toHaveLength(1);
			} finally {
				fs.writeFileSync(stub("release"), "");
				holder.kill();
			}
		},
		HOLDER_TEST_MS,
	);

	it("takes a reversal lock whose holder is dead", async () => {
		seed([openReview()]);
		fs.writeFileSync(lockFile(), endedPid());
		expect((await run()).status).toBe(0);
		expect(readCreated()).toHaveLength(1);
		expect(fs.existsSync(lockFile())).toBe(false);
	});

	it("takes over a reversal lock a live process holds that answers no reversals", async () => {
		seed([openReview()]);
		fs.writeFileSync(lockFile(), String(process.ppid));
		const r = await run();
		expect(r.status).toBe(0);
		expect(readCreated()).toHaveLength(1);
		expect(fs.existsSync(lockFile())).toBe(false);
	});
});
