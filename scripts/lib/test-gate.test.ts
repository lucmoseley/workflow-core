// @vitest-environment node
/*
 * test-gate.test.ts — which gate owns a declared test command (#740, #5294):
 * the lander, where the command's verdict probe has passed for it and its
 * canary, or pre-commit otherwise. Driven against a throwaway host whose test
 * command is a shell script, so each case sets whether it meets the verdict
 * contract. Read wrongly one way, a repo runs its whole suite on every
 * commit; the other, a command the lander gets no verdict from stands its
 * commit gate down with nothing behind it.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runInProcess } from "./run-in-process.js";
import { settleTestGate, testGate } from "./test-gate.js";

const CANARY = "canary.test.ts";
const COMMAND = "./run-tests";
const CONFORMING = `if [ -n "$WFC_VERDICT_PROBE" ]; then echo " FAIL  $1"; exit 1; fi; exit 0`;

const dirs: string[] = [];
/* WFC_MODULES replaces the declared module list, so a value inherited from
 * the shell would decide `suites` instead of each case's own config. */
beforeEach(() => {
	vi.stubEnv("WFC_MODULES", undefined);
});
afterEach(() => {
	while (dirs.length > 0)
		fs.rmSync(dirs.pop() as string, { recursive: true, force: true });
});

/** A host whose `commands.test` is a script running `body`. */
function host(config: object, body = CONFORMING) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "test-gate-"));
	dirs.push(root);
	fs.mkdirSync(path.join(root, ".claude"));
	fs.writeFileSync(
		path.join(root, ".claude", "workflow-core.json"),
		JSON.stringify({ contract: 1, ...config }),
	);
	fs.writeFileSync(path.join(root, "run-tests"), `#!/bin/sh\n${body}\n`, {
		mode: 0o755,
	});
	fs.writeFileSync(path.join(root, CANARY), "fails under the probe\n");
	return root;
}

const recordPath = (root: string) =>
	path.join(root, ".claude", "tmp", "markers", "verdict-proof.json");

const say = () => undefined;

describe("testGate", () => {
	it("keeps a declared command at commit where no canary is declared", () => {
		const root = host({ commands: { test: COMMAND } });
		expect(settleTestGate(say, { root })).toMatchObject({
			gate: "commit",
			proof: { state: "none" },
		});
	});

	it("keeps it at commit while the proof is stale, and stands it down once the probe passes", () => {
		const root = host({ commands: { test: COMMAND, testCanary: CANARY } });
		expect(testGate({ root })).toMatchObject({
			gate: "commit",
			proof: { state: "stale" },
		});
		expect(settleTestGate(say, { root }).gate).toBe("push");
		expect(testGate({ root }).gate).toBe("push");
	});

	it("keeps it at commit on a failed probe, carrying the clause", () => {
		const root = host(
			{ commands: { test: COMMAND, testCanary: CANARY } },
			"exit 0",
		);
		const found = settleTestGate(say, { root });
		expect(found.gate).toBe("commit");
		expect(found.proof.state === "failed" && found.proof.clause).toMatch(
			/exits 0 on a red/,
		);
	});

	it("reads an unreadable record as stale, keeping the gate", () => {
		const root = host({ commands: { test: COMMAND, testCanary: CANARY } });
		settleTestGate(say, { root });
		fs.writeFileSync(recordPath(root), "{not json");
		expect(testGate({ root }).gate).toBe("commit");
	});

	it("gives an undeclared command to the lander with suites on, and to no gate with it off", () => {
		expect(testGate({ root: host({ modules: ["suites"] }) }).gate).toBe("push");
		expect(testGate({ root: host({ modules: [] }) }).gate).toBe(null);
	});
});

describe("node test-gate.js <verb>", () => {
	const run = (verb: string, root: string) => {
		const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_PROJECT_DIR: root };
		delete env.WFC_MODULES;
		return runInProcess(path.join(__dirname, "test-gate.js"), [verb], { env });
	};

	it.each([
		["push", { modules: ["suites"] }, 0, ""],
		["push", { commands: { test: COMMAND } }, 1, ""],
		["commit", { commands: { test: COMMAND } }, 0, `${COMMAND}\n`],
		["commit", { commands: { test: COMMAND, testCanary: CANARY } }, 1, ""],
		[
			"push",
			{ commands: { test: COMMAND, testCanary: CANARY } },
			0,
			`${COMMAND}\n`,
		],
		["push", { modules: [] }, 1, ""],
		["push", { contract: 99 }, 2, ""],
	])("%s over %j exits %i", (verb, cfg, status, stdout) => {
		const r = run(verb, host(cfg));
		expect([r.status, r.stdout]).toEqual([status, stdout]);
	});

	it("says why the commit gate stays, and where the contract is written", () => {
		const r = run("commit", host({ commands: { test: COMMAND } }));
		expect(r.stderr).toContain("no canary declared (`commands.testCanary`)");
		expect(r.stderr).toContain("docs/code-standards-base.md");
	});

	it("refuses a verb it does not know", () => {
		expect(run("pull", host({})).status).toBe(2);
	});
});
