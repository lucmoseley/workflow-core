// @vitest-environment node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { runInProcess } from "./lib/run-in-process.js";
import { ensureProof } from "./lib/verdict-probe.js";

const CHECK = path.join(__dirname, "check-verdict-proof.js");
const CANARY = "canary.test.ts";
let root: string;

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "verdict-proof-"));
	spawnSync("git", ["init", "-q", root]);
	fs.writeFileSync(path.join(root, CANARY), "fails under the probe\n");
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function declare(commands: object) {
	fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
	fs.writeFileSync(
		path.join(root, ".claude", "workflow-core.json"),
		JSON.stringify({ contract: 1, commands }),
	);
}

function status() {
	const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_PROJECT_DIR: root };
	delete env.WFC_MODULES;
	const r = runInProcess(CHECK, [], { cwd: root, env });
	return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

const markers = () => path.join(root, ".claude", "tmp", "markers");
const prove = (code: number) => {
	fs.mkdirSync(markers(), { recursive: true });
	ensureProof({
		root,
		command: "run-tests",
		canary: CANARY,
		markers: markers(),
		run: (_line, { env }) =>
			env.WFC_VERDICT_PROBE
				? { code, out: ` FAIL  ${CANARY}` }
				: { code: 0, out: "" },
	});
};

it("reports no canary declared, naming where the contract is written", () => {
	declare({ test: "run-tests" });
	const { code, out } = status();
	expect(code).toBe(1);
	expect(out).toContain("no canary declared");
	expect(out).toContain("docs/code-standards-base.md");
});

it("reports a stale proof, then a fresh one once the probe passes", () => {
	declare({ test: "run-tests", testCanary: CANARY });
	expect(status()).toMatchObject({ code: 0 });
	expect(status().out).toContain("verdict proof stale");
	prove(1);
	expect(status().out).toContain("verdict proof fresh");
});

it("reports a failed probe with its clause", () => {
	declare({ test: "run-tests", testCanary: CANARY });
	prove(0);
	const { code, out } = status();
	expect(code).toBe(1);
	expect(out).toContain("the verdict probe failed: it exits 0 on a red");
	expect(out).toContain(
		`${path.join(markers(), "verdict-proof.json")} is deleted`,
	);
});
