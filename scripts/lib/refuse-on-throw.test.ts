// @vitest-environment node
/*
 * lib/refuse-on-throw.js (#2797): an enforcing entry's core that throws
 * refuses the call, save where the repo itself did not resolve, which stays a
 * recorded fail-open (mantahostels#147).
 */

import { describe, expect, it } from "vitest";
import {
	fakeTreeClassifier,
	unresolvedTreeClassifier,
} from "./git-tree-fake.js";

type Decision = { deny: string } | null;
interface Ctx {
	treeClass: (dir: string) => string;
	log: (what: string, detail?: string) => void;
}

const { refuseOnThrow } = require("./refuse-on-throw.js") as {
	refuseOnThrow: (
		name: string,
		decide: (command: string, ctx: Ctx) => Decision,
	) => (command: string, ctx: Ctx) => Decision;
};

const harness = (
	treeClass: Ctx["treeClass"] = fakeTreeClassifier({ "/repo": "shared" }),
) => {
	const logs: string[] = [];
	const ctx: Ctx = {
		treeClass,
		log: (what, detail) => logs.push(detail ? `${what}\t${detail}` : what),
	};
	return { ctx, logs };
};

describe("refuseOnThrow", () => {
	it("hands the core's decision through untouched, its tree reads included", () => {
		const { ctx, logs } = harness();
		const wrapped = refuseOnThrow("g.js", (c, x) =>
			x.treeClass("/repo") === "shared" ? { deny: c } : null,
		);
		expect(wrapped("git x", ctx)).toEqual({ deny: "git x" });
		expect(wrapped.length).toBe(2);
		expect(logs).toEqual([]);
	});

	it("refuses a core that throws, naming the entry and the fault, logged", () => {
		const { ctx, logs } = harness();
		const wrapped = refuseOnThrow("guard-x.js", () => {
			throw new Error("boom");
		});
		expect(wrapped("git x", ctx)).toEqual({
			deny: "guard-x.js could not judge this command, so it refuses it: boom",
		});
		expect(logs).toEqual(["core threw — the command was refused\tboom"]);
	});

	it("allows, logged, where the repo itself did not resolve", () => {
		const { ctx, logs } = harness(unresolvedTreeClassifier("/x"));
		const wrapped = refuseOnThrow("guard-x.js", (_c, x) => {
			x.treeClass("/x");
			return { deny: "never" };
		});
		expect(wrapped("git x", ctx)).toBeNull();
		expect(logs).toEqual([
			"git could not resolve a git dir for /x — command allowed unchecked",
		]);
	});

	it("refuses where the core throws something else after a tree read faulted and was caught", () => {
		const { ctx, logs } = harness(unresolvedTreeClassifier("/x"));
		const wrapped = refuseOnThrow("guard-x.js", (_c, x) => {
			try {
				x.treeClass("/x");
			} catch {
				/* the core recovered */
			}
			throw new Error("later");
		});
		expect(wrapped("git x", ctx)).toEqual({
			deny: "guard-x.js could not judge this command, so it refuses it: later",
		});
		expect(logs).toEqual(["core threw — the command was refused\tlater"]);
	});
});
