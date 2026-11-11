/*
 * basis-cited-read.test.ts — pins how the read of the issues a gate basis
 * cites (#5007, #5008) turns gh's answers into issues read, null or unread:
 * comment paging, one call across repositories, a partly errored answer, an
 * unreadable repository, an unsendable name, and the failure wording, which
 * must never repeat the whole query.
 *
 * gh is crossed through WFC_GH, a stub that serves its answers in call order
 * and logs each query, so the real lib/gh.js call runs. Breaking this lets a
 * citation read as "no issue" where it went unread, refusing a write the gate
 * library should judge on its form alone.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readCitedIssues } from "./basis-cited-read.js";
import { stubGhScript } from "./gh-stub.js";

interface Answer {
	status?: number;
	stdout?: unknown;
	stderr?: string;
}

/* Serves answers[n] on the nth call, logging the query it was sent. */
const STUB = `#!/usr/bin/env node
const fs = require("node:fs");
const dir = __DIR__;
const n = fs.readdirSync(dir).filter((f) => f.startsWith("q")).length;
const q = process.argv.find((a) => a.startsWith("query=")) ?? "";
fs.writeFileSync(dir + "/q" + n, q);
const a = JSON.parse(fs.readFileSync(dir + "/answers.json", "utf8"))[n] ?? {};
if (a.stdout !== undefined) process.stdout.write(typeof a.stdout === "string" ? a.stdout : JSON.stringify(a.stdout));
if (a.stderr) process.stderr.write(a.stderr);
process.exit(a.status ?? 0);
`;

let dir: string;
let calls: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "basis-cited-read-"));
	calls = path.join(dir, "calls");
	fs.mkdirSync(calls);
	const { gh } = stubGhScript(
		dir,
		STUB.replace("__DIR__", JSON.stringify(calls)),
	);
	vi.stubEnv("WFC_GH", gh);
});

afterEach(() => {
	vi.unstubAllEnvs();
	fs.rmSync(dir, { recursive: true, force: true });
});

const answering = (...answers: Answer[]) =>
	fs.writeFileSync(path.join(calls, "answers.json"), JSON.stringify(answers));

const queries = () =>
	fs
		.readdirSync(calls)
		.filter((f) => f.startsWith("q"))
		.sort()
		.map((f) => fs.readFileSync(path.join(calls, f), "utf8"));

const issueNode = (body: string, comments: string[], next?: string) => ({
	__typename: "Issue",
	state: "OPEN",
	body,
	comments: {
		pageInfo: { hasNextPage: Boolean(next), endCursor: next ?? null },
		nodes: comments.map((b) => ({ body: b })),
	},
});

const read = (wanted: { repo: string; number: number }[]) =>
	readCitedIssues(wanted, { timeoutMs: 20_000 });

describe("readCitedIssues", () => {
	it("reads body, state and comments, and pages comments past one page", () => {
		answering(
			{
				stdout: {
					data: { r0: { n12: issueNode("the body", ["first"], "c1") } },
				},
			},
			{ stdout: { data: { r0: { n12: issueNode("", ["second"]) } } } },
		);
		const got = read([{ repo: "O/R", number: 12 }]);
		expect(got.why).toBeNull();
		expect(got.issues.get("o/r#12")).toEqual({
			state: "open",
			texts: ["the body", "first", "second"],
		});
		const [first, second] = queries();
		expect(first).toContain("comments(first: 100)");
		expect(second).toContain('after: "c1"');
		expect(second).not.toContain("state body");
	});

	it("reads every repository in one call, each number once", () => {
		answering({
			stdout: {
				data: {
					r0: { n1: issueNode("a", []) },
					r1: { n2: issueNode("b", []) },
				},
			},
		});
		const got = read([
			{ repo: "o/a", number: 1 },
			{ repo: "o/b", number: 2 },
			{ repo: "O/A", number: 1 },
		]);
		expect(queries()).toHaveLength(1);
		expect([...got.issues.keys()].sort()).toEqual(["o/a#1", "o/b#2"]);
	});

	it("reads a number with no issue as null, from a partly errored answer", () => {
		answering({
			status: 1,
			stdout: { data: { r0: { n9: null } } },
			stderr: "GraphQL: Could not resolve to an issue\n",
		});
		const got = read([{ repo: "o/r", number: 9 }]);
		expect(got.issues.get("o/r#9")).toBeNull();
		expect(got.why).toBeNull();
	});

	it("leaves a repository it holds no node for unread, saying so", () => {
		answering({ stdout: { data: { r0: null } } });
		const got = read([{ repo: "o/gone", number: 3 }]);
		expect(got.issues.has("o/gone#3")).toBe(false);
		expect(got.why).toBe("o/gone could not be read");
	});

	it("never sends a repository name GraphQL would not take as a literal", () => {
		const got = read([{ repo: 'o/"x', number: 1 }]);
		expect(queries()).toHaveLength(0);
		expect(got.why).toBe("a repository name was not readable");
	});

	it.each([
		[
			{ status: 1, stderr: "first\nHTTP 502\n" },
			"the GitHub read failed (HTTP 502)",
		],
		[{ status: 1 }, "the GitHub read failed (exit 1)"],
	])("names a failed read without repeating the query: %j", (answer, why) => {
		answering(answer);
		const got = read([{ repo: "o/r", number: 1 }]);
		expect(got.issues.size).toBe(0);
		expect(got.why).toBe(why);
	});

	it("names a gh that cannot be run by its error code", () => {
		vi.stubEnv("WFC_GH", path.join(dir, "no-such-gh"));
		const got = read([{ repo: "o/r", number: 1 }]);
		expect(got.why).toBe("the GitHub read failed (ENOENT)");
	});
});
