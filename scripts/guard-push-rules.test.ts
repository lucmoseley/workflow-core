// @vitest-environment node

import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFailOpenLog } from "./guard-log-fixture";
import { seenFrom } from "./lib/core-path-testkit";
import { defineTemplate, mkScratchDir, trioTemplate } from "./lib/git-fixture";
import {
	buildBashPayload,
	dispatchCoreOutput,
	runDispatchCore,
} from "./lib/pretool-guard-testkit";
import { code, ME, PAST_FLOOR, reviewFixture } from "./lib/push-review-fixture";
import { shellQuote } from "./lib/sh-quote.js";

const CORE = "guard-push-rules";
const { readRuleText } = require("./lib/rule-text") as {
	readRuleText: (id: string, root?: string) => string;
};
const { readRuleCap } = require("./lib/rule-emission") as {
	readRuleCap: () => number;
};

const CADENCE = "PUSH YOUR QUEUE REF ONCE THE TESTS YOU TOUCHED PASS";

const emission = (
	at: { shared: string; config: string },
	command: string,
	{
		session = "test",
		agent,
		cwd = at.shared,
		env = {},
	}: {
		session?: string;
		agent?: string;
		cwd?: string;
		env?: Record<string, string | undefined>;
	} = {},
) =>
	dispatchCoreOutput(
		CORE,
		{
			...buildBashPayload(command, session),
			...(agent === undefined ? {} : { agent_id: agent }),
		},
		{
			project: at.shared,
			config: at.config,
			cwd,
			env,
		},
	);

