// @vitest-environment node
/*
 * The `landing` module on an adopter, against lib/lander-testkit.ts's real
 * bare remote and clone (#4485's adopter release, spec #4458): its
 * `.claude/workflow-core.json` turns the module on or leaves it off, and
 * every module read here is that file's, the suite's WFC_MODULES cleared.
 *
 * On, with no `landingTester` named, the queue lander's tester is the local
 * one (lib/local-tester.js), running the adopter's `commands.test` at each
 * sha. The lander run is driven in process through lib/queue-lander.js's
 * runQueueLander over the production adapters queue-lander.js wires, the
 * local tester's suite slot aside: the real one admits against this machine's
 * suite gate and memory, which the suite running this test holds.
 *
 * Loosen it and an adopter's queue ref never lands through its local tester,
 * a red member's isolation runs beside another's or the red one lands, or,
 * with the module off, a push to `main` is refused by the pre-push hook or
 * the publish guard, or a queue or landing rule reaches the session.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { renderSessionRules } from "./lib/adopter-skeleton.js";
import { runEventCores } from "./lib/guard-core-testkit";
import {
	fileLedger,
	heartbeatWriter,
	landerLock,
	queueLanderFiles,
} from "./lib/lander-files.js";
import {
	commit,
	git,
	landerSandbox,
	markers,
	remote,
	tmp,
	work,
} from "./lib/lander-testkit";
import { localTester } from "./lib/local-tester.js";
import { buildBashPayload } from "./lib/pretool-guard-testkit";
import { runQueueLander } from "./lib/queue-lander.js";
import {
	batchRecord,
	dropRecord,
	queueGit,
	queueLogger,
	verdictLedger,
} from "./lib/queue-lander-adapters.js";
import { logEnqueue, queueLogFile } from "./lib/queue-log.js";
import { readRuleText } from "./lib/rule-text.js";
import { readConfig } from "./lib/workflow-core-config.js";

landerSandbox();

const ROOT = path.resolve(__dirname, "..");
const RULES = path.resolve(__dirname, "..", "docs", "agents", "rules");

/* The queue's and landing's rule fragments: what a host with the module off
 * is never handed. */
const QUEUE_RULES = fs
	.readdirSync(RULES)
	.filter((f) => /^(?:queue|landing)-|-landing\.txt$/.test(f))
	.map((f) => f.replace(/\.txt$/, ""));

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

/** `main` made an adopter's: its config, `modules` on, committed and pushed. */
const adopt = (modules: string[]) => {
	vi.stubEnv("WFC_MODULES", undefined);
	write(
		".claude/workflow-core.json",
		JSON.stringify({
			contract: 1,
			modules,
			commands: { test: "node run.js" },
		}),
	);
	write("run.js", RUNNER);
	write(".gitignore", ".claude/worktrees/\n.claude/tmp/\nnode_modules/\n");
	const sha = commit("adopter");
	git(work, "push", "-q", "origin", "HEAD:main");
	return sha;
};

/** A commit on `from` adding `<name>.check.js` as `check`, pushed as `queue/<name>`. */
const pushQueue = (name: string, from: string, check: string) => {
	git(work, "checkout", "-q", "--detach", from);
	write(`${name}.check.js`, check);
	const sha = commit(name);
	git(work, "push", "-q", "origin", `${sha}:refs/heads/queue/${name}`);
	return sha;
};

/** One suite slot, recording how many are held at once at its peak. */
const oneSlot = () => {
	const slots = { held: 0, peak: 0, admitted: 0 };
	return {
		slots,
		admit: async () => {
			slots.held += 1;
			slots.admitted += 1;
			slots.peak = Math.max(slots.peak, slots.held);
			return {
				ok: true as const,
				spawned: () => undefined,
				release: () => {
					slots.held -= 1;
				},
			};
		},
	};
};

/** A tracker filing each drop's fix ticket as #101 on, refusing a base red. */
const fakeTracker = () => {
	const filed: string[] = [];
	return {
		filed,
		tracker: {
			fileDropTicket: (d: { name: string }) => {
				filed.push(d.name);
				return `#${100 + filed.length}`;
			},
			fileBaseRed: () => {
				throw new Error("no base red on this fixture");
			},
			stateOf: () => "open" as const,
		},
	};
};

/** One lander run over the adopter's local tester, as queue-lander.js wires it. */
const runAdopterLander = async (admit: ReturnType<typeof oneSlot>["admit"]) => {
	const files = queueLanderFiles(work);
	const { tracker, filed } = fakeTracker();
	const lines: string[] = [];
	await runQueueLander({
		git: queueGit(work),
		tester: localTester({ root: work, admit }),
		ledger: fileLedger(files.ledger),
		verdicts: verdictLedger(files.verdicts),
		record: batchRecord(files.batch),
		drops: dropRecord(files.drops),
		tracker,
		logQueue: queueLogger(work),
		lock: landerLock(work),
		beat: heartbeatWriter(files.heartbeat),
		now: Date.now,
		say: (line: string) => lines.push(line),
	});
	return { files, filed, lines };
};

