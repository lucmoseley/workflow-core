// @vitest-environment node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runInProcess } from "./run-in-process.js";
import { settleTestGate, testGate } from "./test-gate.js";

const CANARY = "canary.test.ts";
const COMMAND = "./run-tests";
const CONFORMING = `if [ -n "$WFC_VERDICT_PROBE" ]; then echo " FAIL  $1"; exit 1; fi; exit 0`;

const dirs: string[] = [];
afterEach(() => {
	while (dirs.length > 0)
		fs.rmSync(dirs.pop() as string, { recursive: true, force: true });
});

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

	it("gives an undeclared command no gate", () => {
		expect(testGate({ root: host({ modules: [] }) }).gate).toBe(null);
	});
});

describe("node test-gate.js <verb>", () => {
	const run = (verb: string, root: string) => {
		const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_PROJECT_DIR: root };
		return runInProcess(path.join(__dirname, "test-gate.js"), [verb], { env });
	};

	it.each([
		{
			verb: "push",
			cfg: { commands: { test: COMMAND } },
			status: 1,
			stdout: "",
			stderr: "SKIP: the commit-time gate run stays — no canary declared",
		},
		{
			verb: "commit",
			cfg: { commands: { test: COMMAND } },
			status: 0,
			stdout: `${COMMAND}\n`,
			stderr: "no canary declared",
		},
		{
			verb: "commit",
			cfg: { commands: { test: COMMAND, testCanary: CANARY } },
			status: 1,
			stdout: "",
			stderr: "SKIP: commands.test is gated at push",
		},
		{
			verb: "push",
			cfg: { commands: { test: COMMAND, testCanary: CANARY } },
			status: 0,
			stdout: `${COMMAND}\n`,
			stderr: "",
		},
		{
			verb: "push",
			cfg: { modules: [] },
			status: 1,
			stdout: "",
			stderr: "SKIP: commands.test is undeclared",
		},
		{
			verb: "commit",
			cfg: { modules: [] },
			status: 1,
			stdout: "",
			stderr: "SKIP: commands.test is undeclared",
		},
		{
			verb: "push",
			cfg: { contract: 99 },
			status: 2,
			stdout: "",
			stderr: "BROKEN: ",
		},
	])(
		"$verb over $cfg exits $status",
		({ verb, cfg, status, stdout, stderr }) => {
			const r = run(verb, host(cfg));
			expect([r.status, r.stdout]).toEqual([status, stdout]);
			expect(r.stderr).toContain(stderr);
		},
	);

	it("says why the commit gate stays, and where the contract is written", () => {
		const r = run("commit", host({ commands: { test: COMMAND } }));
		expect(r.stderr).toContain("no canary declared (`commands.testCanary`)");
		expect(r.stderr).toContain("docs/code-standards-base.md");
	});

	it("refuses a verb it does not know", () => {
		const r = run("pull", host({}));
		expect(r.status).toBe(2);
		expect(r.stderr).toBe("usage: node test-gate.js <commit|push>\n");
	});
});
