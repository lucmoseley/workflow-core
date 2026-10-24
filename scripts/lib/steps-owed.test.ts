// @vitest-environment node
/*
 * steps-owed.test.ts — the sole reader/writer of `.claude/workflow-core.json`'s
 * `stepsOwed` field (#248): entries append, clear and decline without losing
 * the rest of the config, in the layout an adopter's Biome gate accepts (#675).
 *
 * Every case writes a config under its own temp root, so no case touches this
 * repo's `.claude/workflow-core.json`.
 *
 * `upgrade.js` writes it and `check-plugin-gap.js`, a SessionStart hook,
 * reports it; loosen a case and a migration's manual step is lost unreported,
 * or a declined choice is asked again on the next machine.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	appendStepsOwed,
	clearStepOwed,
	declineStepOwed,
	stepsOwed,
} from "./steps-owed.js";

let root: string;
let made: string[] = [];

const configAt = (r: string) => path.join(r, ".claude/workflow-core.json");
const readConfig = (r: string) =>
	JSON.parse(fs.readFileSync(configAt(r), "utf8"));

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "steps-owed-test-"));
	made.push(root);
});
afterEach(() => {
	for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
	made = [];
});

describe("steps-owed.js", () => {
	it("reads no entries where the config carries none", () => {
		expect(stepsOwed(root)).toEqual([]);
	});

	it("appends entries under a tag, preserving the rest of the config", () => {
		fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
		fs.writeFileSync(configAt(root), JSON.stringify({ founder: "x" }));

		appendStepsOwed(root, "v2.0.0", [
			{ type: "act", text: "do a thing" },
			{ type: "notice", text: "fyi a thing" },
		]);

		expect(stepsOwed(root)).toEqual([
			{ tag: "v2.0.0", type: "act", text: "do a thing" },
			{ tag: "v2.0.0", type: "notice", text: "fyi a thing" },
		]);
		expect(readConfig(root).founder).toBe("x");
	});

	it("keeps a short array inline, as the adopter's Biome gate prints it (#675)", () => {
		fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
		fs.writeFileSync(
			configAt(root),
			JSON.stringify({ modules: ["roadmap", "governance", "suites"] }),
		);
		appendStepsOwed(root, "v2.0.0", [{ type: "act", text: "a" }]);
		expect(fs.readFileSync(configAt(root), "utf8")).toContain(
			'\t"modules": ["roadmap", "governance", "suites"],\n',
		);
	});

	it("a later append adds to, never replaces, an earlier one", () => {
		appendStepsOwed(root, "v2.0.0", [{ type: "act", text: "a" }]);
		appendStepsOwed(root, "v3.0.0", [{ type: "choice", text: "b" }]);
		expect(stepsOwed(root)).toEqual([
			{ tag: "v2.0.0", type: "act", text: "a" },
			{ tag: "v3.0.0", type: "choice", text: "b" },
		]);
	});

	it("clears one matching entry and leaves the rest", () => {
		appendStepsOwed(root, "v2.0.0", [
			{ type: "act", text: "a" },
			{ type: "notice", text: "b" },
		]);
		expect(clearStepOwed(root, { tag: "v2.0.0", type: "act", text: "a" })).toBe(
			true,
		);
		expect(stepsOwed(root)).toEqual([
			{ tag: "v2.0.0", type: "notice", text: "b" },
		]);
	});

	it("clear returns false where nothing matches", () => {
		appendStepsOwed(root, "v2.0.0", [{ type: "act", text: "a" }]);
		expect(
			clearStepOwed(root, { tag: "v2.0.0", type: "act", text: "not it" }),
		).toBe(false);
		expect(stepsOwed(root)).toHaveLength(1);
	});

	it("clear refuses a malformed identifier before touching the file", () => {
		appendStepsOwed(root, "v2.0.0", [{ type: "act", text: "a" }]);
		expect(() =>
			clearStepOwed(root, { tag: "v2.0.0", type: "bogus", text: "a" }),
		).toThrow(/one of act\/choice\/notice/);
		expect(stepsOwed(root)).toHaveLength(1);
	});

	it("declines a choice in place, marked declined and never removed", () => {
		appendStepsOwed(root, "v2.0.0", [{ type: "choice", text: "pick one" }]);
		expect(declineStepOwed(root, { tag: "v2.0.0", text: "pick one" })).toBe(
			true,
		);
		expect(stepsOwed(root)).toEqual([
			{ tag: "v2.0.0", type: "choice", text: "pick one", declined: true },
		]);
	});

	it("decline returns false where nothing matches", () => {
		expect(declineStepOwed(root, { tag: "v2.0.0", text: "nope" })).toBe(false);
	});

	it("drops a malformed entry from stepsOwed() without throwing", () => {
		fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
		fs.writeFileSync(
			configAt(root),
			JSON.stringify({
				stepsOwed: [
					{ tag: "v2.0.0", type: "act", text: "good" },
					{ tag: "v2.0.0", type: "bogus", text: "bad type" },
					{ tag: "", type: "act", text: "empty tag" },
					"not even an object",
				],
			}),
		);
		expect(stepsOwed(root)).toEqual([
			{ tag: "v2.0.0", type: "act", text: "good" },
		]);
	});
});