const remoteHeads = () =>
	git(remote, "for-each-ref", "--format=%(refname)", "refs/heads/");

describe("with the landing module on and the local tester", () => {
	it("lands a session's queue ref on main through the local tester", async () => {
		const base = adopt(["landing"]);
		expect(readConfig({ root: work, quiet: true }).modules).toContain(
			"landing",
		);
		expect(readConfig({ root: work, quiet: true }).landingTester).not.toBe(
			"actions",
		);
		const a = pushQueue("a", base, "");
		const { admit, slots } = oneSlot();

		const { files } = await runAdopterLander(admit);

		expect(git(remote, "rev-parse", "main")).toBe(a);
		expect(remoteHeads()).not.toContain("refs/heads/queue/");
		expect(fs.readFileSync(files.ledger, "utf8")).toContain(a);
		expect(slots.admitted).toBeGreaterThan(0);
	});

	it("isolates a red member serially under the one slot, dropping it and landing the green one", async () => {
		const base = adopt(["landing"]);
		const a = pushQueue("a", base, "");
		const b = pushQueue("b", base, "throw new Error('red')");
		fs.mkdirSync(markers(), { recursive: true });
		const log = queueLogFile(work);
		const at = Date.now();
		logEnqueue(log, { ref: "refs/heads/queue/a", sha: a, at: at - 2000 });
		logEnqueue(log, { ref: "refs/heads/queue/b", sha: b, at: at - 1000 });
		const { admit, slots } = oneSlot();

		const { files, filed } = await runAdopterLander(admit);

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
		expect(slots.peak).toBe(1);
		expect(slots.admitted).toBeGreaterThan(isolations.length);
		const [drop, ...more] = JSON.parse(fs.readFileSync(files.drops, "utf8"));
		expect(more).toEqual([]);
		expect(drop).toMatchObject({
			name: "b",
			sha: b,
			ref: "dropped/b",
			cause: { kind: "red" },
		});
		expect(filed).toEqual(["b"]);
	});
});

describe("with the landing module off", () => {
	const told = (text: string) => {
		for (const id of QUEUE_RULES) {
			expect(text).not.toContain(readRuleText(id, ROOT));
			expect(text).not.toContain(`rule:${id}`);
		}
		expect(text).not.toContain("queue/");
	};

	it("passes a push to main through the pre-push hook, and hands no queue rule", () => {
		const base = adopt([]);
		expect(QUEUE_RULES).toEqual(
			expect.arrayContaining(["queue-ref", "landing-rewind"]),
		);
		const hooks = path.join(tmp, "hooks");
		fs.mkdirSync(hooks);
		fs.writeFileSync(
			path.join(hooks, "pre-push"),
			`#!/bin/sh\nexec sh ${JSON.stringify(path.join(ROOT, ".husky", "pre-push"))} "$@"\n`,
		);
		fs.chmodSync(path.join(hooks, "pre-push"), 0o755);
		git(work, "config", "core.hooksPath", hooks);
		write("next.txt", "next");
		const sha = commit("next");
		const env: NodeJS.ProcessEnv = { ...process.env, WFC_PLUGIN_ROOT: ROOT };
		delete env.WFC_MODULES;
		delete env.CLAUDE_PROJECT_DIR;

		const pushed = spawnSync("git", ["push", "origin", "HEAD:main"], {
			cwd: work,
			env,
			encoding: "utf8",
		});

		expect(pushed.status, pushed.stderr).toBe(0);
		expect(git(remote, "rev-parse", "main")).toBe(sha);
		expect(sha).not.toBe(base);
		told(pushed.stderr);
	});

	it("passes a push to main through the publish guard and every PreToolUse core, handing no queue rule", () => {
		adopt([]);
		for (const command of [
			"git push origin HEAD:main",
			"git push origin main",
			"git commit -qm next",
		]) {
			const { output } = runEventCores(buildBashPayload(command, "s1"), {
				root: work,
			});
			expect(output?.permissionDecision ?? "allow", command).not.toBe("deny");
			told(JSON.stringify(output ?? {}));
		}
		told(
			renderSessionRules({
				modules: readConfig({ root: work, quiet: true }).modules,
				founder: "A Founder",
				pluginRoot: ROOT,
				ciCheck: null,
			}),
		);
	});
});