describe("the push rules, end to end", () => {
	const template = defineTemplate(trioTemplate({ worktree: "detach" }));
	let dir: string;
	let at: { shared: string; config: string };

	beforeEach(() => {
		dir = mkScratchDir("push-rules-");
		template.instantiate(dir);
		at = { shared: path.join(dir, "shared"), config: path.join(dir, "config") };
		fs.mkdirSync(at.config);
	});

	afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

	const write = (rel: string, body: string) => {
		fs.mkdirSync(path.dirname(path.join(at.shared, rel)), { recursive: true });
		fs.writeFileSync(path.join(at.shared, rel), body);
	};

	const fullHost = () => {
		write(
			".claude/workflow-core.json",
			JSON.stringify({
				contract: 1,
				commands: {
					test: "npm run test",
					typecheck: "npm run typecheck",
					check: "npm run check",
				},
				deploy: "vercel",
			}),
		);
		write(
			"package.json",
			JSON.stringify({ scripts: { test: "node scripts/run-vitest.js" } }),
		);
	};
	const offSuite = { WFC_MODULES: undefined };

	it("hands a host meeting every premise all three rules, cadence first, under the cap, refusing nothing", () => {
		fullHost();
		const out = emission(at, "git push origin main", { env: offSuite });
		expect(out.permissionDecision).toBeUndefined();
		const ctx = out.additionalContext as string;
		const seenRule = (id: string) =>
			seenFrom(at.shared, () => readRuleText(id, at.shared));
		for (const id of ["push-cadence", "vercel-build-on-push", "ci-status-lag"])
			expect(ctx).toContain(seenRule(id));
		expect(ctx.indexOf(CADENCE)).toBeLessThan(
			ctx.indexOf("IS TESTED BY THE QUEUE LANDER"),
		);
		expect(Buffer.byteLength(ctx, "utf8")).toBeLessThan(readRuleCap());
	});

	it("tells a bare host nothing it lacks, every command placeholder expanded (#814)", () => {
		const ctx = emission(at, "git push origin main", {
			session: "bare",
			env: offSuite,
		}).additionalContext as string;
		expect(ctx).toContain(CADENCE);
		expect(ctx).not.toMatch(/Vercel|next build|\{command:/);
	});

	it("is silent on a session's second push, and speaks to a new session", () => {
		expect(
			emission(at, "git push origin main", { session: "sess-A" }),
		).not.toBeNull();
		expect(
			emission(at, "git push origin main", { session: "sess-A" }),
		).toBeNull();
		expect(
			emission(at, "git push origin main", { session: "sess-B" }),
		).not.toBeNull();
	});

	it("states the rules once an agent, so a subagent's push in a told session is told afresh", () => {
		expect(
			emission(at, "git push origin main", { session: "sess-A" }),
		).not.toBeNull();
		expect(
			emission(at, "git push origin main", { session: "sess-A", agent: "sub" }),
		).not.toBeNull();
		expect(
			emission(at, "git push origin main", { session: "sess-A", agent: "sub" }),
		).toBeNull();
	});

	it("fails open, recorded, on a push whose tree git cannot answer for", () => {
		const broken = path.join(at.shared, "broken");
		fs.mkdirSync(broken);
		fs.writeFileSync(path.join(broken, ".git"), "gitdir: /nonexistent\n");
		expect(
			emission(at, `git -C ${shellQuote(broken)} push origin main`),
		).toBeNull();
		expect(readFailOpenLog(at.config, at.shared)).toMatch(
			/git could not answer for .*broken/,
		);
	});

	it("a held-back rule stays unlatched, so the session is told once the host meets it", () => {
		emission(at, "git push origin main", { session: "s", env: offSuite });
		fullHost();
		const ctx = emission(at, "git push origin main", {
			session: "s",
			env: offSuite,
		}).additionalContext as string;
		expect(ctx).toContain(readRuleText("vercel-build-on-push", at.shared));
		expect(ctx).not.toContain(CADENCE);
	});

	it("hands a push from a linked worktree the rules, and one in another repo nothing", () => {
		expect(
			emission(at, "git push origin main", { cwd: path.join(dir, "wt") }),
		).not.toBeNull();
		expect(
			emission(at, "git push origin main", {
				session: "other",
				cwd: path.join(dir, "elsewhere"),
			}),
		).toBeNull();
	});

	it("hands nothing to a command that is no push", () => {
		expect(emission(at, "git status")).toBeNull();
	});

	it('hands git -C "$W" push, with W unset, the rules, recording no fail-open (#319)', () => {
		expect(
			emission(at, 'git -C "$W" push origin main').additionalContext,
		).toContain(CADENCE);
		expect(readFailOpenLog(at.config, at.shared)).toBe("");
	});

	it("says nothing and logs when the payload carries no session", () => {
		const r = runDispatchCore(
			CORE,
			buildBashPayload("git push origin main", null),
			{
				project: at.shared,
				config: at.config,
				cwd: at.shared,
			},
		);
		expect(r.status).toBe(0);
		expect(r.stdout).toBe("");
		expect(readFailOpenLog(at.config, at.shared)).toMatch(
			/no session_id in payload/,
		);
	});

	it("refuses the call as JSON on exit 0 when a fragment cannot be read, naming the rule (mantahostels#1762)", () => {
		const r = runDispatchCore(
			CORE,
			buildBashPayload("git push origin main", "test"),
			{
				project: at.shared,
				config: at.config,
				cwd: at.shared,
				env: { WFC_RULES_DIR: fs.mkdtempSync(path.join(dir, "store-")) },
			},
		);
		expect(r.status).toBe(0);
		const out = JSON.parse(r.stdout).hookSpecificOutput;
		expect(out.permissionDecision).toBe("deny");
		expect(out.permissionDecisionReason).toContain("push-cadence");
	});
});

describe("the review warn, end to end (#1163)", () => {
	const { f, commitBy } = reviewFixture();
	const warn = "no code review covers";

	it("rides ahead of the rules on the first push carrying unreviewed code, once a session", () => {
		commitBy("scripts/mine.ts", code(PAST_FLOOR));
		const out = emission(f, "git push origin main", { session: ME });
		expect(out.permissionDecision).toBeUndefined();
		const ctx = out.additionalContext as string;
		expect(ctx).toContain(warn);
		expect(ctx).toContain(`fixed point ${f.base}`);
		expect(ctx.indexOf(warn)).toBeLessThan(ctx.indexOf(CADENCE));
		expect(emission(f, "git push origin main", { session: ME })).toBeNull();
	});

	const unresolvedFromWorktree = () =>
		emission(f, 'git -C "$W" push origin main', {
			session: ME,
			cwd: f.worktree,
		}).additionalContext as string;

	it("reads an unresolved push's review in the session's worktree, its HEAD carrying the code", () => {
		commitBy("scripts/mine.ts", code(PAST_FLOOR), ME, f.worktree);
		expect(unresolvedFromWorktree()).toContain(warn);
	});

	it("leaves an unresolved push from a worktree unwarned for code only the main checkout's HEAD carries", () => {
		commitBy("scripts/mine.ts", code(PAST_FLOOR));
		expect(unresolvedFromWorktree()).not.toContain(warn);
	});

	it("warns on a later push whose rules were already said, in a prelude-only envelope", () => {
		expect(
			emission(f, "git push origin main", { session: ME }).additionalContext,
		).not.toContain(warn);
		commitBy("scripts/mine.ts", code(PAST_FLOOR));
		const ctx = emission(f, "git push origin main", { session: ME })
			.additionalContext as string;
		expect(ctx).toContain(warn);
		expect(ctx).not.toContain(CADENCE);
	});
});
