// @vitest-environment node
/*
 * outstanding-line.test.ts — pins lib/outstanding-line.js, the founder-facing
 * item grammar and its open-check (#982). Those cases go through `judge`, the
 * entry each reader calls; the grammar cases run shape-only, the open-check
 * cases against a stub `gh`, never the real one. Through `judge` so a case
 * tests what the guards actually receive; a stub `gh` so each case dictates
 * GitHub's answer — open, closed, missing, a pull request, a failure — which
 * the live tracker could not be made to give on demand.
 *
 * WHAT BREAKING IT COSTS: the close guard, resolve-ticket.js and the
 * inventory guard all judge through this one module (#958). A regression
 * there passes a close or an ending whose owed work no open issue carries, in
 * all three at once, or refuses the honest ones.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GH_FAILING_SCRIPT, stubGhScript } from "./gh-stub";
import { runInProcess } from "./run-in-process";

const LIB = path.resolve(__dirname, "outstanding-line.js");
const TRACKER = "o/here";

let dir: string;
let savedEnv: NodeJS.ProcessEnv;

beforeEach(() => {
	savedEnv = { ...process.env };
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "outstanding-line-"));
});
afterEach(() => {
	process.env = savedEnv;
	fs.rmSync(dir, { recursive: true, force: true });
});

const load = async () => await import(LIB);

const shape = async (text: string, grammar = "outstanding") =>
	(await load()).judge(text, { grammar, tracker: TRACKER, shapeOnly: true });

/** Serve `data` (and `errors`, exiting 1 as gh does on a GraphQL error). */
const serve = (data: unknown, { errors = false, sleep = 0 } = {}) => {
	const body = JSON.stringify(
		errors ? { data, errors: [{ type: "NOT_FOUND" }] } : { data },
	);
	fs.writeFileSync(path.join(dir, "response.json"), body);
	const script = [
		"#!/bin/sh",
		`printf '%s\\n' "$*" >>${dir}/calls`,
		sleep ? `sleep ${sleep}` : "",
		`cat ${dir}/response.json`,
		errors
			? "echo 'gh: Could not resolve to an issue or pull request' >&2; exit 1"
			: "",
	].join("\n");
	process.env.WFC_GH = stubGhScript(dir, script).gh;
};

const calls = () => {
	const at = path.join(dir, "calls");
	return fs.existsSync(at)
		? fs.readFileSync(at, "utf8").trim().split("\n")
		: [];
};

const issue = (state: string, comments?: unknown[]) => ({
	__typename: "Issue",
	state,
	...(comments ? { comments: { nodes: comments } } : {}),
});

const check = async (text: string, opts: Record<string, unknown> = {}) => {
	const log = vi.fn();
	const verdict = (await load()).judge(text, {
		grammar: "outstanding",
		tracker: TRACKER,
		log,
		...opts,
	});
	return { verdict, log };
};

describe("the Outstanding line", () => {
	it("passes a bare none, with or without its full stop", async () => {
		for (const text of ["**Outstanding:** none", "**Outstanding:** none."]) {
			const v = await shape(text);
			expect(v).toMatchObject({ ok: true, none: true, items: [] });
		}
	});

	it("refuses none with a reason after it — #898's incident shape", async () => {
		const v = await shape(
			"**Outstanding:** none — every acceptance criterion is ticked or annotated above",
		);
		expect(v.ok).toBe(false);
		expect(v.refusals[0].reason).toMatch(/`none` stands alone/);
		expect(v.shape).toMatch(/^`\*\*Outstanding:\*\* none`, or /);
	});

	it("refuses a sha on the line, alone or after an item, saying the sha goes on another line", async () => {
		for (const text of [
			"**Outstanding:** Source write-back: banner on `docs/x.md` (3ce545d2)",
			"**Outstanding:** #12 (the rest) (0d0aea71)",
		]) {
			const v = await shape(text);
			expect(v.ok).toBe(false);
			expect(v.refusals[0].reason).toMatch(/commit sha goes on another line/);
		}
	});

	it("refuses a range, asking for each item (mh#3592, #908 F4)", async () => {
		const v = await shape("**Outstanding:** #3615 through #3622 (the units)");
		expect(v.ok).toBe(false);
		expect(v.refusals[0].reason).toMatch(/a range is not an item/);
	});

	it("refuses a cross-repo ref written as prose (mh#3566, mh#3625, #908 F4)", async () => {
		for (const text of [
			"**Outstanding:** lives on `lucmoseley/workflow-core` as `#1`–`#9` (plus `#10`)",
			"**Outstanding:** the fix belongs in workflow-core, not here; not filed there",
		]) {
			expect((await shape(text)).ok).toBe(false);
		}
	});

	it("reads all three ref spellings, across both separators", async () => {
		const v = await shape(
			"**Outstanding:** #5 (a), there#6 (b); other/far#7 (c).",
		);
		expect(v.ok).toBe(true);
		expect(v.items.map((i: { ref: string }) => i.ref)).toEqual([
			"o/here#5",
			"o/there#6",
			"other/far#7",
		]);
		expect(v.items[2].gist).toBe("c");
	});

	it("keeps a ref inside the gist as gist, nested parentheses included (fb#1977, #908 F6)", async () => {
		const v = await shape(
			"**Outstanding:** #5 (the #1977 pass's two leads (fourth-wing))",
		);
		expect(v.ok).toBe(true);
		expect(v.items).toHaveLength(1);
		expect(v.items[0].gist).toBe("the #1977 pass's two leads (fourth-wing)");
	});

	it("refuses prose after an item (#908's own close), and an item with no gist", async () => {
		for (const text of [
			"**Outstanding:** #911 (which items the guard refuses) is now unblocked and consumes these figures.",
			"**Outstanding:** #911",
			"**Outstanding:** #911 ()",
			"**Outstanding:** #5 (a) and #6 (b)",
		]) {
			expect((await shape(text)).ok).toBe(false);
		}
	});

	it("owes exactly one line, and skips one quoted in a fenced block", async () => {
		expect((await shape("Done at abc.")).refusals[0].reason).toMatch(
			/no \*\*Outstanding:\*\* line/,
		);
		expect(
			(await shape("**Outstanding:** none\n**Outstanding:** #5 (a)"))
				.refusals[0].reason,
		).toMatch(/2 \*\*Outstanding:\*\* lines/);
		expect((await shape("    **Outstanding:** none")).ok).toBe(true);
		const fenced =
			"```\n**Outstanding:** none — an example\n```\n**Outstanding:** none";
		expect((await shape(fenced)).ok).toBe(true);
	});
});

