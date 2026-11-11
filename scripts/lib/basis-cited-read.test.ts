/*
 * basis-cited-read.test.ts — pins how the read of the issues a gate basis
 * cites (#5007, #5008) turns gh's answers into issues read, null or unread:
 * comment paging, one call across repositories, a partly errored answer, an
 * unreadable repository, an unsendable name, and the failure wording, which
 * must never repeat the whole query.
 *
 * Each case drives readCitedFor over a gated body through the shared gh fake
 * (gh-stub's `cited`, gh-fake's `answerCited`), so the real lib/gh.js call
 * runs. Breaking this lets a citation read as "no issue" where it went
 * unread, refusing a write the gate library should judge on its form alone.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readCitedFor } from "./basis-cited-read.js";
import type { GhAnswer } from "./gh-fake";
import { type CitedFixture, stubGhRoutes } from "./gh-stub.js";
import { basisFaults } from "./issue-gate.js";

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

/** readCitedFor over a body gated a week whose basis is `basis`. */
const read = (basis: string) => {
	const body = `**Gated until:** 2099-01-01 — a week after it lands\n**Gate basis:** ${basis}\n`;
	const got = readCitedFor((follow) => basisFaults(body, undefined, follow), {
		root: dir,
		timeoutMs: 20_000,
	});
	if (!got) throw new Error("readCitedFor read nothing");
	return { issues: got.follow.issues, why: got.why };
};

describe("readCitedFor's read", () => {
	it("reads body, state and comments, and pages comments past one page", () => {
		const comments = Array.from({ length: 101 }, (_, i) => `c${i}`);
		serving({ "o/r": { 12: { body: "the body", comments } } });
		const got = read("#12 set a week");
		expect(got.why).toBeNull();
		expect(got.issues.get("o/r#12")).toEqual({
			state: "open",
			texts: ["the body", ...comments],
		});
		const [first, second] = queries();
		expect(first).toContain("comments(first: 100)");
		expect(second).toContain('after: "100"');
		expect(second).not.toContain("state body");
	});

	it("reads every repository in one call, each number once", () => {
		serving({ "o/r": { 1: { body: "a" } }, "o/b": { 2: { body: "b" } } });
		const got = read("#1, b#2 and O/R#1 set a week");
		expect(queries()).toHaveLength(1);
		expect([...got.issues.keys()].sort()).toEqual(["o/b#2", "o/r#1"]);
	});

	it("reads a number with no issue as null, from a partly errored answer", () => {
		serving({ "o/r": { 1: { body: "a" } } });
		const got = read("#9 set a week");
		expect(got.issues.get("o/r#9")).toBeNull();
		expect(got.why).toBeNull();
	});

	it("leaves a repository it holds no node for unread, saying so", () => {
		serving({});
		const got = read("o/gone#3 set a week");
		expect(got.issues.has("o/gone#3")).toBe(false);
		expect(got.why).toBe("o/gone could not be read");
	});

	it("never sends a repository name GraphQL would not take as a literal", () => {
		tracking('o/"x');
		serving({});
		const got = read("#1 set a week");
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
		const got = read("#1 set a week");
		expect(got.issues.size).toBe(0);
		expect(got.why).toBe(why);
	});

	it("names a gh that cannot be run by its error code", () => {
		vi.stubEnv("WFC_GH", path.join(dir, "no-such-gh"));
		const got = read("#1 set a week");
		expect(got.why).toBe("the GitHub read failed (ENOENT)");
	});
});
