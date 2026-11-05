// @vitest-environment node
/*
 * The `landing` module on an adopter, against lib/lander-testkit.ts's real
 * bare remote and clone: its `.claude/workflow-core.json` turns the module on
 * or leaves it off, and every module read here is that file's, the suite's
 * WFC_MODULES cleared. Each push runs the adopter's pre-push hook, the
 * plugin's `.husky/pre-push`, as an adopter's `core.hooksPath` runs it.
 *
 * On, with no `landingTester` named, the queue lander's tester is the local
 * one (lib/local-tester.js), running the adopter's `commands.test` at each
 * sha. The lander run is driven in process through lib/queue-lander-deps.js,
 * the wiring scripts/queue-lander.js runs, over the stub tracker and the
 * levelling stub, the local tester's suite slot aside: the real one admits
 * against this machine's suite gate and memory, which the suite running this
 * test holds.
 *
 * Over the 10 s budget, as each push crosses the real pre-push hook and each
 * lander test the local tester's real install and run in its worktree: the
 * two routes it holds an adopter to.
 *
 * Loosen it and an adopter's queue ref never lands through its local tester,
 * a red member's isolation runs beside another's or the red one lands, or,
 * with the module off, a push to `main` is refused by the pre-push hook or
 * the publish guard, or a hook hands the session text naming the queue.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { renderSessionRules } from "./lib/adopter-skeleton.js";
import { runEventCores, toolCall } from "./lib/guard-core-testkit";
import { queueLanderFiles } from "./lib/lander-files.js";
import {
	commit,
	git,
	landerSandbox,
	levelled,
	levelStub,
	remote,
	stubTracker,
	tmp,
	work,
} from "./lib/lander-testkit";
import { buildBashPayload } from "./lib/pretool-guard-testkit";
import { projectSlug } from "./lib/project-slug.js";
import { runQueueLander } from "./lib/queue-lander.js";
import { buildLanderDeps } from "./lib/queue-lander-deps.js";
import { queueLogFile } from "./lib/queue-log.js";
import { readRuleText } from "./lib/rule-text.js";
import { readStopGuardBlock } from "./lib/stop-guard-testkit";
import { admitted, peakHeld } from "./lib/suite-slot-fake";
import { readConfig } from "./lib/workflow-core-config.js";

landerSandbox();

const ROOT = path.resolve(__dirname, "..");
/* The store an adopter's fragments resolve to: the plugin's own. */
const RULES = path.resolve(__dirname, "..", "docs", "agents", "rules");

/* The text naming the queue: a queue ref, the queue lander, or a ref it
 * alone writes. */
const QUEUE_TEXT = /queue ref|queue\/|queue lander|lander\/|dropped\//;

/* A runner that runs each `*.check.js` the tree holds and prints vitest's
 * FAIL line for each one that throws. */
const RUNNER = `const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
let red = false;
for (const f of process.argv.slice(2).length ? process.argv.slice(2) : fs.readdirSync(".").filter((n) => n.endsWith(".check.js"))) {
	if (!fs.existsSync(f)) continue;
	try { execFileSync("node", [f], { stdio: "ignore" }); console.log(" ✓ " + f); }
	catch { red = true; console.log(" FAIL  " + f + " > it fails"); }
}
process.exit(red ? 1 : 0);
`;

const write = (rel: string, text: string) => {
	fs.mkdirSync(path.dirname(path.join(work, rel)), { recursive: true });
	fs.writeFileSync(path.join(work, rel), text);
};

/* The environment a push runs its hooks in: the plugin's, and no session's. */
const pushEnv = () => {
	const env: NodeJS.ProcessEnv = { ...process.env, WFC_PLUGIN_ROOT: ROOT };
	delete env.WFC_MODULES;
	delete env.CLAUDE_PROJECT_DIR;
	return env;
};

const push = (refspec: string) =>
	spawnSync("git", ["push", "origin", refspec], {
		cwd: work,
		env: pushEnv(),
		encoding: "utf8",
	});

const adopt = (modules: string[]) => {
	vi.stubEnv("WFC_MODULES", undefined);
	write(
		".claude/workflow-core.json",
		JSON.stringify({
			contract: 1,
			modules,
			tracker: "o/here",
			commands: { test: "node run.js" },
		}),
	);
	write("run.js", RUNNER);
	write(".gitignore", ".claude/worktrees/\n.claude/tmp/\nnode_modules/\n");
	const sha = commit("adopter");
	git(work, "push", "-q", "origin", "HEAD:main");
	const hooks = path.join(tmp, "hooks");
	fs.mkdirSync(hooks, { recursive: true });
	fs.writeFileSync(
		path.join(hooks, "pre-push"),
		`#!/bin/sh\nexec sh ${JSON.stringify(path.join(ROOT, ".husky", "pre-push"))} "$@"\n`,
	);
	fs.chmodSync(path.join(hooks, "pre-push"), 0o755);
	git(work, "config", "core.hooksPath", hooks);
	return sha;
};