describe("the #982 review's grammar faults", () => {
	it("reads a bracket inside a code span as gist text", async () => {
		const v = await shape("**Outstanding:** #5 (the `)` case), #6 (b)");
		expect(v.items.map((i: { gist: string }) => i.gist)).toEqual([
			"the `)` case",
			"b",
		]);
	});

	it("names the fault outside a gist, not a range quoted inside one", async () => {
		const v = await shape(
			"**Outstanding:** #5 (a), #6 (see #7 to #9) trailing prose",
		);
		expect(v.ok).toBe(false);
		expect(v.refusals[0].reason).toMatch(/only another item may follow/);
	});
});

describe("the inventory and brief block", () => {
	it("passes nothing alone, and one item per line", async () => {
		expect(await shape("nothing", "block")).toMatchObject({
			ok: true,
			none: true,
		});
		const v = await shape(
			"- #31 (send the reply)\n- there#32 (check the page)\n",
			"block",
		);
		expect(v.ok).toBe(true);
		expect(v.items.map((i: { ref: string }) => i.ref)).toEqual([
			"o/here#31",
			"o/there#32",
		]);
	});

	it("refuses an empty block, nothing beside items, a missing bullet and two items on a line, giving the one line per item shape", async () => {
		for (const text of [
			"",
			"nothing\n- #31 (send it)",
			"#31 (send it)",
			"- #31 (send it), #32 (check it)",
			"- #31 through #34 (the drafts)",
		]) {
			const v = await shape(text, "block");
			expect(v.ok).toBe(false);
			expect(v.shape).toMatch(/^one `- #N \(what to do\)` line per item/);
		}
	});
});

