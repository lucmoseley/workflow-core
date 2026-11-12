/*
 * basis-cited-read.test.ts — pins readBasisFaults, the one call answering
 * bodies' basis faults with the issues their bases cite followed one hop
 * (#5007, #5008, #5079), and how gh's answers turn into issues read, null
 * or unread.
 *
 * Each case drives the entry through the shared gh fake (gh-stub's `cited`,
 * gh-fake's `answerCited`), so the real lib/gh.js call runs. Breaking this
 * lets a citation read as "no issue" where it went unread, refusing a write
 * the gate library should judge on its form alone.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readBasisFaults } from "./basis-cited-read.js";
import type { GhAnswer } from "./gh-fake";
import { type CitedFixture, stubGhRoutes, stubGhScript } from "./gh-stub.js";

let dir: string;
let log: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "basis-cited-read-"));
	log = path.join(dir, "gh.log");
	tracking("o/r");
});

afterEach(() => {
	vi.unstubAllEnvs();
	fs.rmSync(dir, { recursive: true, force: true });
});

function tracking(tracker: string) {
	fs.mkdirSync(path.join(dir, ".claude"), { recursive: true });
	fs.writeFileSync(
		path.join(dir, ".claude", "workflow-core.json"),
		JSON.stringify({ contract: 1, tracker }),
	);
}

/* `cited` answers the read through the shared fake; `graphql`, given, answers
 * every graphql call in its place. */
const serving = (
	cited: Record<string, Record<number, CitedFixture>>,
	graphql?: GhAnswer,
) =>
	vi.stubEnv(
		"WFC_GH",
		stubGhRoutes(dir, graphql ? { graphql } : {}, { log, cited }).gh,
	);

const queries = () =>
	fs.existsSync(log)
		? fs
				.readFileSync(log, "utf8")
				.split("\n")
				.filter((l) => l.startsWith("api graphql"))
		: [];

const Week = "**Gated until:** 2099-01-01 — a week after it lands";
const cites = (basis: string) => `${Week}\n**Gate basis:** ${basis}\n`;
const Count =
	"**Gate basis:** a week: baseline 27/449 attempts (6.0%, `jq`); pass = 0 refusals in 69 attempts a week";

type Judged = Parameters<typeof readBasisFaults>[0][number];

/** readBasisFaults over `bodies`, the suites' seam opened. */
const judge = (
	bodies: Judged[],
	{ timeoutMs = 20_000, env = {} as Record<string, string> } = {},
) =>
	readBasisFaults(bodies, {
		root: dir,
		timeoutMs,
		env: { ...process.env, WFC_GATE_CITED: "", ...env },
	});

const one = (basis: string, opts: Omit<Judged, "body"> = {}) => {
	const got = judge([{ body: cites(basis), ...opts }]);
	return { ...got, faults: got.faults[0], trace: got.traces[0] };
};

/** The no-warrant fault a basis takes where each cited issue faults. */
const faulted = (basis: string, cited: { ref: string; reason: string }[]) => [
	{ kind: "no-warrant", text: basis, cited, words: basis },
];

