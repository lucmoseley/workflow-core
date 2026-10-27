// @vitest-environment node
/*
 * guard-push-rules.js states the push rules before a push rather than after
 * one (mantahostels#1648, spec mantahostels#1762), with the review warn
 * ahead of them (#1163). These are its boundary cases, run as the harness runs
 * it: the payload, the host's own files, the rule store, the latch and the
 * review adapter, end to end. Which push is handed which rule is
 * lib/push-rules.test.ts's; each premise's read is lib/push-rules-host.test.ts's;
 * the adapter's answers are push-review-owed.test.ts's (#2785).
 *
 * It runs as a `PreToolUse` Bash hook and is the only route by which the push
 * rules reach a session before it pushes: break it and a session pushes
 * unattested or unreviewed commits unwarned; make it deny and every push is
 * wedged.
 */

import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFailOpenLog } from "./guard-log-fixture";
import { defineTemplate, mkScratchDir, trioTemplate } from "./lib/git-fixture";
import {
	buildBashPayload,
	guardOutput,
	spawnGuard,
} from "./lib/pretool-guard-testkit";
import { code, ME, PAST_FLOOR, reviewFixture } from "./lib/push-review-fixture";

const GUARD = path.resolve(__dirname, "guard-push-rules.js");
const { readRuleText } = require("./lib/rule-text") as {
	readRuleText: (id: string) => string;
};
const { readRuleCap } = require("./lib/rule-emission") as {
	readRuleCap: () => number;
};

/* push-cadence's headline less the command it names, which a fixture host
 * spells as its own or the plugin default (#814). */
const CADENCE = "FINDS EVERY COMMIT BEING PUSHED ATTESTED";
const SWEEP = "on:\n  schedule:\n    - cron: '0 */6 * * *'\n";

/** The whole hook output for `command` run in `cwd`. Null where it said
 *  nothing. */
const emission = (
	at: { shared: string; config: string },
	command: string,
	{
		session = "test",
		cwd = at.shared,
		env = {},
	}: {
		session?: string;
		cwd?: string;
		env?: Record<string, string | undefined>;
	} = {},
) =>
	guardOutput(GUARD, buildBashPayload(command, session), {
		project: at.shared,
		config: at.config,
		cwd,
		env,
	});

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

	/** A host meeting every rule's premise (#742). */
	const fullHost = (modules = ["suites"]) => {
		write(
			".claude/workflow-core.json",
			JSON.stringify({
				contract: 1,
				modules,
				commands: {
					test: "npm run test",
					typecheck: "npm run typecheck",
					check: "npm run check",
					push_check: "npm run push:check",
				},
				deploy: "vercel",
			}),
		);
		write(
			"package.json",
			JSON.stringify({ scripts: { test: "node scripts/run-vitest.js" } }),
		);
		write(".github/workflows/scheduled-checks.yml", SWEEP);
	};
	const offSuite = { WFC_MODULES: undefined };

	it("hands a host meeting every premise all four rules, cadence first, under the cap, refusing nothing", () => {
		fullHost();
		const out = emission(at, "git push origin main", { env: offSuite });
		expect(out.permissionDecision).toBeUndefined();
		const ctx = out.additionalContext as string;
		for (const id of [
			"push-cadence",
			"push-green-suite",
			"vercel-build-on-push",
			"ci-status-lag",
		])
			expect(ctx).toContain(readRuleText(id));
		expect(ctx.indexOf(CADENCE)).toBeLessThan(
			ctx.indexOf("A PUSH WARNS UNLESS"),
		);
		// The cap is BYTES, and all four fragments are multibyte.
		expect(Buffer.byteLength(ctx, "utf8")).toBeLessThan(readRuleCap());
	});

	it("hands the -landing twins with the landing module on (#2409)", () => {
		fullHost(["suites", "landing"]);
		const ctx = emission(at, "git push origin main:landing", { env: offSuite })
			.additionalContext as string;
		expect(ctx).toContain("PUSH TO `landing` ONCE THE TESTS YOU TOUCHED PASS");
		expect(ctx).toContain("IS TESTED BY THE LANDER");
		// No push owes a certificate under landing (#2929).
		expect(ctx).not.toMatch(/WARNS UNLESS|ATTESTED|push:check/);
		expect(ctx).not.toContain("THIS PUSH DOES NOT TRIGGER");
		expect(Buffer.byteLength(ctx, "utf8")).toBeLessThan(readRuleCap());
	});

	it("tells a bare host nothing it lacks, the recipe naming the plugin's own push check (#814)", () => {
		const ctx = emission(at, "git push origin main", {
			session: "bare",
			env: offSuite,
		}).additionalContext as string;
		expect(ctx).toContain(CADENCE);
		expect(ctx).toContain("/scripts/push-check.js` FINDS");
		expect(ctx).not.toMatch(
			/Vercel|next build|sweep|npm run|check:ci|\{command:/,
		);
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

	it("a held-back rule stays unlatched, so the session is told once the host meets it", () => {
		emission(at, "git push origin main", { session: "s", env: offSuite });
		fullHost();
		const ctx = emission(at, "git push origin main", {
			session: "s",
			env: offSuite,
		}).additionalContext as string;
		expect(ctx).toContain(readRuleText("vercel-build-on-push"));
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
		// No session id is no latch key, so an injection would repeat on every call.
		const r = spawnGuard(
			GUARD,
			buildBashPayload("git push origin main", null),
			{
				project: at.shared,
				config: at.config,
				cwd: at.shared,
			},
		);
		expect(r.status).toBe(0);
		expect(r.stdout ?? "").toBe("");
		expect(readFailOpenLog(at.config, at.shared)).toMatch(
			/no session_id in payload/,
		);
	});

	it("refuses the call as JSON on exit 0 when a fragment cannot be read, naming the rule (mantahostels#1762)", () => {
		const r = spawnGuard(
			GUARD,
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
