// @vitest-environment node
/*
 * check-citation-ceiling.js — the tracker's top against the ceiling (#726).
 *
 * A stub `gh` injected via WFC_GH answers for the tracker, whose real top is
 * what the checker reports on and so cannot also be its fixture. The host's
 * tracker is declared in a throwaway `.claude/workflow-core.json`, the one
 * input telling the core from an adopter.
 *
 * A FAIL reds the scheduled sweep's `Document guards` job in
 * .github/workflows/roadmap-digest.yml: loosen a case and the tracker can pass
 * the ceiling unwarned, after which the release build ships new citations
 * bare to adopters and check-citation-tracker.js stops refusing a mis-prefixed
 * one.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stubGhScript } from "./lib/gh-stub";
import { CITATION_CEILING } from "./lib/qualify-citations.js";
import { runInProcess } from "./lib/run-in-process.js";
import { UPSTREAM_TRACKER } from "./lib/workflow-core-config.js";

const SCRIPT = path.resolve(__dirname, "check-citation-ceiling.js");

let dir: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "citation-ceiling-"));
	fs.mkdirSync(path.join(dir, ".claude"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const run = (
	tracker: string,
	answer: string,
	{ failing = false, args = [] as string[] } = {},
) => {
	fs.writeFileSync(
		path.join(dir, ".claude", "workflow-core.json"),
		JSON.stringify({ contract: 1, tracker }),
	);
	const stub = stubGhScript(
		dir,
		`#!/bin/sh\necho "$@" >> ${path.join(dir, "calls.log")}\necho '${answer}'\n`,
		{ failing },
	);
	const r = runInProcess(SCRIPT, ["--json", ...args], {
		cwd: dir,
		env: { ...process.env, CLAUDE_PROJECT_DIR: dir, ...stub.env },
	});
	const report = JSON.parse(r.stdout);
	return { code: r.status, outcome: report.outcome, text: r.stdout };
};
const calls = () =>
	fs.existsSync(path.join(dir, "calls.log"))
		? fs.readFileSync(path.join(dir, "calls.log"), "utf8")
		: "";
const top = (n: number) => `[{"number":${n}}]`;

describe("check-citation-ceiling", () => {
	it("passes with the tracker's top outside the margin", () => {
		const r = run(UPSTREAM_TRACKER, top(CITATION_CEILING - 1001));
		expect([r.outcome, r.code]).toEqual(["OK", 0]);
		expect(calls()).toContain(`repos/${UPSTREAM_TRACKER}/issues?state=all`);
	});

	it("fails once the top is within the margin, naming the ceiling and where to raise it", () => {
		const r = run(UPSTREAM_TRACKER, top(CITATION_CEILING - 1000));
		expect(r.outcome).toBe("FAIL");
		expect(r.code).not.toBe(0);
		expect(r.text).toContain(`CITATION_CEILING (${CITATION_CEILING})`);
		expect(r.text).toContain("raise it in scripts/lib/qualify-citations.js");
	});

	it("fails past the ceiling, saying how far", () => {
		const r = run(UPSTREAM_TRACKER, top(CITATION_CEILING + 7));
		expect(r.outcome).toBe("FAIL");
		expect(r.text).toContain("7 past");
	});

	it("skips in an adopter without asking GitHub", () => {
		const r = run("someone/else", "[]");
		expect([r.outcome, r.code]).toEqual(["SKIP", 0]);
		expect(r.text).toContain("the ceiling is the core's to raise");
		expect(calls()).toBe("");
	});

	it("skips where gh cannot reach GitHub", () => {
		const r = run(UPSTREAM_TRACKER, "[]", { failing: true });
		expect([r.outcome, r.code]).toEqual(["SKIP", 0]);
		expect(r.text).toContain("No ceiling conclusion drawn");
	});

	it("is broken on an unreachable GitHub under --require-remote", () => {
		const r = run(UPSTREAM_TRACKER, "[]", {
			failing: true,
			args: ["--require-remote"],
		});
		expect(r.outcome).toBe("BROKEN");
		expect(r.code).not.toBe(0);
		expect(r.text).toContain("--require-remote");
	});

	it("is broken on an answer carrying no number", () => {
		const r = run(UPSTREAM_TRACKER, "[]");
		expect(r.outcome).toBe("BROKEN");
		expect(r.code).not.toBe(0);
		expect(r.text).toContain("its top is unknown");
	});
});