const pushQueue = (name: string, from: string, check: string) => {
	git(work, "checkout", "-q", "--detach", from);
	write(`${name}.check.js`, check);
	const sha = commit(name);
	const pushed = push(`${sha}:refs/heads/queue/${name}`);
	expect(pushed.status, pushed.stderr).toBe(0);
	return sha;
};

/** One lander run over the adopter's configured tester, as queue-lander.js wires it. */
const runAdopterLander = async () => {
	const { gh, readStore } = stubTracker();
	vi.stubEnv("WFC_GH", gh.env.WFC_GH);
	vi.stubEnv("WFC_LEVEL_MAIN_SCRIPT", levelStub());
	vi.stubEnv("CLAUDE_PROJECT_DIR", work);
	const slot = admitted();
	await runQueueLander(
		buildLanderDeps(work, { admit: slot.admit, say: () => undefined }),
	);
	return { files: queueLanderFiles(work), slot, readStore };
};

/* Every `event` core on one call in `work`, its scratch under the case's:
 * the echo recorder reads the process's TMPDIR, the rest the run's env. */
const cores = (
	payload: Record<string, unknown>,
	event: "PreToolUse" | "PostToolUse" = "PreToolUse",
) => {
	vi.stubEnv("TMPDIR", tmp);
	return runEventCores(payload, { root: work, env: { TMPDIR: tmp }, event })
		.output;
};

const remoteHeads = () =>
	git(remote, "for-each-ref", "--format=%(refname)", "refs/heads/");

const enqueued = () =>
	fs
		.readFileSync(queueLogFile(work), "utf8")
		.trim()
		.split("\n")
		.map((l) => JSON.parse(l))
		.filter((row) => row.event === "enqueue")
		.map((row) => [row.ref, row.sha]);

describe("with the landing module on and the local tester", () => {
	it("lands a session's queue ref on main through the local tester", async () => {
		const base = adopt(["landing"]);
		expect(
			JSON.parse(
				fs.readFileSync(
					path.join(work, ".claude", "workflow-core.json"),
					"utf8",
				),
			),
		).not.toHaveProperty("landingTester");
		const a = pushQueue("a", base, "");
		expect(enqueued()).toEqual([["refs/heads/queue/a", a]]);

		const { files, slot } = await runAdopterLander();

		expect(git(remote, "rev-parse", "main")).toBe(a);
		expect(remoteHeads()).not.toContain("refs/heads/queue/");
		expect(fs.readFileSync(files.ledger, "utf8")).toContain(a);
		expect(slot.log).toContain("hold");
		expect(fs.readFileSync(levelled(), "utf8")).toContain(work);
	});

	it("isolates a red member serially under the one slot, dropping it and landing the green one", async () => {
		const base = adopt(["landing"]);
		const a = pushQueue("a", base, "");
		const b = pushQueue("b", base, "throw new Error('red')");

		const { files, slot, readStore } = await runAdopterLander();

		expect(git(remote, "rev-parse", "main")).toBe(a);
		expect(git(remote, "rev-parse", "dropped/b")).toBe(b);
		expect(remoteHeads()).not.toContain("refs/heads/queue/");
		const isolations = remoteHeads()
			.split("\n")
			.filter((r) => /^refs\/heads\/lander\/iso-\d+$/.test(r));
		expect(isolations).toHaveLength(2);
		for (const iso of isolations) {
			const held = [a, b].filter(
				(m) =>
					spawnSync("git", ["merge-base", "--is-ancestor", m, iso], {
						cwd: remote,
					}).status === 0,
			);
			expect(held).toHaveLength(1);
		}
		expect(peakHeld(slot.log)).toBe(1);
		expect(slot.log.filter((at) => at === "hold").length).toBeGreaterThan(
			isolations.length,
		);
		const [drop, ...more] = JSON.parse(fs.readFileSync(files.drops, "utf8"));
		expect(more).toEqual([]);
		expect(drop).toMatchObject({
			name: "b",
			sha: b,
			ref: "dropped/b",
			cause: { kind: "red" },
		});
		expect(readStore().map((t: { body: string }) => t.body)).toEqual([
			expect.stringContaining("`dropped/b`"),
		]);
	});

	it("refuses a push to main through the pre-push hook and the publish guard", () => {
		const base = adopt(["landing"]);
		write("next.txt", "next");
		commit("next");

		const pushed = push("HEAD:main");

		expect(pushed.status).not.toBe(0);
		expect(pushed.stderr).toContain("the lander's green ledger holds neither");
		expect(git(remote, "rev-parse", "main")).toBe(base);
		const output = cores(buildBashPayload("git push origin HEAD:main"));
		expect(output?.permissionDecision).toBe("deny");
		expect(output?.permissionDecisionReason).toContain(
			readRuleText("branch-publish-landing", work),
		);
	});
});

