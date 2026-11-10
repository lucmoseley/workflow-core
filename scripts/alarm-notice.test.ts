// @vitest-environment node

/*
 * scripts/alarm-notice.js (#4939), with GitHub's run and comment endpoints
 * stubbed. Break this and a stall reaches the founder hourly, or never once
 * the machine is down.
 */

import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main, runNotice } from "./alarm-notice.js";
import { ROOT } from "./lib/precommit-gate-testkit";
import { runInProcessAsync } from "./lib/run-in-process.js";

afterEach(() => {
	vi.unstubAllEnvs();
});

const CODE = "o/code";
const TRACKER = "o/tracker";
const ISSUE = 9;
const H = 3_600_000;
const NOW = Date.parse("2026-11-10T12:00:00Z");
const at = (hoursAgo: number) => new Date(NOW - hoursAgo * H).toISOString();

type Conclusion = "success" | "failure" | "cancelled";
/* One alarm's finished runs, newest first: [conclusion, hours ago]. */
type Runs = [Conclusion, number][];
type File = "landing-quiet.yml" | "main-lag.yml";
interface Comment {
	created_at: string;
	body: string;
	user: { login: string };
}

/* A fake GitHub holding each alarm's runs and the issue's comments. A post
 * appends one stamped `clock` hours ago, so a later run reads it back. */
function fakeGitHub(code: string, tracker: string, issue: number) {
	const runs: Partial<Record<File, Runs>> = {};
	const comments: Comment[] = [];
	const state = { runs, comments, clock: 0 };
	const commentsPath = `/repos/${tracker}/issues/${issue}/comments`;
	const get = async (p: string): Promise<unknown> => {
		const r = new RegExp(
			`^/repos/${code}/actions/workflows/([\\w.-]+)/runs\\?branch=main&status=completed&per_page=100$`,
		).exec(p);
		if (r)
			return {
				workflow_runs: (runs[r[1] as File] ?? []).map(([conclusion, h], i) => ({
					id: i + 1,
					conclusion,
					updated_at: at(h),
					html_url: `https://github.com/${code}/actions/runs/${i + 1}`,
				})),
			};
		const c = new RegExp(
			`^${commentsPath}\\?per_page=100&page=1(?:&since=([^&]+))?$`,
		).exec(p);
		if (c) {
			const since =
				c[1] === undefined
					? Number.NEGATIVE_INFINITY
					: Date.parse(decodeURIComponent(c[1]));
			return comments.filter((x) => Date.parse(x.created_at) >= since);
		}
		throw new Error(`unstubbed ${p}`);
	};
	const post = async (p: string, body: unknown): Promise<unknown> => {
		if (p !== commentsPath) throw new Error(`unstubbed post ${p}`);
		comments.push({
			created_at: at(state.clock),
			body: (body as { body: string }).body,
			user: { login: "github-actions[bot]" },
		});
		return {};
	};
	return { state, get, post };
}

function harness() {
	const gh = fakeGitHub(CODE, TRACKER, ISSUE);
	const notice = async () => {
		const said: string[] = [];
		const code = await runNotice({
			get: gh.get,
			post: gh.post,
			say: (l) => said.push(l),
			codeRepo: CODE,
			noticeRepo: TRACKER,
			issue: ISSUE,
			mention: "founder",
		});
		return { code, out: said.join("\n") };
	};
	return { ...gh.state, state: gh.state, notice };
}

