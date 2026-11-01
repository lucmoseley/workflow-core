// @vitest-environment node
/*
 * check-unclosed-launches.test.ts — what `npm run status` names (#3782), from
 * a real state file and a stubbed tracker: an open implement ticket whose
 * latest launch committed and did not close, and nothing else. A break here
 * leaves a stranded ticket waiting unreported, as #3609 did.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { printed, stubGhRoutes } from "./lib/gh-stub";
import { runInProcessAsync } from "./lib/run-in-process.js";

const SCRIPT = path.resolve(__dirname, "check-unclosed-launches.js");

let dir: string;
let root: string;

const buildLaunch = (n: number, over: Record<string, unknown> = {}) => ({
	root,
	issues: [n],
	prompt: `/implement ${n}`,
	launchedAt: Date.parse("2026-10-29T18:00:00Z"),
	finishedAt: Date.parse("2026-10-29T19:00:00Z"),
	jobId: `job${n}`,
	acts: { commit: 1 },
	...over,
});

const buildIssue = (number: number, labels = ["takes:implement"]) => ({
	number,
	title: `issue ${number}`,
	labels: labels.map((name) => ({ name })),
});

async function run(launches: object[], open: object[] | null) {
	const refill = path.join(dir, "refill");
	fs.mkdirSync(refill, { recursive: true });
	fs.writeFileSync(
		path.join(refill, ".refill-loop-state.json"),
		JSON.stringify({ launches }),
	);
	const stub = stubGhRoutes(
		dir,
		{ "issue list*": printed(JSON.stringify(open ?? [])) },
		{ failing: open === null },
	);
	const r = await runInProcessAsync(SCRIPT, [], {
		cwd: root,
		env: { ...process.env, ...stub.env, WFC_REFILL_DIR: refill },
	});
	return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "unclosed-"));
	root = path.join(dir, "checkout");
	fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
	fs.writeFileSync(
		path.join(root, ".claude", "workflow-core.json"),
		JSON.stringify({ contract: 1, tracker: "o/r" }),
	);
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

describe("check-unclosed-launches (#3782)", () => {
	it("names an open implement ticket whose latest launch committed and did not close", async () => {
		const r = await run([buildLaunch(7)], [buildIssue(7)]);
		expect(r.status).toBe(0);
		expect(r.out).toContain("o/r#7 issue 7");
		expect(r.out).toContain("2026-10-29T18:00Z");
		expect(r.out).toContain("WARN: 1");
	});

	it.each([
		["closed since", []],
		["parked", [buildIssue(7, ["takes:implement", "parked"])]],
		["relabelled", [buildIssue(7, ["takes:triage"])]],
	])("passes over a ticket %s", async (_, open) => {
		const r = await run([buildLaunch(7)], open);
		expect(r.status).toBe(0);
		expect(r.out).toContain("OK:");
	});

	it("reads no tracker where no launch reads as unclosed", async () => {
		const r = await run(
			[buildLaunch(7, { acts: { commit: 1, close: 1 } })],
			null,
		);
		expect(r.status).toBe(0);
		expect(r.out).toContain("OK:");
	});

	it("says a launch's checkout has no tracker, never that there are none", async () => {
		const bare = path.join(dir, "bare");
		fs.mkdirSync(bare);
		const r = await run([buildLaunch(7, { root: bare })], []);
		expect(r.status).toBe(0);
		expect(r.out).toContain(`${bare}: no tracker configured`);
	});

	it("says a tracker would not read, never that there are none", async () => {
		const r = await run([buildLaunch(7)], null);
		expect(r.status).toBe(0);
		expect(r.out).toContain("o/r: tracker would not read");
		expect(r.out).not.toContain("OK:");
	});
});
