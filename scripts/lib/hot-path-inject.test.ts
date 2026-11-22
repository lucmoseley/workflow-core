// @vitest-environment node
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { freshSandbox } from "./arbiter-testkit";
import {
	runCore,
	runEventCores,
	splitCheckout,
	toolCall,
} from "./guard-core-testkit";
import { readRuleText } from "./rule-text.js";

const { decide } = require("./hot-path-inject.js") as {
	decide: (file: string, ctx: unknown) => unknown;
};

let root: string;

freshSandbox((sb) => {
	root = splitCheckout(path.join(sb.dir, "split")).main;
	const plant = (rel: string, text: string) => {
		fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
		fs.writeFileSync(path.join(root, rel), text);
	};
	plant(
		".claude/settings.json",
		JSON.stringify({
			hooks: {
				PreToolUse: [
					{
						matcher: "Bash",
						hooks: [
							{ type: "command", command: "node scripts/guard-x.js" },
							{
								type: "command",
								command: 'node "$CLAUDE_PROJECT_DIR"/.claude/hooks/guard.mjs',
							},
						],
					},
				],
			},
		}),
	);
	plant("scripts/guard-x.js", "x\n");
	plant(".claude/hooks/guard.mjs", "x\n");
	plant("scripts/ordinary.js", "x\n");
});

const write = (rel: string, top: Record<string, unknown> = {}) =>
	runCore(
		"inject-hot-path-cost",
		toolCall("Write", { file_path: path.join(root, rel), content: "y\n" }, top),
		{ root },
	).output?.additionalContext ?? "";

describe("a write the core sees", () => {
	it("hands §G13 on the first write of a hot-path program, and not on the second", () => {
		expect(write("scripts/guard-x.js")).toBe(readRuleText("hot-path-cost"));
		expect(write("scripts/guard-x.js")).toBe("");
	});

	it("hands it again to a subagent, which never saw its parent's", () => {
		expect(write("scripts/guard-x.js")).not.toBe("");
		expect(write("scripts/guard-x.js", { agent_id: "sub1" })).toBe(
			readRuleText("hot-path-cost"),
		);
	});

	it("hands it on a write to a hot-path program outside scripts/, with no shebang", () => {
		expect(write(".claude/hooks/guard.mjs")).toBe(
			readRuleText("hot-path-cost"),
		);
	});

	it("hands it on a write to a hook registration", () => {
		expect(write(".claude/settings.json")).toBe(readRuleText("hot-path-cost"));
	});

	it("hands nothing on a write to an ordinary program", () => {
		expect(write("scripts/ordinary.js")).toBe("");
	});
});

describe("a write the core does not see", () => {
	it("is a Bash write to a hot-path program", () => {
		const said =
			runEventCores(
				toolCall("Bash", {
					command: `echo y > ${path.join(root, "scripts/guard-x.js")}`,
				}),
				{ root },
			).output?.additionalContext ?? "";
		expect(said).not.toContain(readRuleText("hot-path-cost"));
	});
});

describe("once the rule is told", () => {
	it("returns on the latch before any other read", () => {
		const unread = () => {
			throw new Error("read after the latch");
		};
		expect(
			decide(path.join("/x", "scripts/guard-x.js"), {
				told: (id: string) => id === "hot-path-cost",
				tree: unread,
				input: {},
				isFile: unread,
			}),
		).toBeNull();
	});
});