describe("readBasisFaults follows a cited issue one hop", () => {
	it("faults a basis whose cited issue has no basis, naming it and its reason", () => {
		serving({ "o/r": { 4884: { body: "A baseline, read over 24 h." } } });
		const got = one("#4884 read the baseline over a week");
		expect(got.faults).toEqual(
			faulted("#4884 read the baseline over a week", [
				{ ref: "#4884", reason: "no-basis" },
			]),
		);
		expect(got.unread).toEqual([]);
		expect(queries()).toHaveLength(1);
	});

	it("stands where a cited issue's comment derives the window, reading four issues in one call", () => {
		serving({
			"o/r": {
				2821: { body: "Ruled." },
				2826: { body: "x" },
				2823: { body: "x" },
				2824: { body: "x", comments: ["Plain.", Count] },
			},
		});
		const got = one("#2821, #2826, #2823 and #2824 set a week");
		expect(got.faults).toEqual([]);
		expect(got.trace[0]?.cited.map((c) => c.verdict)).toEqual([
			"no-basis",
			"no-basis",
			"no-basis",
			"stands",
		]);
		expect(queries()).toHaveLength(1);
	});

	it("stands on a question round the cited issue holds, and faults one it does not", () => {
		serving({
			"o/r": { 1556: { body: "x", comments: ["❓ **Q4** - **The count**"] } },
		});
		expect(one("a week is #1556 Q4 (A)'s ruling").faults).toEqual([]);
		expect(one("a week is #1556 Q9 (A)'s ruling").faults).toEqual(
			faulted("a week is #1556 Q9 (A)'s ruling", [
				{ ref: "#1556 Q9", reason: "no-round" },
			]),
		);
	});

	it("reads `name#N` under the tracker's owner and `owner/name#N` in that repo", () => {
		serving({
			"o/lib": { 5: { body: Count } },
			"acme/x": { 6: { body: Count } },
		});
		expect(one("lib#5 set a week").faults).toEqual([]);
		expect(one("acme/x#6 set a week").faults).toEqual([]);
	});

	it("reads nothing for an own warrant, an event anchor, its own number or an untouched legacy basis", () => {
		serving({});
		const legacy = cites("#12 set a week");
		const got = judge([
			{ body: cites(`${Count.replace("**Gate basis:** ", "")} (#12)`) },
			{ body: cites("#12 landed on 5 Nov, and the body asks for a week") },
			{ body: cites("#77 ruled a week"), own: 77 },
			{ body: `${legacy}note\n`, before: legacy, own: 1 },
		]);
		expect(got.faults[0]).toEqual([]);
		expect(got.faults[3]).toEqual([]);
		expect(got.traces[3]).toEqual([]);
		expect(queries()).toHaveLength(0);
	});

	it.each(["o/r#77", "r#77"])(
		"faults a basis citing only its own issue as %s, reading nothing",
		(self) => {
			serving({ "o/r": { 77: { body: Count } } });
			expect(one(`${self} set a week`, { own: 77 }).faults).toEqual(
				faulted(`${self} set a week`, []),
			);
			expect(queries()).toHaveLength(0);
		},
	);

	it("follows only the other issue where a basis cites itself beside it", () => {
		serving({ "o/r": { 77: { body: Count }, 12: { body: "No basis." } } });
		const got = one("o/r#77 and #12 set a week", { own: 77 });
		expect(got.faults).toEqual(
			faulted("o/r#77 and #12 set a week", [
				{ ref: "#12", reason: "no-basis" },
			]),
		);
		expect(queries()).toHaveLength(1);
	});

	it("reads every body's citations in one call, answering each body's faults in order", () => {
		serving({ "o/r": { 12: { body: "No basis." }, 13: { body: Count } } });
		const got = judge([
			{ body: cites("#12 set a week"), own: 450 },
			{ body: cites("#13 set a week"), own: 451 },
		]);
		expect(got.faults).toEqual([
			faulted("#12 set a week", [{ ref: "#12", reason: "no-basis" }]),
			[],
		]);
		expect(got.traces.map((t) => t.map((r) => r.basis))).toEqual([
			["#12 set a week"],
			["#13 set a week"],
		]);
		expect(queries()).toHaveLength(1);
	});
});

