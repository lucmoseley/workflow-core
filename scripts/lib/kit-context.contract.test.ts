// @vitest-environment node
/*
 * The KitContext contract (§G7, #3018): kit-context-fake.ts's
 * kitContextFake against lib/kit-context.js's kitContext, the context `run`
 * and the dispatcher build for every core. A fake drifted from the kit lets every core's module
 * cases pass against a context production never builds.
 *
 * The real side is built at a temp root that holds no config and no latch;
 * nothing it is asked for reaches git.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { KitContext } from "./kit-context.js";
import { kitContextFake } from "./kit-context-fake";
import { readRuleText } from "./rule-text.js";

const { kitContext, sharedReaders } =
	require("./kit-context.js") as typeof import("./kit-context.js");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "kit-contract-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const log = () => undefined;
const real = (payload: Record<string, unknown>): KitContext =>
	kitContext({ root, payload, log }, sharedReaders(root, log));

const PAYLOAD = {
	session_id: "s-contract",
	tool_name: "Bash",
	tool_input: {},
};

const sides: [string, KitContext][] = [
	["the fake", kitContextFake()],
	["the kit", real(PAYLOAD)],
];

const kinds = (ctx: object) =>
	Object.fromEntries(
		Object.entries(ctx)
			.filter(([, v]) => v !== undefined)
			.map(([k, v]) => [k, typeof v]),
	);

describe("kitContextFake against the kit's context (§G7)", () => {
	it("offers the same ports, each of the same kind", () => {
		expect(kinds(kitContextFake())).toEqual(kinds(real(PAYLOAD)));
	});

	it("leaves the walk's cwd unset where the payload carries none", () => {
		expect(kitContextFake().cwd).toBeUndefined();
		expect(real(PAYLOAD).cwd).toBeUndefined();
	});

	describe.each(sides)("%s", (_, ctx) => {
		it("tells no rule and holds no latch on a fresh session", () => {
			expect(ctx.told("anthropic-report")).toBe(false);
			expect(ctx.readLatch("rm-unchecked.0")).toBeNull();
		});

		it("keys the latch on the main session", () => {
			expect(ctx.key).toEqual({
				agent: "main",
				sid: expect.any(String),
			});
			expect(ctx.agent).toBe("");
			expect(ctx.agentLabel).toBe("main");
		});

		it("reads the Bash call's input", () => {
			expect(ctx.tool).toBe("Bash");
			expect(ctx.input).toEqual({});
		});

		it("gives a rule's fragment, and throws on an id the store lacks", () => {
			expect(ctx.ruleText("anthropic-report")).toBe(
				readRuleText("anthropic-report"),
			);
			expect(() => ctx.ruleText("no-such-rule-3018")).toThrow();
		});

		it("spells a core path as text", () => {
			expect(typeof ctx.corePaths("see scripts/claim-issue.js")).toBe("string");
			expect(ctx.scriptPath("claim-issue.js")).toMatch(/claim-issue\.js$/);
			expect(ctx.docPath("agents/rules/x.txt")).toMatch(
				/agents\/rules\/x\.txt$/,
			);
		});
	});

	it("tells an unkeyed payload apart, which the fake is set to by hand", () => {
		const { session_id: _, ...unkeyed } = PAYLOAD;
		expect(real(unkeyed).key).toBeNull();
		expect(kitContextFake({ key: null }).key).toBeNull();
	});
});
