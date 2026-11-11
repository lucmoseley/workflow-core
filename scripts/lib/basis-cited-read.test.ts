import { describe, expect, it } from "vitest";
import { COMMENTS_PAGE, readCitedIssues } from "./basis-cited-read.js";

type Run = (args: string[], opts: { timeout: number }) => string;

/** A failure shaped as execFileSync throws it. */
const failure = (fields: Record<string, unknown>) =>
	Object.assign(new Error("Command failed: gh api graphql -f query=…"), fields);

const issueNode = (body: string, comments: string[], next?: string) => ({
	__typename: "Issue",
	state: "OPEN",
	body,
	comments: {
		pageInfo: { hasNextPage: Boolean(next), endCursor: next ?? null },
		nodes: comments.map((b) => ({ body: b })),
	},
});

describe("readCitedIssues", () => {
	it("reads body, state and comments, and pages comments past one page", () => {
		const queries: string[] = [];
		const run: Run = (args) => {
			const q = args.find((a) => a.startsWith("query=")) ?? "";
			queries.push(q);
			const n12 = q.includes('after: "c1"')
				? issueNode("", ["second page"])
				: issueNode("the body", ["first page"], "c1");
			return JSON.stringify({ data: { r0: { n12 } } });
		};
		const got = readCitedIssues([{ repo: "O/R", number: 12 }], {
			timeoutMs: 5000,
			run,
		});
		expect(got.why).toBeNull();
		expect(got.issues.get("o/r#12")).toEqual({
			state: "open",
			texts: ["the body", "first page", "second page"],
		});
		expect(queries).toHaveLength(2);
		expect(queries[0]).toContain(`comments(first: ${COMMENTS_PAGE})`);
		expect(queries[1]).not.toContain("state body");
	});

	it("reads every repository in one call, each number once", () => {
		let calls = 0;
		const run: Run = () => {
			calls++;
			return JSON.stringify({
				data: {
					r0: { n1: issueNode("a", []) },
					r1: { n2: issueNode("b", []) },
				},
			});
		};
		const got = readCitedIssues(
			[
				{ repo: "o/a", number: 1 },
				{ repo: "o/b", number: 2 },
				{ repo: "O/A", number: 1 },
			],
			{ timeoutMs: 5000, run },
		);
		expect(calls).toBe(1);
		expect([...got.issues.keys()].sort()).toEqual(["o/a#1", "o/b#2"]);
	});

	it("reads a number with no issue as null, from a partly errored answer", () => {
		const run: Run = () => {
			throw failure({
				status: 1,
				stdout: JSON.stringify({ data: { r0: { n9: null } } }),
				stderr: "GraphQL: Could not resolve to an issue",
			});
		};
		const got = readCitedIssues([{ repo: "o/r", number: 9 }], {
			timeoutMs: 5000,
			run,
		});
		expect(got.issues.get("o/r#9")).toBeNull();
		expect(got.why).toBeNull();
	});

	it("leaves a repository it holds no node for unread, saying so", () => {
		const run: Run = () => JSON.stringify({ data: { r0: null } });
		const got = readCitedIssues([{ repo: "o/gone", number: 3 }], {
			timeoutMs: 5000,
			run,
		});
		expect(got.issues.has("o/gone#3")).toBe(false);
		expect(got.why).toBe("o/gone could not be read");
	});

	it("never sends a repository name GraphQL would not take as a literal", () => {
		let calls = 0;
		const got = readCitedIssues([{ repo: 'o/"x', number: 1 }], {
			timeoutMs: 5000,
			run: () => {
				calls++;
				return "{}";
			},
		});
		expect(calls).toBe(0);
		expect(got.why).toBe("a repository name was not readable");
	});

	it.each([
		[
			{ status: 1, stderr: "first\nHTTP 502" },
			"the GitHub read failed (HTTP 502)",
		],
		[{ status: 1, stderr: "" }, "the GitHub read failed (exit 1)"],
		[{ code: "ETIMEDOUT" }, "GitHub did not answer within 5000 ms"],
		[{ code: "ENOENT" }, "the GitHub read failed (ENOENT)"],
	])("names a failed read without repeating the query: %j", (fields, why) => {
		const got = readCitedIssues([{ repo: "o/r", number: 1 }], {
			timeoutMs: 5000,
			run: () => {
				throw failure(fields);
			},
		});
		expect(got.issues.size).toBe(0);
		expect(got.why).toBe(why);
	});
});
