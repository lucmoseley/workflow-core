// @vitest-environment node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { failOpenLogPath, readFailOpenLog } from "./guard-log-fixture";
import {
	buildPassingRegistry,
	type Registry,
	writeRegistryStubs,
} from "./lib/npm-registry-fake";
import {
	buildBashPayload,
	dispatchCoreOutput,
} from "./lib/pretool-guard-testkit";

const CORE = "guard-npm-install";

let dir: string;
let config: string;
let shared: string;

const daysAgo = (n: number) =>
	new Date(Date.now() - n * 86_400_000).toISOString();

const calls = () => path.join(dir, "stub-calls.log");

let serve: ReturnType<typeof writeRegistryStubs>;

const env = (
	reg: Partial<Registry>,
	over: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv => ({
	...serve({ ...buildPassingRegistry(Date.now()), ...reg }),
	STUB_CALLS: calls(),
	WFC_ALLOW_NEW_PACKAGE: "",
	...over,
});

const emission = (
	command: string,
	reg: Partial<Registry> = {},
	over: NodeJS.ProcessEnv = {},
) =>
	dispatchCoreOutput(CORE, buildBashPayload(command, "test"), {
		project: shared,
		config,
		cwd: shared,
		env: env(reg, over),
	});

const denial = (
	command: string,
	reg: Partial<Registry> = {},
	over: NodeJS.ProcessEnv = {},
): string | null => {
	const out = emission(command, reg, over);
	if (out === null) return null;
	expect(out.hookEventName).toBe("PreToolUse");
	expect(out.permissionDecision).toBe("deny");
	return out.permissionDecisionReason as string;
};

const readStubCalls = () =>
	fs.existsSync(calls()) ? fs.readFileSync(calls(), "utf8") : "";

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "guard-npm-"));
	config = path.join(dir, "config");
	shared = path.join(dir, "shared");
	fs.mkdirSync(shared, { recursive: true });
	execFileSync("git", ["init", "-q", "-b", "main", "."], { cwd: shared });
	fs.writeFileSync(
		path.join(shared, "package.json"),
		JSON.stringify({
			dependencies: { "js-yaml": "^4.1.0" },
			devDependencies: { typescript: "^5.0.0", "@biomejs/biome": "^2.0.0" },
		}),
	);
	serve = writeRegistryStubs(path.join(dir, "stubs"));
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("the guard, end to end", () => {
	it("refuses an install adding a package without --ignore-scripts as JSON on exit 0, offline", () => {
		const why = denial("cd /tmp && npm install left-pad");
		expect(why).toMatch(
			/^This install adds 1 package\(s\) this repo does not yet depend on — left-pad {2}— and does not carry `--ignore-scripts`: npm install left-pad\n/,
		);
		expect(readStubCalls()).toBe("");
	});

	it("is silent on a command it does not judge, and on a package package.json lists, logging nothing", () => {
		expect(emission("npm ci")).toBeNull();
		expect(emission("npm install --ignore-scripts js-yaml")).toBeNull();
		expect(readStubCalls()).toBe("");
		expect(fs.existsSync(failOpenLogPath(config, shared))).toBe(false);
	});

	it("asks npm and the downloads endpoint about a new package, and allows one that clears both", () => {
		expect(emission("npm install --ignore-scripts left-pad")).toBeNull();
		expect(readStubCalls()).toBe(
			"npm view left-pad time.created --json\n" +
				"curl -fsS --max-time 8 https://api.npmjs.org/downloads/point/last-month/left-pad\n",
		);
	});

	it("reads npm's E404 as a missing name", () => {
		expect(
			denial("npm i --ignore-scripts wfc-nope", { created: "E404" }),
		).toMatch(/^No package named `wfc-nope` exists on the npm registry/);
	});

	it("reads npm's date against the real clock", () => {
		expect(
			denial("npm i --ignore-scripts left-pad", { created: daysAgo(179) }),
		).toMatch(/first published 179 days ago, under this guard's 180-day floor/);
		expect(
			emission("npm i --ignore-scripts left-pad", { created: daysAgo(181) }),
		).toBeNull();
	});

	it.each([
		[
			"a download count under the floor",
			{ downloads: 999 },
			/downloaded 999 time\(s\)/,
		],
		[
			"a failed downloads call",
			{ downloads: "FAIL" as const },
			/could not be reached/,
		],
		["a failed npm call", { created: "FAIL" }, /could not be reached/],
	])("refuses on %s from the stubs", (_l, reg, match) => {
		expect(denial("npm i --ignore-scripts left-pad", reg)).toMatch(match);
	});

	it("names the dependency whose installed bin it is, read from node_modules (#1806)", () => {
		const at = path.join(shared, "node_modules", "typescript");
		fs.mkdirSync(at, { recursive: true });
		fs.writeFileSync(
			path.join(at, "package.json"),
			JSON.stringify({ name: "typescript", bin: { tsc: "bin/tsc" } }),
		);
		const yaml = path.join(shared, "node_modules", "js-yaml");
		fs.mkdirSync(yaml, { recursive: true });
		fs.writeFileSync(
			path.join(yaml, "package.json"),
			JSON.stringify({ name: "js-yaml", bin: "bin/js-yaml.js" }),
		);
		const biome = path.join(shared, "node_modules", "@biomejs", "biome");
		fs.mkdirSync(biome, { recursive: true });
		fs.writeFileSync(
			path.join(biome, "package.json"),
			JSON.stringify({ name: "@biomejs/biome", bin: { biome: "b" } }),
		);
		expect(denial("npx tsc --noEmit")).toContain(
			"npx -p typescript tsc …    `typescript`, the dependency that carries it",
		);
		expect(denial("npx cowsay")).toContain(
			"No dependency of this repo carries a `cowsay` bin",
		);
	});

	it("refuses the bare npx name of mantahostels#1538, offering the scoped package", () => {
		const why = denial("npx biome ci .");
		expect(why).toMatch(/^This runs `biome` by bare name/);
		expect(why).toContain("npx @biomejs/biome …");
	});
});

describe("the escape", () => {
	const fake = "npm install --ignore-scripts wfc-nope-xyz";

	it("stands down the legitimacy check when set in the hook's environment", () => {
		expect(
			emission(fake, { created: "E404" }, { WFC_ALLOW_NEW_PACKAGE: "1" }),
		).toBeNull();
		expect(readStubCalls()).toBe("");
	});

	it("is NOT spellable on the command line (mantahostels#109)", () => {
		expect(
			denial(`WFC_ALLOW_NEW_PACKAGE=1 ${fake}`, { created: "E404" }),
		).toMatch(/No package named/);
	});

	it("does not stand down the bare-npx check", () => {
		expect(
			denial("npx biome ci .", {}, { WFC_ALLOW_NEW_PACKAGE: "1" }),
		).toMatch(/by bare name/);
	});
});

describe("fail-closed, where the registry cannot be asked", () => {
	it.each([
		["npm", "WFC_NPM"],
		["curl", "WFC_CURL"],
	])("DENIES and records when %s has gone missing", (tool, envVar) => {
		// lucmoseley/mantahostels#1767
		const why = denial(
			"npm install --ignore-scripts left-pad",
			{},
			{ [envVar]: path.join(dir, `no-such-${tool}`) },
		);
		expect(why).toMatch(/could not be reached/);
		expect(why).toContain("WFC_ALLOW_NEW_PACKAGE=1");
		const [line] = readFailOpenLog(config, shared).trim().split("\n");
		expect(line?.split("\t")).toEqual([
			expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
			CORE,
			`${tool} not found — ${tool === "npm" ? "legitimacy" : "download history"} of left-pad could not be checked, denying`,
		]);
	});
});

describe("a link that will not read", () => {
	it("refuses on the record, never reading it as no link", () => {
		const locked = path.join(dir, "locked");
		fs.mkdirSync(locked);
		fs.chmodSync(locked, 0o600);
		try {
			expect(denial(`npm --prefix ${locked} ci`)).toMatch(/EACCES/);
			expect(readFailOpenLog(config, shared)).toMatch(
				/core threw — refused: .*EACCES/,
			);
		} finally {
			fs.chmodSync(locked, 0o700);
		}
	});
});

describe("the fail-open record", () => {
	it.each([
		[
			"an absent package.json",
			() => fs.rmSync(path.join(shared, "package.json")),
			/package\.json at .*\/package\.json is absent — install allowed unchecked/,
		],
		[
			"a package.json that is not JSON",
			() => fs.writeFileSync(path.join(shared, "package.json"), "{ not json"),
			/package\.json did not parse — install allowed unchecked/,
		],
	])("allows and records %s", (_l, damage, match) => {
		damage();
		expect(emission("npm install left-pad")).toBeNull();
		expect(readFailOpenLog(config, shared)).toMatch(match);
	});
});