describe("the open-check", () => {
	it("passes an open issue, in one batched call", async () => {
		serve({ r0: { n5: issue("OPEN") } });
		const { verdict } = await check("**Outstanding:** #5 (a)");
		expect(verdict).toMatchObject({
			ok: true,
			statuses: { "o/here#5": "open" },
		});
		expect(calls()).toHaveLength(1);
		expect(calls()[0]).toMatch(/^api graphql -f query=/);
		expect(calls()[0]).toContain('repository(owner: "o", name: "here")');
	});

	it("never reads a ref inside a gist", async () => {
		serve({ r0: { n5: issue("OPEN") } });
		await check("**Outstanding:** #5 (after #1977 lands)");
		expect(calls()[0]).toContain("n5:");
		expect(calls()[0]).not.toContain("1977");
	});

	it("refuses a closed issue, naming its full ref", async () => {
		serve({ r0: { n5: issue("CLOSED") } });
		const { verdict } = await check("**Outstanding:** #5 (a)");
		expect(verdict.ok).toBe(false);
		expect(verdict.refusals[0]).toMatchObject({ ref: "o/here#5" });
		expect(verdict.refusals[0].reason).toMatch(/is closed/);
	});

	it("refuses a missing number, read from the partial answer gh prints on a GraphQL error", async () => {
		serve({ r0: { n5: issue("OPEN"), n9999: null } }, { errors: true });
		const { verdict, log } = await check("**Outstanding:** #5 (a), #9999 (b)");
		expect(verdict.statuses).toEqual({
			"o/here#5": "open",
			"o/here#9999": "missing",
		});
		expect(verdict.refusals[0].reason).toMatch(/does not exist/);
		expect(log).not.toHaveBeenCalled();
	});

	it("refuses a pull request number", async () => {
		serve({ r0: { n7: { __typename: "PullRequest" } } });
		const { verdict } = await check("**Outstanding:** #7 (a)");
		expect(verdict.ok).toBe(false);
		expect(verdict.refusals[0].reason).toMatch(/pull request/);
	});

	it("refuses the issue being closed as its own carrier, in any letter case, reading nothing (#982 review)", async () => {
		serve({});
		for (const ref of ["#40", "here#40", "Here#40", "O/here#40"]) {
			const { verdict } = await check(`**Outstanding:** ${ref} (the rest)`, {
				self: 40,
			});
			expect(verdict.ok).toBe(false);
			expect(verdict.statuses["o/here#40"]).toBe("self");
		}
		expect(calls()).toHaveLength(0);
	});

	it("fails open on an unreachable GitHub: shape only, logged", async () => {
		process.env.WFC_GH = stubGhScript(dir, GH_FAILING_SCRIPT, {
			failing: true,
		}).gh;
		const { verdict, log } = await check("**Outstanding:** #5 (a)");
		expect(verdict.ok).toBe(true);
		expect(verdict.statuses["o/here#5"]).toBe("unchecked");
		expect(verdict.unchecked[0]).toMatch(/GitHub unreachable/);
		expect(log).toHaveBeenCalledWith(
			"outstanding-line",
			"open-check skipped: GitHub unreachable; shape check only",
		);
	});

	it("fails open on a bare ref where no tracker resolves, marking it unchecked and logging it, still reading a full one", async () => {
		serve({ r0: { n7: issue("CLOSED") } });
		const { verdict, log } = await check(
			"**Outstanding:** #5 (a), o/far#7 (b)",
			{ tracker: "not-a-tracker" },
		);
		expect(verdict.statuses).toEqual({
			"#5": "unchecked",
			"o/far#7": "closed",
		});
		expect(verdict.unchecked[0]).toMatch(/no tracker resolves/);
		expect(calls()).toHaveLength(1);
		expect(log).toHaveBeenCalledOnce();
		const bad = await check("**Outstanding:** none — a reason", {
			tracker: "not-a-tracker",
		});
		expect(bad.verdict.ok).toBe(false);
	});

	it("fails open on a read past its ceiling, reporting GitHub unreachable and logging it", async () => {
		serve({ r0: { n5: issue("CLOSED") } }, { sleep: 2 });
		const { verdict, log } = await check("**Outstanding:** #5 (a)", {
			timeoutMs: 200,
		});
		expect(verdict.ok).toBe(true);
		expect(verdict.unchecked[0]).toMatch(/GitHub unreachable/);
		expect(log).toHaveBeenCalledOnce();
	});

	it("fails open on an unreadable repo alone, naming it, still judging the readable one", async () => {
		serve({ r0: { n5: issue("CLOSED") }, r1: null }, { errors: true });
		const { verdict, log } = await check(
			"**Outstanding:** #5 (a), secret#3 (b)",
		);
		expect(verdict.statuses).toEqual({
			"o/here#5": "closed",
			"o/secret#3": "unchecked",
		});
		expect(verdict.refusals).toHaveLength(1);
		expect(verdict.unchecked[0]).toMatch(/o\/secret is unreadable/);
		expect(log).toHaveBeenCalledOnce();
	});

	it("returns each cited issue's last 5 comments from the same call", async () => {
		const round = {
			author: { login: "bot" },
			body: "❓ **Q1**",
			createdAt: "t",
			url: "u",
		};
		serve({
			r0: { n5: issue("OPEN", [round]) },
			r1: { n6: issue("OPEN", []) },
		});
		const { verdict } = await check(
			"- #5 (answer Q1)\n- far/away#6 (send it)",
			{
				grammar: "block",
				comments: true,
			},
		);
		expect(calls()).toHaveLength(1);
		expect(calls()[0]).toContain("comments(last: 5)");
		expect(verdict.comments).toEqual({
			"o/here#5": [
				{ author: "bot", body: "❓ **Q1**", createdAt: "t", url: "u" },
			],
			"far/away#6": [],
		});
	});

	it("skips a comment GitHub answered as null, as a partial answer allows", async () => {
		const round = { author: null, body: "❓ **Q1**", createdAt: "t", url: "u" };
		serve({ r0: { n5: issue("OPEN", [null, round]) } });
		const { verdict } = await check("- #5 (answer Q1)", {
			grammar: "block",
			comments: true,
		});
		expect(verdict.comments).toEqual({
			"o/here#5": [{ author: "", body: "❓ **Q1**", createdAt: "t", url: "u" }],
		});
	});
});

