/*
 * A `reverse <n>` comment on the morning review, parsed to the ticket that
 * undoes entry n and the reply answering it (#2017).
 *
 * Requests are read through pendingRequests alone, the export the generator
 * calls, with replies built by buildAckComment, so the marker a reply writes
 * and the one the reader looks for cannot drift apart unnoticed.
 */

import { describe, expect, it } from "vitest";

const {
	buildAckComment,
	buildPrimitiveReversalTicket,
	buildReversalTicket,
	pendingRequests,
} = require("./review-reversal.js");
const { basisFaults } = require("./issue-gate.js");
const { titleFirstLinks } = require("./title-first-links.js");

const REQ = "https://github.com/acme/wfc/issues/900#issuecomment-5";

const entry = {
	at: "2026-10-18T02:00:00Z",
	repo: "acme/mh",
	issue: 42,
	comment: "https://github.com/acme/mh/issues/42#issuecomment-9",
	session: null,
	question: "Retry the upload 3 times or 5, 7 days after a failure?",
	taken: { option: "(A) 3 times", figure: 52 },
	runnerUp: { option: "(B) 5 times", figure: 48 },
	rungs: { rulings: "none", web: "none", subagent: "none" },
	stillClose: true,
	reverse: "revert abc1234, then set RETRIES=5",
};

const asked = (body: string) =>
	pendingRequests([{ url: REQ, body }]).map((r: { n: number | null }) => r.n);

describe("which requests a comment makes", () => {
	it("reads one entry per line, each once, in any case", () => {
		expect(asked("reverse 3\nReverse #5\n  reverse 3  ")).toEqual([3, 5]);
	});

	it("reads a list and text after the numbers", () => {
		expect(asked("Reverse entry #3, 5 and 7 — wrong call")).toEqual([3, 5, 7]);
	});

	it("takes a reverse line naming no number as a request to answer", () => {
		expect(asked("reverse the retry call please")).toEqual([null]);
	});

	it("reads nothing from prose that does not open a line with reverse", () => {
		expect(asked("please reverse 3 if you can\nreversal 4")).toEqual([]);
	});
});

describe("pendingRequests", () => {
	it("drops a request a reply has answered, filed or not", () => {
		const comments = [
			{ url: REQ, body: "reverse 1\nreverse 2\nreverse it" },
			{ url: `${REQ}0`, body: "reverse 3" },
			{
				url: "r1",
				body: buildAckComment(
					900,
					{ commentUrl: REQ, n: 1 },
					{ filed: "acme/mh#7" },
				),
			},
			{
				url: "r2",
				body: buildAckComment(
					900,
					{ commentUrl: REQ, n: null },
					{ why: "no number" },
				),
			},
			{
				url: "r3",
				body: buildAckComment(
					900,
					{ commentUrl: `${REQ}0`, n: 3 },
					{ why: "no entry 3" },
				),
			},
		];
		expect(pendingRequests(comments)).toEqual([{ commentUrl: REQ, n: 2 }]);
	});

	it("takes nothing from its own replies", () => {
		const ack = buildAckComment(
			900,
			{ commentUrl: REQ, n: 1 },
			{ filed: "acme/mh#7" },
		);
		expect(pendingRequests([{ url: "r1", body: ack }])).toEqual([]);
	});
});

describe("buildReversalTicket", () => {
	const t = buildReversalTicket({
		review: { repo: "acme/wfc", number: 900 },
		request: { commentUrl: REQ, n: 2 },
		entry,
	});

	it("carries the recipe and links the review, the request and the decision", () => {
		expect(t.title).toBe(
			`Reverse a delegated decision on #42: ${entry.question}`,
		);
		expect(t.body).toContain("entry 2 of the morning review acme/wfc#900");
		expect(t.body).toContain(`([#900 comment](${REQ}))`);
		expect(t.body).toContain(`acme/mh#42 ([#42 comment](${entry.comment}))`);
		expect(t.body).toContain(
			"- To reverse: `revert abc1234, then set RETRIES=5`",
		);
		expect(t.body).toContain("- Runner-up: `(B) 5 times` — 48%");
		expect(t.body).toMatch(/^## What to build\n/);
		expect(t.body).toContain("## Acceptance criteria");
	});

	it("cites each link by number, so the citation check finds no title-first link in it (#2265)", () => {
		expect(titleFirstLinks(t.body, "acme/wfc")).toEqual([]);
		expect(titleFirstLinks(t.body, "acme/mh")).toEqual([]);
	});

	it("quotes the copied text, so the basis check passes it", () => {
		expect(basisFaults(t.body)).toEqual([]);
	});

	it("cuts a long question in the title", () => {
		const long = buildReversalTicket({
			review: { repo: "acme/wfc", number: 900 },
			request: { commentUrl: REQ, n: 2 },
			entry: { ...entry, question: "x".repeat(200) },
		});
		expect(long.title).toBe(
			`Reverse a delegated decision on #42: ${"x".repeat(79)}…`,
		);
	});
});

describe("buildPrimitiveReversalTicket (#3465)", () => {
	const primitive = (change: string, cells: string[] = []) =>
		buildPrimitiveReversalTicket({
			review: { repo: "acme/wfc", number: 900 },
			request: { commentUrl: REQ, n: 4 },
			entry: {
				kind: "primitive",
				repo: "acme/wfc",
				side: "base",
				change,
				cells,
				primitive: "'hostRoot()' in 'scripts/lib/host-root.js'",
				job: "Finding the host repository",
				sha: "abc1234",
			},
		});

	it("names the commit, the side's file, the job and what undoing it asks", () => {
		const t = primitive("rewritten", ["Exemplar", "Rule"]);
		expect(t.title).toBe(
			"Reverse a primitives-table change in abc1234: 'hostRoot()' in 'scripts/lib/host-root.js'",
		);
		expect(t.body).toContain(
			`entry 4 of the morning review acme/wfc#900 ([#900 comment](${REQ})): commit abc1234 rewrote the base primitives-table row in \`docs/code-standards-base.md\`. Restore the row's Exemplar, Rule cells as they stood before that commit`,
		);
		expect(t.body).toContain("- Job: `Finding the host repository`");
		expect(t.body).toContain(
			"- Diff: `git show abc1234 -- docs/code-standards-base.md`",
		);
		expect(primitive("added").body).toContain("Remove the row it added");
		expect(primitive("removed").body).toContain(
			"Restore the row as it stood before that commit",
		);
	});

	it("passes the basis and citation checks", () => {
		const t = primitive("added");
		expect(basisFaults(t.body)).toEqual([]);
		expect(titleFirstLinks(t.body, "acme/wfc")).toEqual([]);
	});
});

describe("buildAckComment", () => {
	it("names the new ticket", () => {
		expect(
			buildAckComment(
				900,
				{ commentUrl: REQ, n: 2 },
				{ filed: "acme/mh#77" },
			).split("\n")[0],
		).toBe(
			`**Reversal filed:** entry 2 → acme/mh#77, for [#900 request](${REQ}).`,
		);
	});

	it("cites the request by number, so the citation check finds no title-first link in it (#2265)", () => {
		const ack = buildAckComment(900, { commentUrl: REQ, n: 2 }, { why: "x" });
		expect(titleFirstLinks(ack, "acme/wfc")).toEqual([]);
	});

	it("says why where nothing was filed", () => {
		expect(
			buildAckComment(
				900,
				{ commentUrl: REQ, n: 9 },
				{ why: "the review lists no entry 9" },
			),
		).toContain("**Reversal not filed:** entry 9");
	});
});