describe("with the landing module off", () => {
	/* Each fragment naming the queue, as this host's sessions would read it. */
	const queueRules = () =>
		fs
			.readdirSync(RULES)
			.filter((f) => f.endsWith(".txt"))
			.map((f) => f.replace(/\.txt$/, ""))
			.filter((id) => QUEUE_TEXT.test(readRuleText(id, work)));

	const told = (text: string) => {
		for (const id of queueRules()) {
			expect(text).not.toContain(readRuleText(id, work));
			expect(text).not.toContain(`rule:${id}`);
		}
		expect(text).not.toMatch(QUEUE_TEXT);
	};

	it("reads every fragment naming the queue as one", () => {
		adopt([]);
		expect(queueRules()).toEqual(
			expect.arrayContaining([
				"queue-ref",
				"landing-rewind",
				"branch-publish-landing",
				"push-cadence-landing",
				"review-ultra-axis-landing",
			]),
		);
		expect(queueRules()).not.toContain("review-ultra-axis");
	});

	it("passes a push to main through the pre-push hook, its gates run, and names no queue", () => {
		const base = adopt([]);
		write("next.txt", "next");
		const sha = commit("next");

		const pushed = push("HEAD:main");

		expect(pushed.status, pushed.stderr).toBe(0);
		expect(git(remote, "rev-parse", "main")).toBe(sha);
		expect(sha).not.toBe(base);
		expect(pushed.stderr).toContain('SKIP: module "suites" is off');
		expect(pushed.stderr).not.toContain("not checked");
		told(pushed.stderr);
	});

	it("passes a push to main through every PreToolUse core, and no core of any event names the queue", () => {
		adopt([]);
		for (const command of [
			"git push origin HEAD:main",
			"git push origin main",
			"git commit -qm next",
		]) {
			const output = cores(buildBashPayload(command));
			expect(output?.permissionDecision ?? "allow", command).not.toBe("deny");
			told(JSON.stringify(output ?? {}));
		}
		const review = cores(
			toolCall("Skill", { skill: "workflow-core:code-review" }),
		);
		expect(review?.additionalContext).toContain(
			readRuleText("review-ultra-axis", work),
		);
		told(JSON.stringify(review));
		const toWrite = { file_path: path.join(work, "x.md"), content: "x\n" };
		const edit = {
			file_path: path.join(work, "run.js"),
			old_string: "red",
			new_string: "failed",
		};
		const agent = { description: "d", prompt: "p", subagent_type: "Explore" };
		for (const [tool, input] of [
			["Write", toWrite],
			["Edit", edit],
			["Agent", agent],
		] as const)
			told(JSON.stringify(cores(toolCall(tool, input))));
		for (const [tool, input] of [
			["Bash", { command: "git push origin HEAD:main" }],
			["Write", toWrite],
		] as const)
			told(
				JSON.stringify(
					cores(
						toolCall(tool, input, { tool_response: { stdout: "" } }),
						"PostToolUse",
					),
				),
			);
	});

	it("hands no queue text at session start or at a stop with work unpushed", () => {
		adopt([]);
		write("next.txt", "next");
		const sha = commit("next");
		told(
			renderSessionRules({
				modules: readConfig({ root: work, quiet: true }).modules,
				founder: "A Founder",
				pluginRoot: ROOT,
				ciCheck: null,
			}),
		);
		for (const prompt of ["/implement 1", "/code-review"]) {
			const started = spawnSync(
				path.join(ROOT, "scripts", "inject-tracker-docs.sh"),
				{
					input: JSON.stringify({
						session_id: `s-${prompt}`,
						hook_event_name: "SessionStart",
						prompt,
					}),
					env: {
						...process.env,
						CLAUDE_PROJECT_DIR: work,
						CLAUDE_PLUGIN_ROOT: ROOT,
						CLAUDE_JOB_DIR: "",
						CLAUDE_CODE_SESSION_ID: "",
						CLAUDE_CONFIG_DIR: path.join(tmp, "config"),
						TMPDIR: tmp,
						WFC_GH: "false",
						WFC_MODULES: undefined,
					},
					encoding: "utf8",
				},
			);
			expect(started.status, started.stderr).toBe(0);
			expect(started.stdout, prompt).not.toBe("");
			told(started.stdout);
		}
		const config = path.join(tmp, "config");
		const commits = path.join(config, "projects", projectSlug(work), "commits");
		fs.mkdirSync(commits, { recursive: true });
		fs.writeFileSync(path.join(commits, "s-stop.txt"), `${sha}\n`);
		const stop = readStopGuardBlock(
			path.join(ROOT, "scripts", "guard-unpushed-commits.js"),
			{ dir: work, sid: "s-stop", config, message: "result: done." },
		);
		expect(stop?.reason).toContain("push to `origin/main`");
		told(stop?.reason ?? "");
	});
});
