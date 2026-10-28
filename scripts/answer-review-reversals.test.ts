// @vitest-environment node
/*
 * answer-review-reversals.js, driven through its command line against a stub
 * gh (#2017). Filing goes through the real file-issue.js. Break it and a
 * founder's `reverse <n>` goes unanswered, or files its ticket twice.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { freshSandbox } from "./lib/arbiter-testkit";
import { morningReviewFixture } from "./lib/morning-review-fixture";

const SCRIPT = path.resolve(__dirname, "answer-review-reversals.js");

const sb = freshSandbox();
const { ago, readCreated, run, seed, stub, wfc } = morningReviewFixture(
	sb,
	SCRIPT,
);

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

	it("files a takes:implement ticket carrying the recipe and replies naming it", () => {
		seed([openReview()]);
		const r = run();
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
		run();
		const again = run();
		expect(again.status).toBe(0);
		expect(readCreated()).toHaveLength(1);
		expect(readReplies()).toHaveLength(2);
	});

	it("answers a request on a review closed since it was written", () => {
		seed([{ ...openReview(), state: "CLOSED" }]);
		const r = run();
		expect(r.status).toBe(0);
		expect(readCreated()).toHaveLength(1);
		expect(readReplies()).toHaveLength(2);
	});

	it("files once when the reply fails, and replies on the next run", () => {
		seed([openReview()]);
		fs.writeFileSync(stub("fail-comment"), "");
		const failed = run();
		expect(failed.status).toBe(1);
		expect(failed.stderr).toContain("without filing it again");
		fs.rmSync(stub("fail-comment"));
		const again = run();
		expect(again.status).toBe(0);
		expect(readCreated()).toHaveLength(1);
		expect(readReplies()[0]).toMatch(
			/^\*\*Reversal filed:\*\* entry 1 → acme\/wfc#9\d\d/,
		);
	});

	it("files nothing while a live run holds the reversal lock", () => {
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
			fs.writeFileSync(
				path.join(wfc(), ".claude", "tmp", "markers", "review-reversals.lock"),
				String(holder.pid),
			);
			const r = run();
			expect(r.status).toBe(0);
			expect(r.stdout).toContain("another run is answering reversals");
			expect(readCreated()).toHaveLength(0);
		} finally {
			holder.kill();
		}
	});

	it("takes over a reversal lock a live process holds that answers no reversals", () => {
		seed([openReview()]);
		const lock = path.join(
			wfc(),
			".claude",
			"tmp",
			"markers",
			"review-reversals.lock",
		);
		fs.writeFileSync(lock, String(process.ppid));
		const r = run();
		expect(r.status).toBe(0);
		expect(readCreated()).toHaveLength(1);
		expect(fs.existsSync(lock)).toBe(false);
	});
});