describe("the CLI, for the bash hooks", () => {
	const run = (args: string[], stdin: string) =>
		runInProcess(LIB, args, {
			stdin,
			env: { ...process.env } as Record<string, string>,
		});

	it("prints the verdict and exits 1 on a refusal, 0 on a pass", () => {
		serve({ r0: { n5: issue("CLOSED"), n6: issue("OPEN") } });
		const refused = run(
			["outstanding", "--tracker", TRACKER],
			"**Outstanding:** #5 (a)",
		);
		expect(refused.status).toBe(1);
		const verdict = JSON.parse(refused.stdout);
		expect(verdict.refusals[0].ref).toBe("o/here#5");
		expect(verdict.refusals[0].reason).toMatch(/is closed.*cite an open issue/);
		expect(verdict.message).toMatch(
			/^- o\/here#5 is closed[\s\S]*The shape: `\*\*Outstanding:\*\* none`, or[\s\S]*goes on another line/,
		);
		const passed = run(
			["block", "--tracker", TRACKER, "--shape-only"],
			"nothing",
		);
		expect(passed.status).toBe(0);
		expect(JSON.parse(passed.stdout)).toMatchObject({ ok: true, none: true });
	});

	it("renders a block refusal reason first, quoting the line, then the block's shape", () => {
		const refused = run(
			["block", "--tracker", TRACKER, "--shape-only"],
			"send the reply",
		);
		expect(refused.status).toBe(1);
		expect(JSON.parse(refused.stdout).message).toBe(
			"- each item is its own `- #N (gist)` line — read: `send the reply`\n\nThe shape: one `- #N (what to do)` line per item, each citing an open issue, or the single line `nothing`.",
		);
	});

	it("answers has-line on stdout, never by exit code, skipping a fenced marker as the line parser does (#1247, #1255)", () => {
		const answer = (text: string) => {
			const r = run(["has-line"], text);
			expect(r.status).toBe(0);
			return r.stdout;
		};
		expect(answer("Done.\n**Outstanding:** none")).toBe("yes\n");
		expect(answer("The form:\n```\n**Outstanding:** none\n```")).toBe("no\n");
		expect(answer("Closing.")).toBe("no\n");
	});

	it("passes a fail-open, leaving the record to the bash caller", () => {
		process.env.WFC_GH = stubGhScript(dir, GH_FAILING_SCRIPT, {
			failing: true,
		}).gh;
		const r = run(
			["outstanding", "--tracker", TRACKER, "--self", "9"],
			"**Outstanding:** #5 (a)",
		);
		expect(r.status).toBe(0);
		expect(JSON.parse(r.stdout).unchecked[0]).toMatch(/GitHub unreachable/);
	});
});

describe("canonicalRef", () => {
	it("reads each ref spelling as the item's full ref, and anything else as null", async () => {
		const { canonicalRef } = await load();
		expect(canonicalRef("#31", TRACKER)).toBe("o/here#31");
		expect(canonicalRef("Here#31", TRACKER)).toBe("o/here#31");
		expect(canonicalRef("O/There#2", TRACKER)).toBe("o/there#2");
		for (const bad of ["31", "#31,", "the reply", "#0"])
			expect(canonicalRef(bad, TRACKER)).toBe(null);
	});
});

describe("the readers' shared tests (#1247)", () => {
	it("reads `nothing` in any letter case, as the block grammar does", async () => {
		const { isNothing } = await load();
		for (const line of ["nothing", "Nothing.", " NOTHING "])
			expect(isNothing(line), line).toBe(true);
		for (const line of ["nothing urgent", "- nothing"])
			expect(isNothing(line), line).toBe(false);
		expect((await shape("Nothing", "block")).ok).toBe(true);
	});

	it("names a sha only for hex holding a digit and a letter, standing alone", async () => {
		const { hasSha } = await load();
		for (const text of ["Fixed in 605c04ec.", "(3ce545d2)", "`0d0aea71`"])
			expect(hasSha(text), text).toBe(true);
		for (const text of [
			"the cafebabe was defaced",
			"run 12345678",
			"session 182bfe06-7681-406e-a5d6-3bc73a946663",
			"x605c04ec",
		])
			expect(hasSha(text), text).toBe(false);
	});

	it("lower-cases the tracker, as an item's owner and repo are", async () => {
		expect((await load()).trackerOf("O/Here")).toBe("o/here");
	});
});