describe("readBasisFaults judges a citation it could not read on its form", () => {
	it("names the unread citations where the read fails", () => {
		vi.stubEnv("WFC_GH", stubGhScript(dir, "", { failing: true }).gh);
		const got = one("#12 and #13 set a week");
		expect(got.faults).toEqual([]);
		expect(got.unread.map((w) => w.ref)).toEqual(["#12", "#13"]);
		expect(got.why).toMatch(/^the GitHub read failed/);
	});

	it("reads nothing below its floor, saying too little time was left", () => {
		serving({ "o/r": { 12: { body: "x" } } });
		const got = judge([{ body: cites("#12 set a week") }], { timeoutMs: 1000 });
		expect(got.faults).toEqual([[]]);
		expect(got.why).toBe("too little of the hook's time was left for it");
		expect(got.unread.map((w) => w.key)).toEqual(["o/r#12"]);
		expect(queries()).toHaveLength(0);
	});

	it("says no tracker resolves where the config names none", () => {
		fs.rmSync(path.join(dir, ".claude"), { recursive: true, force: true });
		const got = one("#12 set a week");
		expect(got.faults).toEqual([]);
		expect(got.why).toBe(
			"no tracker resolves from `.claude/workflow-core.json`",
		);
		expect(queries()).toHaveLength(0);
	});

	it("reads nothing with the suites' seam shut in a test worker, and reads with it shut outside one", () => {
		serving({ "o/r": { 12: { body: "No basis." } } });
		const body = [{ body: cites("#12 set a week") }];
		const shut = judge(body, { env: { WFC_GATE_CITED: "off" } });
		expect(shut).toEqual({
			faults: [[]],
			traces: [[]],
			unread: [],
			why: null,
			ms: 0,
		});
		expect(queries()).toHaveLength(0);
		const outside = judge(body, {
			env: { WFC_GATE_CITED: "off", VITEST_WORKER_ID: "" },
		});
		expect(outside.faults[0]).toHaveLength(1);
		expect(queries()).toHaveLength(1);
	});
});

describe("readBasisFaults's read", () => {
	it("reads body and comments, paging comments past one page", () => {
		const comments = [...Array.from({ length: 100 }, (_, i) => `c${i}`), Count];
		serving({ "o/r": { 12: { body: "the body", comments } } });
		const got = one("#12 set a week");
		expect(got.why).toBeNull();
		expect(got.faults).toEqual([]);
		const [first, second] = queries();
		expect(first).toContain("comments(first: 100)");
		expect(second).toContain('after: "100"');
		expect(second).not.toContain("Issue { body ");
	});

	it("reads every repository in one call, each number once", () => {
		serving({ "o/r": { 1: { body: "a" } }, "o/b": { 2: { body: "b" } } });
		const got = one("#1, b#2 and O/R#1 set a week");
		expect(got.unread).toEqual([]);
		const [query] = queries();
		expect(queries()).toHaveLength(1);
		expect(query?.match(/n1: issueOrPullRequest/g)).toHaveLength(1);
		expect(query?.match(/n2: issueOrPullRequest/g)).toHaveLength(1);
	});

	it("reads a number with no issue as no basis, from a partly errored answer", () => {
		serving({ "o/r": { 1: { body: "a" } } });
		const got = one("#9 set a week");
		expect(got.faults).toEqual(
			faulted("#9 set a week", [{ ref: "#9", reason: "no-basis" }]),
		);
		expect(got.why).toBeNull();
	});

	it("leaves a repository it holds no node for unread, saying so", () => {
		serving({});
		const got = one("o/gone#3 set a week");
		expect(got.faults).toEqual([]);
		expect(got.unread.map((w) => w.key)).toEqual(["o/gone#3"]);
		expect(got.why).toBe("o/gone could not be read");
	});

	it("never sends a repository name GraphQL would not take as a literal", () => {
		tracking('o/"x');
		serving({});
		const got = one("#1 set a week");
		expect(queries()).toHaveLength(0);
		expect(got.why).toBe("a repository name was not readable");
	});

	it.each([
		[
			{ status: 1, stdout: "", stderr: "first\nHTTP 502\n" },
			"the GitHub read failed (HTTP 502)",
		],
		[{ status: 1, stdout: "", stderr: "" }, "the GitHub read failed (exit 1)"],
	])("names a failed read without repeating the query: %j", (answer, why) => {
		serving({}, answer);
		const got = one("#1 set a week");
		expect(got.unread.map((w) => w.key)).toEqual(["o/r#1"]);
		expect(got.why).toBe(why);
	});

	it("names a gh that cannot be run by its error code", () => {
		vi.stubEnv("WFC_GH", path.join(dir, "no-such-gh"));
		expect(one("#1 set a week").why).toBe("the GitHub read failed (ENOENT)");
	});
});
