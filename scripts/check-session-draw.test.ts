// @vitest-environment node
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { mkScratchDir } from "./lib/git-fixture";
import { runInProcess } from "./lib/run-in-process.js";

const SCRIPT = path.join(__dirname, "check-session-draw.js");

const dirs: string[] = [];
afterEach(() => {
	while (dirs.length > 0)
		fs.rmSync(dirs.pop() as string, { recursive: true, force: true });
});

const refillDir = () => {
	const dir = mkScratchDir("session-draw-");
	dirs.push(dir);
	return dir;
};

const check = (dir: string) => {
	const { WFC_MODULES: _, ...env } = process.env;
	return runInProcess(SCRIPT, [], {
		cwd: dir,
		env: { ...env, WFC_REFILL_DIR: dir },
	});
};

const served = (configs: Record<string, object>) => {
	const dir = refillDir();
	const roots = Object.entries(configs).map(([name, config]) => {
		const root = path.join(dir, name);
		fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
		fs.writeFileSync(
			path.join(root, ".claude", "workflow-core.json"),
			JSON.stringify({ contract: 1, modules: [], ...config }),
		);
		return root;
	});
	fs.writeFileSync(
		path.join(dir, ".refill-loop-control.json"),
		JSON.stringify({
			noProgressFrom: 0,
			scope: { mode: "normal", repos: roots, goal: null },
		}),
	);
	return check(dir);
};

const GATED = { commands: { test: "bash test/all.sh" } };

describe("check-session-draw.js (#5274)", () => {
	it("warns on a served commit-gated repo declaring no draw, naming it, the pooled draw and the way out", async () => {
		const r = await served({ "design-vault": GATED });
		const out = r.stdout + r.stderr;
		expect(r.status).toBe(0);
		expect(out).toContain("UNDECLARED-DRAW");
		expect(out).toContain("design-vault gates its tests at commit");
		expect(out).toContain("the pooled 587/304 MB");
		expect(out).toMatch(
			/declare both in \S*design-vault\/\.claude\/workflow-core\.json/,
		);
	});

	it("skips where the refill loop serves no repo", async () => {
		const dir = refillDir();
		fs.writeFileSync(
			path.join(dir, ".refill-loop-control.json"),
			JSON.stringify({
				noProgressFrom: 0,
				scope: { mode: "normal", repos: [], goal: null },
			}),
		);
		const r = await check(dir);
		expect(r.status).toBe(0);
		expect(r.stdout + r.stderr).toContain("the refill loop serves no repo");
	});

	it("reads broken, exit 2, on a damaged loop control", async () => {
		const dir = refillDir();
		fs.writeFileSync(path.join(dir, ".refill-loop-control.json"), "{");
		const r = await check(dir);
		expect(r.status).toBe(2);
		expect(r.stdout + r.stderr).toMatch(/is damaged/);
	});

	it("is silent on one declaring both keys, and on one gated elsewhere", async () => {
		const r = await served({
			declared: { ...GATED, sessionMeanMb: 900, sessionSigmaMb: 200 },
			ungated: {},
		});
		expect(r.status).toBe(0);
		expect(r.stdout + r.stderr).not.toContain("UNDECLARED-DRAW");
		expect(r.stdout + r.stderr).toContain("declares its session draw");
	});

	it("still warns where only one key is declared", async () => {
		const r = await served({ half: { ...GATED, sessionMeanMb: 900 } });
		expect(r.stdout + r.stderr).toContain("half gates its tests at commit");
	});
});
