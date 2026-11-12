// @vitest-environment node
/*
 * scripts/burn-off-sessions.js moves each live session on a model only burn
 * mode uses back to its standard model at `burn-mode.sh off` (#4992). A red
 * here means a session is left routed away reported as moved, or one is
 * resumed that should not be. The routing is the fixture's, whose routed-away
 * model is its `sonnet`.
 */
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { moveOne } from "./burn-off-sessions.js";

const FIXTURE = path.resolve(__dirname, "fixtures/model-routing/fixture.json");
beforeEach(() => {
	vi.stubEnv("WFC_MODEL_ROUTING", FIXTURE);
});

const S = {
	seat: "/h/.claude2",
	sessionId: "s1",
	cwd: "/w",
	name: "Implement 1",
	model: "test-sonnet-1[1m]",
};

function how(failed: string | null = null, extra = {}) {
	const out: string[] = [];
	const err: string[] = [];
	const calls: unknown[][] = [];
	return {
		out,
		err,
		calls,
		ctx: {
			dryRun: false,
			self: "me",
			resume: () => ({
				resumeOwnId: (...args: unknown[]) => {
					calls.push(args);
					return { failed } as never;
				},
			}),
			out: (l: string) => out.push(l),
			err: (l: string) => err.push(l),
			...extra,
		},
	};
}

describe("moveOne", () => {
	it("resumes the session under its own id in its own directory", () => {
		const h = how();
		expect(moveOne(S, h.ctx)).toBe(true);
		expect(h.calls[0]?.[0]).toEqual({
			root: "/w",
			seat: "/h/.claude2",
			issues: [],
		});
		expect(h.calls[0]?.[2]).toEqual({ sessionId: "s1", cwd: "/w" });
		expect(h.out).toEqual([
			"moved to the standard model: Implement 1 (/h/.claude2)",
		]);
	});

	it("reports a failed resume as still routed away", () => {
		const h = how("its job not confirmed stopped");
		expect(moveOne(S, h.ctx)).toBe(false);
		expect(h.err[0]).toContain("not moved: its job not confirmed stopped");
	});

	it("never resumes itself, one with no directory, or anything on a dry run", () => {
		for (const [s, extra] of [
			[{ ...S, sessionId: "me" }, {}],
			[{ ...S, cwd: "" }, {}],
			[S, { dryRun: true }],
		] as const) {
			const h = how(null, extra);
			moveOne(s, h.ctx);
			expect(h.calls).toEqual([]);
		}
	});
});
