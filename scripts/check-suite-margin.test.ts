// @vitest-environment node
/*
 * Pins that check-suite-margin.js names the latest green whole vitest suite
 * over its target — sha, duration, target, ceiling, machine reading and
 * slowest files — stays silent on one under it, on a part-suite and on a red
 * run, and exits 0 on a breach (#1797, the report-only ruling).
 *
 * Loosen a case and the suite outgrows its margin unreported until a push
 * gate is killed at the ceiling, or a slow run starts refusing.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInProcess } from "./lib/run-in-process.js";

const {
	CEILING_MS,
	TARGET_FRACTION,
	TARGET_MS,
} = require("./lib/suite-ceiling.js");

const SCRIPT = path.resolve(__dirname, "check-suite-margin.js");
const SHA = "a".repeat(40);

let dir: string;
let store: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "wfc-margin-"));
	store = path.join(dir, "pass.jsonl");
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

const WHOLE = {
	modulesRun: 600,
	modulesTotal: 600,
	tests: 20_000,
	skipped: 0,
	full: "flag",
	fullCause: "push-gate",
};

const MACHINE = {
	ceilingPct: 800,
	busyPct: 377,
	systemPct: 190,
	nicePct: 165.5,
	userPct: 21,
	iowaitPct: 0.5,
	load1: 5.23,
};

const SLOWEST = [
	{ file: "scripts/dispatch-sessions.test.ts", seconds: 200.4 },
	{ file: "scripts/new-repo.test.ts", seconds: 167 },
];

const marker = (fields: Record<string, unknown> = {}) => ({
	sha: SHA,
	at: "2026-10-24T09:00:00.000Z",
	suite: "vitest",
	durationMs: TARGET_MS + 60_000,
	machine: MACHINE,
	scope: WHOLE,
	slowest: SLOWEST,
	...fields,
});

const write = (...markers: unknown[]) =>
	fs.writeFileSync(store, markers.map((m) => JSON.stringify(m)).join("\n"));

const run = () => {
	const r = runInProcess(SCRIPT, ["--store", store], { cwd: dir });
	return { status: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
};

const secs = (ms: number) => `${Math.round(ms / 1000)} s`;

describe("a green whole suite over the target", () => {
	it("is named with its sha, duration, target, ceiling, machine reading and slowest files, and exits 0", () => {
		write(marker());
		const r = run();
		expect(r.status).toBe(0);
		expect(r.out).toContain("SUITE-MARGIN");
		expect(r.out).toContain(SHA.slice(0, 12));
		expect(r.out).toContain(secs(TARGET_MS + 60_000));
		expect(r.out).toContain(secs(TARGET_MS));
		expect(r.out).toContain(secs(CEILING_MS));
		expect(r.out).toContain("busy 377% of 800%");
		expect(r.out).toContain("load1 5.23");
		expect(r.out).toContain("200.4 s  scripts/dispatch-sessions.test.ts");
		expect(r.out).toContain("scripts/new-repo.test.ts");
		expect(r.out).toContain("Cut its heavy tail by measured cost");
	});

	it("is judged on the latest run alone", () => {
		write(marker(), marker({ sha: "b".repeat(40), durationMs: 1000 }));
		expect(run().out).not.toContain("SUITE-MARGIN");
	});
});

describe("silence", () => {
	it.each([
		["one under the target", marker({ durationMs: TARGET_MS - 1000 })],
		[
			"a part-suite",
			marker({ scope: { ...WHOLE, full: undefined, fileFilters: ["x"] } }),
		],
		[
			"a whole run narrowed to fewer modules",
			marker({ scope: { ...WHOLE, modulesRun: 300 } }),
		],
		[
			"a certificate carrying failures",
			marker({
				scope: { ...WHOLE, failures: [{ file: "x.test.ts", tests: ["t"] }] },
			}),
		],
		["a ceiling kill", marker({ ceilingKill: true })],
	])("%s reports nothing", (_name, m) => {
		write(m);
		const r = run();
		expect(r.status).toBe(0);
		expect(r.out).not.toContain("SUITE-MARGIN");
	});

	it("an absent store reports nothing", () => {
		const r = run();
		expect(r.status).toBe(0);
		expect(r.out).not.toContain("SUITE-MARGIN");
	});
});

it("docs/environment.md states the module's target", () => {
	const doc = fs.readFileSync(
		path.resolve(__dirname, "..", "docs/environment.md"),
		"utf8",
	);
	expect(doc).toContain(
		`${Math.round(TARGET_FRACTION * 100)}% of that ceiling (${TARGET_MS / 1000} s)`,
	);
});