describe("alarm-notice.js", () => {
	it("mentions the founder once for a red alarm, naming it and linking its run", async () => {
		const h = harness();
		h.runs["landing-quiet.yml"] = [
			["failure", 1],
			["success", 2],
		];
		const r = await h.notice();
		expect(r.code).toBe(0);
		expect(h.comments).toHaveLength(1);
		expect(h.comments[0]?.body).toMatch(
			/^@founder `Landing quiet 14h` is red on o\/code, run https:\/\/github\.com\/o\/code\/actions\/runs\/1\./,
		);
		expect(h.comments[0]?.body).toContain(
			"<!-- alarm-notice:landing-quiet.yml -->",
		);
	});

	it("stays silent on a second red with no green between, for each alarm", async () => {
		const h = harness();
		h.runs["landing-quiet.yml"] = [["failure", 2]];
		h.runs["main-lag.yml"] = [["failure", 2]];
		h.state.clock = 1.5;
		await h.notice();
		expect(h.comments).toHaveLength(2);
		h.runs["landing-quiet.yml"].unshift(["failure", 1]);
		h.runs["main-lag.yml"].unshift(["failure", 0.5], ["cancelled", 1]);
		h.state.clock = 0;
		const r = await h.notice();
		expect(h.comments).toHaveLength(2);
		expect(r.out).toContain("already noticed since its last green");
	});

	it("mentions again once the alarm has passed and failed anew", async () => {
		const h = harness();
		h.runs["main-lag.yml"] = [["failure", 4]];
		h.state.clock = 3.5;
		await h.notice();
		h.runs["main-lag.yml"] = [
			["failure", 1],
			["success", 2],
			["failure", 4],
		];
		h.state.clock = 0;
		await h.notice();
		expect(h.comments).toHaveLength(2);
		expect(h.comments[1]?.body).toContain(
			"`Queue ref waiting 2h` is red on o/code, run https://github.com/o/code/actions/runs/1.",
		);
	});

	it("posts nothing on a green, a cancelled-only or an empty run list", async () => {
		const h = harness();
		h.runs["landing-quiet.yml"] = [
			["success", 1],
			["failure", 2],
		];
		h.runs["main-lag.yml"] = [["cancelled", 1]];
		const r = await h.notice();
		expect(r.code).toBe(0);
		expect(h.comments).toHaveLength(0);
	});

	it("ignores a notice-shaped comment someone other than the bot wrote", async () => {
		const h = harness();
		h.runs["landing-quiet.yml"] = [["failure", 1]];
		h.comments.push({
			created_at: at(0.5),
			body: "<!-- alarm-notice:landing-quiet.yml -->",
			user: { login: "founder" },
		});
		await h.notice();
		expect(h.comments).toHaveLength(2);
	});

	it("fails as broken, posting nothing, where a run list will not read", async () => {
		const said: string[] = [];
		const code = await runNotice({
			get: async () => ({}),
			post: async () => {
				throw new Error("no post expected");
			},
			say: (l) => said.push(l),
			codeRepo: CODE,
			noticeRepo: TRACKER,
			issue: ISSUE,
			mention: "founder",
		});
		expect(code).toBe(2);
		expect(said.join("\n")).toContain(
			"::error title=Notice broken::no run list for landing-quiet.yml",
		);
	});
});

describe("alarm-notice.js through fetch", () => {
	/* Crosses a real socket: the script's own fetch adapter, environment and
	 * config read, against a local server standing in for GitHub's API. */
	it("reads the code repo and the login from config, and posts its notice to the tracker", async () => {
		/* The committed config, which the script reads from its checkout. */
		const { codeRepo, founderNotice } = JSON.parse(
			fs.readFileSync(path.join(ROOT, ".claude/workflow-core.json"), "utf8"),
		);
		const gh = fakeGitHub(codeRepo, "owner/tracker", 7);
		gh.state.runs["main-lag.yml"] = [["failure", 1]];
		const seen: string[] = [];
		const server = http.createServer(async (req, res) => {
			let body = "";
			for await (const chunk of req) body += chunk;
			const url = req.url ?? "";
			seen.push(`${req.method} ${url} ${req.headers.authorization}`);
			res.setHeader("content-type", "application/json");
			try {
				res.end(
					JSON.stringify(
						req.method === "POST"
							? await gh.post(url, JSON.parse(body))
							: await gh.get(url),
					),
				);
			} catch (e) {
				res.statusCode = 404;
				res.end(JSON.stringify({ message: String(e) }));
			}
		});
		await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
		const { port } = server.address() as AddressInfo;
		try {
			const out = await runInProcessAsync(
				path.join(ROOT, "scripts/alarm-notice.js"),
				[],
				{
					cwd: ROOT,
					env: {
						PATH: process.env.PATH,
						CLAUDE_PROJECT_DIR: ROOT,
						GITHUB_API_URL: `http://127.0.0.1:${port}`,
						GITHUB_REPOSITORY: "owner/tracker",
						GH_TOKEN: "tok",
						NOTICE_ISSUE: "7",
					},
				},
			);
			expect(out.status).toBe(0);
			expect(seen).toContain(
				"POST /repos/owner/tracker/issues/7/comments Bearer tok",
			);
			expect(gh.state.comments[0]?.body).toMatch(
				new RegExp(`^@${founderNotice.mention} \`Queue ref waiting 2h\``),
			);
		} finally {
			server.close();
		}
	});

	it("fails as broken without an issue to post on", async () => {
		vi.stubEnv("NOTICE_ISSUE", undefined);
		expect(await main()).toBe(2);
	});
});
