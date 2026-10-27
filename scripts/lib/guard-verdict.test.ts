// @vitest-environment node
/*
 * lib/guard-verdict.js, the verdict walk every Node guard core is built from
 * (#2885): the first Stop ends the walk, a refusal splices the
 * segment after the path rewrite, a fail-open is logged, and an unreadable
 * rule is answered by its fallback.
 *
 * In process, with a judge written per case, so each route out of the walk
 * shows without a guard around it. Every Node guard core walks through this
 * module: a case loosened here loosens every core's verdict at once.
 */

import { describe, expect, it } from "vitest";
import type { Command } from "./shell-parse.js";
import { parseCommand, walkCommands } from "./shell-parse.js";

const { deny, denyText, open, ruleOr, walkVerdict } =
	require("./guard-verdict.js") as typeof import("./guard-verdict.js");

const WALK = {
	cwd: "/repo",
	fallbackCwd: "/repo",
	vars: {},
	isDir: () => true,
};

/** Paths rewritten by marking every `@P@`, so the order of the two steps shows. */
const ctx = { corePaths: (t: string) => t.replaceAll("@P@", "/root") };

describe("walkVerdict", () => {
	it("answers the first Stop's decision, judging no command after it", () => {
		const seen: string[] = [];
		const out = walkVerdict(
			parseCommand("echo a; echo b; echo c"),
			(cmd: Command) => {
				seen.push(cmd.words[1] ?? "");
				if (cmd.words[1] === "b") deny(ctx, cmd.segment, "no: @CMD@");
			},
			WALK,
		);
		expect(out).toEqual({ deny: "no: echo b" });
		expect(seen).toEqual(["a", "b"]);
	});

	it("answers undefined where the walk runs to its end, and null for a fail-open", () => {
		const judged: string[] = [];
		expect(
			walkVerdict(
				parseCommand("echo a; echo b"),
				(cmd: Command) => judged.push(cmd.segment),
				WALK,
			),
		).toBeUndefined();
		expect(judged).toHaveLength(2);
		const logs: string[] = [];
		const out = walkVerdict(
			parseCommand("echo a"),
			() => open({ log: (w: string) => logs.push(w) }, "unread — allowed"),
			WALK,
		);
		expect(out).toBeNull();
		expect(logs).toEqual(["unread — allowed"]);
	});

	it("lets any other throw through", () => {
		expect(() =>
			walkVerdict(
				parseCommand("echo a"),
				() => {
					throw new Error("broke");
				},
				WALK,
			),
		).toThrow("broke");
	});
});

describe("denyText", () => {
	it("splices the segment as unmask shows it, after the path rewrite", () => {
		const segments: string[] = [];
		walkCommands(
			parseCommand("gh issue edit 1 --body @P@ 'quoted'"),
			(c: Command) => {
				segments.push(c.segment);
			},
			WALK,
		);
		expect(denyText(ctx, segments[0] ?? "", "@P@ refuses @CMD@ @CMD@")).toBe(
			'/root refuses gh issue edit 1 --body @P@ "…" gh issue edit 1 --body @P@ "…"',
		);
	});
});

describe("ruleOr", () => {
	it("answers the fragment, or the fallback where the read throws, telling onFault only then", () => {
		const faults: string[] = [];
		const onFault = () => faults.push("fault");
		expect(ruleOr(() => "the rule", "fallback", onFault)).toBe("the rule");
		expect(faults).toEqual([]);
		expect(
			ruleOr(
				() => {
					throw new Error("no store");
				},
				"fallback",
				onFault,
			),
		).toBe("fallback");
		expect(faults).toEqual(["fault"]);
	});
});
