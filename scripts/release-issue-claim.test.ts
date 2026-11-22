// @vitest-environment node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { assert, beforeEach, describe, expect, it } from "vitest";
import { readFailOpenLog } from "./guard-log-fixture";
import {
	AS_ROOT,
	core,
	freshSandbox,
	gitRepo,
	issueClaims,
} from "./lib/arbiter-testkit";
import { keptSpawn } from "./lib/kept-spawn.js";
import {
	buildBashPayload,
	guardOutput,
	readHookLines,
} from "./lib/pretool-guard-testkit";

const SCRIPT = "scripts/release-issue-claim.js";
const LINES = readHookLines("hooks/hooks.json", SCRIPT);
const CHECKOUT = path.resolve(__dirname, "..");

const sb = freshSandbox();

beforeEach(() => {
	gitRepo(sb);
	execFileSync(
		"git",
		["remote", "add", "origin", "https://github.com/owner/repo.git"],
		{ cwd: sb.repo },
	);
	for (const [n, sid] of [
		[646, "s1"],
		[646, "sess-env"],
		[646, "s-other"],
		[12, "s1"],
	] as const)
		issueClaims.claimIssue(n, { sessionId: sid });
});

const ALL = ["12 s1", "646 s-other", "646 s1", "646 sess-env"];

const fire = (
	command: string,
	{
		session = "s1" as string | null,
		stdin,
		env = {},
	}: { session?: string | null; stdin?: string; env?: NodeJS.ProcessEnv } = {},
) =>
	guardOutput(
		"/bin/bash",
		{
			...buildBashPayload(command, session),
			hook_event_name: "PostToolUse",
		},
		{
			project: sb.repo,
			config: sb.home,
			cwd: sb.repo,
			args: ["-c", LINES[0] ?? ""],
			stdin,
			env: { CLAUDE_PLUGIN_ROOT: CHECKOUT, ...env },
		},
	);

const claims = () => {
	const listed = issueClaims.listIssueClaims();
	assert(listed);
	const rows: {
		issue: number;
		sessionId: string;
	}[] = listed.claims;
	return rows.map((c) => `${c.issue} ${c.sessionId}`).sort();
};

const readFaults = () => readFailOpenLog(sb.home, sb.repo);

describe("the registered hook line", () => {
	it("is one line, narrowed by `if: Bash(gh *)`, in the plugin and the self-plugin alike", () => {
		for (const file of ["hooks/hooks.json", "self-plugin/hooks/hooks.json"]) {
			const entries = Object.values(
				JSON.parse(fs.readFileSync(path.join(CHECKOUT, file), "utf8"))
					.hooks as Record<string, { hooks: Record<string, unknown>[] }[]>,
			)
				.flat()
				.flatMap((group) => group.hooks)
				.filter((hook) => String(hook.command).includes(SCRIPT));
			expect(entries).toHaveLength(1);
			expect(entries[0]).toMatchObject({ if: "Bash(gh *)" });
			expect(entries[0]).not.toHaveProperty("args");
		}
	});
});

describe("each exit", () => {
	it("drops the payload's session's claim on the issue, silent on exit 0", () => {
		expect(fire("gh issue close 646")).toBeNull();
		expect(claims()).toEqual(ALL.filter((c) => c !== "646 s1"));
		expect(readFaults()).toBe("");
	});

	it("falls back to CLAUDE_CODE_SESSION_ID where the payload names no session", () => {
		fire("gh issue close 646", {
			session: null,
			env: { CLAUDE_CODE_SESSION_ID: "sess-env" },
		});
		expect(claims()).toEqual(ALL.filter((c) => c !== "646 sess-env"));
	});

	it("drops nothing for an issue of a repo other than the checkout's origin", () => {
		fire("gh issue close https://github.com/someone/elsewhere/issues/12");
		expect(claims()).toEqual(ALL);
	});
});

describe("run by hand (#3556)", () => {
	it("refuses an issue number on exit 1 while its stdin stays open, naming the release command", async () => {
		const child = keptSpawn("fd").spawn("node", [SCRIPT, "646"], {
			cwd: CHECKOUT,
			env: {
				...process.env,
				CLAUDE_PROJECT_DIR: sb.repo,
				CLAUDE_CONFIG_DIR: sb.home,
			},
		});
		let stderr = "";
		child.stderr.on("data", (d) => {
			stderr += d;
		});
		const status = await new Promise((resolve) => {
			const timer = setTimeout(() => {
				child.kill();
				resolve("hung");
			}, 10_000);
			child.on("close", (code) => {
				clearTimeout(timer);
				resolve(code);
			});
		});
		expect(status).toBe(1);
		expect(stderr).toContain(
			"node scripts/session-arbiter.js release-issue <n>",
		);
		expect(claims()).toEqual(ALL);
	});
});

describe("what it fails open on", () => {
	it.skipIf(AS_ROOT)(
		"drops nothing, silent on exit 0, where the arbiter cannot remove the claim, which it logs",
		() => {
			const dir = core.paths.issueClaimsDir();
			fs.chmodSync(dir, 0o555);
			try {
				expect(fire("gh issue close 646")).toBeNull();
			} finally {
				fs.chmodSync(dir, 0o755);
			}
			expect(claims()).toEqual(ALL);
			expect(fs.readFileSync(sb.errorLog(), "utf8")).toContain(
				"release-issue 646",
			);
		},
	);

	it("is silent on a payload carrying no command, and records that it did", () => {
		expect(
			fire("", {
				stdin: JSON.stringify({ session_id: "s1", tool_name: "Bash" }),
			}),
		).toBeNull();
		expect(readFaults()).toMatch(
			/release-issue-claim\.js\t.*no command in payload/,
		);
	});

	it("drops nothing on a payload that is not JSON, and records that it did", () => {
		expect(fire("", { stdin: "not json" })).toBeNull();
		expect(claims()).toEqual(ALL);
		expect(readFaults()).toMatch(
			/release-issue-claim\.js\t.*payload did not parse as JSON/,
		);
	});

	it("drops nothing, exit 0 and silent, where node is not on PATH", () => {
		expect(
			fire("gh issue close 646", { env: { PATH: "/nonexistent" } }),
		).toBeNull();
		expect(claims()).toEqual(ALL);
	});
});
