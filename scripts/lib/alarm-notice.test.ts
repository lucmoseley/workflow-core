// @vitest-environment node

/*
 * lib/alarm-notice.js (#4939), against lib/alarm-notice-testkit.ts's fake
 * GitHub. Break this and a stall reaches the founder hourly, or never once
 * the machine is down.
 */

import { describe, expect, it } from "vitest";
import { runNotice } from "./alarm-notice.js";
import { at, fakeGitHub } from "./alarm-notice-testkit";

const CODE = "o/code";
const TRACKER = "o/tracker";
const ISSUE = 9;
const deps = {
	codeRepo: CODE,
	noticeRepo: TRACKER,
	issue: ISSUE,
	mention: "founder",
};

const harness = () => {
	const { state, get, post } = fakeGitHub(CODE, TRACKER, ISSUE);
	const notice = async () => {
		const said: string[] = [];
		const code = await runNotice({
			...deps,
			get,
			post,
			say: (l) => said.push(l),
		});
		return { code, out: said.join("\n") };
	};
	return { state, notice };
};

describe("lib/alarm-notice.js", () => {
	it("mentions the founder once for a red alarm, naming it and linking its run", async () => {
		const { state, notice } = harness();
		state.runs["landing-quiet.yml"] = [
			["failure", 1],
			["success", 2],
		];
		const r = await notice();
		expect(r.code).toBe(0);
		expect(state.comments).toHaveLength(1);
		expect(state.comments[0]?.body).toMatch(
			/^@founder `Landing quiet 14h` is red on o\/code, run https:\/\/github\.com\/o\/code\/actions\/runs\/1\./,
		);
		expect(state.comments[0]?.body).toContain(
			"<!-- alarm-notice:landing-quiet.yml -->",
		);
	});

	it("stays silent on a second red with no green between, for each alarm", async () => {
		const { state, notice } = harness();
		state.runs["landing-quiet.yml"] = [["failure", 2]];
		state.runs["queue-wait.yml"] = [["failure", 2]];
		state.clock = 1.5;
		await notice();
		expect(state.comments).toHaveLength(2);
		state.runs["landing-quiet.yml"].unshift(["failure", 1]);
		state.runs["queue-wait.yml"].unshift(["failure", 0.5], ["cancelled", 1]);
		state.clock = 0;
		const r = await notice();
		expect(state.comments).toHaveLength(2);
		expect(r.out).toContain("already noticed since its last green");
	});

	it("mentions again once the alarm has passed and failed anew", async () => {
		const { state, notice } = harness();
		state.runs["queue-wait.yml"] = [["failure", 4]];
		state.clock = 3.5;
		await notice();
		state.runs["queue-wait.yml"] = [
			["failure", 1],
			["success", 2],
			["failure", 4],
		];
		state.clock = 0;
		await notice();
		expect(state.comments).toHaveLength(2);
		expect(state.comments[1]?.body).toContain(
			"`Queue ref waiting 2h` is red on o/code, run https://github.com/o/code/actions/runs/1.",
		);
	});

	it("posts nothing on a green, a cancelled-only or an empty run list", async () => {
		const { state, notice } = harness();
		state.runs["landing-quiet.yml"] = [
			["success", 1],
			["failure", 2],
		];
		state.runs["queue-wait.yml"] = [["cancelled", 1]];
		const r = await notice();
		expect(r.code).toBe(0);
		expect(state.comments).toHaveLength(0);
	});

	it("ignores a notice-shaped comment someone other than the bot wrote", async () => {
		const { state, notice } = harness();
		state.runs["landing-quiet.yml"] = [["failure", 1]];
		state.comments.push({
			created_at: at(0.5),
			body: "<!-- alarm-notice:landing-quiet.yml -->",
			user: { login: "founder" },
		});
		await notice();
		expect(state.comments).toHaveLength(2);
	});

	it("fails as broken, posting nothing, where a run list will not read", async () => {
		const said: string[] = [];
		const code = await runNotice({
			...deps,
			get: async () => ({}),
			post: async () => {
				throw new Error("no post expected");
			},
			say: (l) => said.push(l),
		});
		expect(code).toBe(2);
		expect(said.join("\n")).toContain(
			"::error title=Notice broken::no run list for landing-quiet.yml",
		);
	});

	it("fails as broken, posting nothing, where the comments run past the page cap", async () => {
		const posted: unknown[] = [];
		const page = Array.from({ length: 100 }, () => ({
			created_at: at(0),
			body: "",
			user: { login: "someone" },
		}));
		const said: string[] = [];
		const code = await runNotice({
			...deps,
			get: async (p) =>
				p.includes("/actions/workflows/")
					? {
							workflow_runs: [
								{
									id: 1,
									conclusion: "failure",
									updated_at: at(1),
									html_url: "u",
								},
							],
						}
					: page,
			post: async (_p, b) => posted.push(b),
			say: (l) => said.push(l),
		});
		expect(code).toBe(2);
		expect(posted).toEqual([]);
		expect(said.join("\n")).toContain("more than 10 pages of comments");
	});
});
