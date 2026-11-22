// @vitest-environment node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { defineTemplate } from "./git-fixture";
import { buildLanderDeps } from "./queue-lander-deps.js";

let root: string;

const repoTemplate = defineTemplate((dir) =>
	execFileSync("git", ["init", "-q"], { cwd: dir }),
);

beforeEach(() => {
	vi.stubEnv("WFC_MODULES", undefined);
	root = repoTemplate.instantiate(
		fs.mkdtempSync(path.join(os.tmpdir(), "lander-deps-test-")),
	);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const config = (extra: object = {}) => {
	fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
	fs.writeFileSync(
		path.join(root, ".claude", "workflow-core.json"),
		JSON.stringify({ contract: 1, modules: [], tracker: "o/here", ...extra }),
	);
};

const recorded = (lines: object[]) => {
	const dir = path.join(root, ".claude", "tmp", "markers");
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(
		path.join(dir, ".lander-runs.jsonl"),
		lines
			.map(
				(l) => `${JSON.stringify({ kind: "whole", verdict: "green", ...l })}\n`,
			)
			.join(""),
	);
};
const times = <T>(n: number, line: T): T[] =>
	Array.from({ length: n }, () => line);
const local = (suiteSeconds: number) => ({ tester: "local", suiteSeconds });
const actions = (suiteSeconds: number) => ({ tester: "actions", suiteSeconds });

const wired = () => {
	const lines: string[] = [];
	const { tester } = buildLanderDeps(root, {
		say: (l) => lines.push(l),
		code: null,
	});
	let kind = "local";
	if (tester.start !== undefined)
		kind = tester.requiresRun ? "core-actions" : "adopter-actions";
	return { kind, tester, lines };
};

it("tests on Actions where the median whole run is over 3 min, naming the median and the count", () => {
	config();
	recorded([...times(4, local(60)), ...times(5, local(400))]);
	const { kind, tester, lines } = wired();
	expect(kind).toBe("adopter-actions");
	expect(tester.parallel).toBe(false);
	expect(lines).toEqual([
		"tester: actions, the median whole run 400 s over the newest 9 (Actions over 180 s)",
	]);
});

it("tests locally where the median is 3 min or under, auto named or absent", () => {
	for (const extra of [{}, { landingTester: "auto" }]) {
		config(extra);
		recorded([...times(5, local(180)), ...times(4, local(900))]);
		const { kind, lines } = wired();
		expect(kind).toBe("local");
		expect(lines).toEqual([
			"tester: local, the median whole run 180 s over the newest 9 (Actions over 180 s)",
		]);
	}
});

it("tests locally under 5 whole runs, a named run or one with no verdict not counted", () => {
	config();
	recorded([
		...times(4, local(900)),
		{ kind: "named", tester: "local", suiteSeconds: 900 },
		{ verdict: "unknown", tester: "local", suiteSeconds: 900 },
	]);
	const { kind, lines } = wired();
	expect(kind).toBe("local");
	expect(lines).toEqual([
		"tester: local, 4 whole run(s) recorded, under the 5 a median needs (Actions over 180 s)",
	]);
});

it("reads a line without a tester as a local run of its samples' span, beside Actions lines, over the newest 20 alone", () => {
	config();
	recorded([
		...times(30, actions(5000)),
		...times(10, { samples: 100 }),
		...times(10, actions(600)),
	]);
	const { kind, lines } = wired();
	expect(kind).toBe("adopter-actions");
	expect(lines[0]).toBe(
		"tester: actions, the median whole run 400 s over the newest 20 (Actions over 180 s)",
	);
	recorded([...times(11, { samples: 30 }), ...times(9, actions(600))]);
	expect(wired().kind).toBe("local");
});

it("ignores the record where landingTester pins local or actions", () => {
	recorded(times(20, local(900)));
	config({ landingTester: "local" });
	expect(wired()).toMatchObject({
		kind: "local",
		lines: ["tester: local, as landingTester pins it"],
	});
	recorded(times(20, local(10)));
	config({ landingTester: "actions" });
	expect(wired()).toMatchObject({
		kind: "core-actions",
		lines: ["tester: actions, as landingTester pins it"],
	});
});

it("tests locally where the run record will not read, saying why", () => {
	config();
	fs.mkdirSync(
		path.join(root, ".claude", "tmp", "markers", ".lander-runs.jsonl"),
		{
			recursive: true,
		},
	);
	const { kind, lines } = wired();
	expect(kind).toBe("local");
	expect(lines).toHaveLength(1);
	expect(lines[0]).toMatch(
		/^tester: local, the run record will not read \(.*EISDIR.*\) \(Actions over 180 s\)$/,
	);
});
