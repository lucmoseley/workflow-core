// @vitest-environment node

/*
 * scripts/alarm-notice.js (#4939), the program: its config read, its
 * environment and its fetch adapter, against a local server standing in for
 * GitHub's API, in a throwaway checkout holding its own config. The judging
 * is lib/alarm-notice.test.ts's.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeGitHub } from "./lib/alarm-notice-testkit";
import { ROOT } from "./lib/precommit-gate-testkit";
import { runInProcessAsync } from "./lib/run-in-process.js";

const SCRIPT = path.join(ROOT, "scripts/alarm-notice.js");
let tmp: string;

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "alarm-notice-"));
	spawnSync("git", ["init", "-q", tmp]);
	fs.mkdirSync(path.join(tmp, ".claude"));
	fs.writeFileSync(
		path.join(tmp, ".claude/workflow-core.json"),
		JSON.stringify({
			contract: 1,
			founder: "F",
			codeRepo: "o/code",
			founderNotice: { workflow: "w.yml", repo: "o/tracker", mention: "fdr" },
		}),
	);
});

afterEach(() => {
	fs.rmSync(tmp, { recursive: true, force: true });
});

const run = (env: Record<string, string>) =>
	runInProcessAsync(SCRIPT, [], {
		cwd: tmp,
		env: { PATH: process.env.PATH ?? "", CLAUDE_PROJECT_DIR: tmp, ...env },
	});

describe("alarm-notice.js", () => {
	it("reads the code repo and the login from its checkout's config, and posts its notice to the tracker", async () => {
		const gh = fakeGitHub("o/code", "o/tracker", 7);
		gh.state.runs["queue-wait.yml"] = [["failure", 1]];
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
			const out = await run({
				GITHUB_API_URL: `http://127.0.0.1:${port}`,
				GITHUB_REPOSITORY: "o/tracker",
				GH_TOKEN: "tok",
				NOTICE_ISSUE: "7",
			});
			expect(out.status).toBe(0);
			expect(seen).toContain(
				"POST /repos/o/tracker/issues/7/comments Bearer tok",
			);
			expect(gh.state.comments[0]?.body).toMatch(
				/^@fdr `Queue ref waiting 2h` is red on o\/code/,
			);
		} finally {
			server.close();
		}
	});

	it("fails as broken without an issue to post on, naming what it needs", async () => {
		const out = await run({ GITHUB_REPOSITORY: "o/tracker" });
		expect(out.status).toBe(2);
		expect(out.stdout).toContain(
			"::error title=Notice broken::Needs `codeRepo` and `founderNotice` in .claude/workflow-core.json, GITHUB_REPOSITORY, and NOTICE_ISSUE as an issue number.",
		);
	});
});
