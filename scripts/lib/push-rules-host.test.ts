// @vitest-environment node
/*
 * lib/push-rules-host.js (#2785): the host's answers to the premises each push
 * rule needs (#742), read off a fixture host's own files, in process.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkScratchDir } from "./git-fixture";

const { buildHostPorts } = require("./push-rules-host.js") as {
	buildHostPorts: (
		root: string,
		log: (what: string, detail?: string) => void,
	) => {
		markerSum: (session: string) => string;
		pushOwesCertificate: () => boolean;
		deploysVercel: () => boolean;
		hasSweep: () => boolean;
	};
};

const SWEEP = "on:\n  schedule:\n    - cron: '0 */6 * * *'\n";
const ON_PUSH = "on:\n  push:\n    branches: [main]\n";

let root: string;
let logs: string[];

beforeEach(() => {
	root = mkScratchDir("push-rules-host-");
	logs = [];
	vi.stubEnv("WFC_MODULES", undefined);
	vi.stubEnv("CLAUDE_PROJECT_DIR", root);
});

afterEach(() => {
	vi.unstubAllEnvs();
	fs.rmSync(root, { recursive: true, force: true });
});

const ports = () =>
	buildHostPorts(root, (what, detail) =>
		logs.push(detail ? `${what}\t${detail}` : what),
	);

const write = (rel: string, body: string) => {
	fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
	fs.writeFileSync(path.join(root, rel), body);
};

const declare = (cfg: object) =>
	write(".claude/workflow-core.json", JSON.stringify({ contract: 1, ...cfg }));

const npmTest = (test = "node scripts/run-vitest.js") =>
	write("package.json", JSON.stringify({ scripts: { test } }));

describe("whether a push owes a certificate (#758, #2929)", () => {
	it.each([
		[
			"suites on and an npm test script",
			true,
			() => {
				declare({ modules: ["suites"] });
				npmTest();
			},
		],
		[
			"suites off, so no gate owns the tests",
			false,
			() => {
				declare({ modules: [] });
				npmTest();
			},
		],
		[
			"suites on and no test command declared",
			true,
			() => {
				declare({ modules: ["suites"] });
				write("package.json", "{}");
			},
		],
		[
			"suites on with node --test declared, gated at commit (#756)",
			false,
			() => declare({ modules: ["suites"], commands: { test: "node --test" } }),
		],
		[
			"suites and landing on, the lander the full gate (#2929)",
			false,
			() => {
				declare({ modules: ["suites", "landing"] });
				npmTest();
			},
		],
		[
			"suites on with a jest npm test, gated at commit",
			false,
			() => {
				declare({ modules: ["suites"], commands: { test: "npm test" } });
				npmTest("jest");
			},
		],
	])("%s: %s", (_, owned, make) => {
		make();
		expect(ports().pushOwesCertificate()).toBe(owned);
	});

	it("a config test-gate.js refuses withholds them, on the record naming why", () => {
		declare({ contract: 99, modules: ["suites"] });
		npmTest();
		expect(ports().pushOwesCertificate()).toBe(false);
		expect(logs).toEqual([
			expect.stringMatching(
				/^test-gate\.js refused the config, push-green-suite withheld\t.*contract 99/,
			),
		]);
	});
});

describe("the declared deploy", () => {
	it.each([
		[{ deploy: "vercel" }, true],
		[{ deploy: "netlify" }, false],
		[{}, false],
	])("%j deploys to Vercel: %s", (cfg, vercel) => {
		declare(cfg);
		expect(ports().deploysVercel()).toBe(vercel);
	});

	it("a host with no config deploys nothing", () => {
		expect(ports().deploysVercel()).toBe(false);
	});
});

describe("the scheduled sweep check:ci reads", () => {
	it.each([
		["scheduled-checks.yml", SWEEP, true],
		["ci.yml", ON_PUSH, false],
		["nightly.yml", SWEEP, false],
		["scheduled-checks.yml", ON_PUSH, false],
	])("%s holding %j is the sweep: %s", (name, body, sweep) => {
		write(`.github/workflows/${name}`, body);
		expect(ports().hasSweep()).toBe(sweep);
	});
});

describe("the session's review marker", () => {
	const marker = path.join(".claude", "tmp", "markers", ".codereview-pass-s1");

	it("is a checksum of its bytes, so a rewritten marker reads as new", () => {
		write(marker, "base=x\n");
		expect(ports().markerSum("s1")).toBe(
			crypto.createHash("sha256").update("base=x\n").digest("hex"),
		);
		write(marker, "base=y\n");
		expect(ports().markerSum("s1")).not.toBe(
			crypto.createHash("sha256").update("base=x\n").digest("hex"),
		);
	});

	it("reads as empty where there is none, or no session to own one", () => {
		expect(ports().markerSum("s1")).toBe("");
		write(marker, "base=x\n");
		expect(ports().markerSum("")).toBe("");
	});
});
