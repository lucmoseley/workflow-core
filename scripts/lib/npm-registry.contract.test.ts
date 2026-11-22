// @vitest-environment node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeTreeClassifier } from "./git-tree-fake.js";
import { kitContextFake } from "./kit-context-fake";
import {
	buildPassingRegistry,
	type Call,
	downloadsAnswer,
	npmViewAnswer,
	type Registry,
	writeRegistryStubs,
} from "./npm-registry-fake";

const { decide } = require("./npm-install.js") as {
	decide: (command: string, ctx: object) => { deny: string } | null;
};
const { buildHostPorts } = require("./npm-install-host.js") as {
	buildHostPorts: (env: { root: string }) => {
		npmView: (pkg: string) => Call;
		downloads: (pkg: string) => Call;
	};
};

type Port = "npmView" | "downloads";

const PASSING = buildPassingRegistry(Date.now());

const PUBLIC_REGISTRY = "https://registry.npmjs.org/";

const DEAD = "http://127.0.0.1:9";

type Real = "live" | "cut" | "absent";

const CASES: {
	what: string;
	pkg: string;
	reg: Registry;
	ports: Port[];
	verdict: RegExp | null;
	real: Real;
}[] = [
	{
		what: "an existing package",
		pkg: "left-pad",
		reg: PASSING,
		ports: ["npmView", "downloads"],
		verdict: null,
		real: "live",
	},
	{
		what: "a missing package",
		pkg: "wfc-contract-no-such-package-7f3a9c",
		reg: { ...PASSING, created: "E404" },
		ports: ["npmView"],
		verdict: /^No package named/,
		real: "live",
	},
	{
		what: "an unreachable registry",
		pkg: "left-pad",
		reg: { created: "FAIL", downloads: "FAIL" },
		ports: ["npmView", "downloads"],
		verdict: /could not be reached/,
		real: "cut",
	},
	{
		what: "a registry program that will not start",
		pkg: "left-pad",
		reg: { created: "MISSING", downloads: "MISSING" },
		ports: ["npmView", "downloads"],
		verdict: /could not be reached/,
		real: "absent",
	},
];

function verdictOf(port: Port, pkg: string, answer: Call): string | null {
	const ctx = kitContextFake({
		isDir: () => true,
		treeClass: fakeTreeClassifier({ "/repo": "shared" }),
		tree: () => ({
			root: "/repo",
			readText: (rel: string) => (rel === "package.json" ? "{}" : null),
		}),
		pathExists: () => false,
		linkTarget: () => null,
		npmView: () => npmViewAnswer(PASSING),
		downloads: () => downloadsAnswer(PASSING),
		[port]: () => answer,
		now: () => Date.now(),
		startedAt: () => Date.now(),
		allowNewPackage: false,
	});
	return decide(`npm i --ignore-scripts ${pkg}`, ctx)?.deny ?? null;
}

function shapeOf(answer: Call): unknown {
	if ("missing" in answer) return "missing";
	if (answer.stdout === "") return { exited0: answer.status === 0, out: "" };
	let body: unknown;
	try {
		body = JSON.parse(answer.stdout);
	} catch {
		return { exited0: answer.status === 0, out: "text" };
	}
	return { exited0: answer.status === 0, out: typeOf(body) };
}

function typeOf(v: unknown): unknown {
	if (v === null) return "null";
	if (typeof v !== "object") return typeof v;
	return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, typeOf(x)]));
}

let dir: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "npm-registry-"));
	for (const v of ["WFC_NPM", "WFC_CURL", "no_proxy", "NO_PROXY"])
		vi.stubEnv(v, undefined);
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

function cutRegistry() {
	vi.stubEnv("npm_config_registry", `${DEAD}/`);
	vi.stubEnv("npm_config_fetch_retries", "0");
	vi.stubEnv("https_proxy", DEAD);
	vi.stubEnv("HTTPS_PROXY", DEAD);
}

const realAnswer = (port: Port, c: (typeof CASES)[number]) => {
	if (c.real === "live") vi.stubEnv("npm_config_registry", PUBLIC_REGISTRY);
	if (c.real === "cut") cutRegistry();
	if (c.real === "absent") {
		vi.stubEnv("WFC_NPM", path.join(dir, "no-such-npm"));
		vi.stubEnv("WFC_CURL", path.join(dir, "no-such-curl"));
	}
	return buildHostPorts({ root: dir })[port](c.pkg);
};

const stubAnswer = (port: Port, c: (typeof CASES)[number]) => {
	for (const [k, v] of Object.entries(writeRegistryStubs(dir)(c.reg)))
		vi.stubEnv(k, v);
	vi.stubEnv("STUB_CALLS", path.join(dir, "calls.log"));
	return buildHostPorts({ root: dir })[port](c.pkg);
};

const fakeAnswer = (port: Port, c: (typeof CASES)[number]) =>
	port === "npmView" ? npmViewAnswer(c.reg) : downloadsAnswer(c.reg);

let liveSkip: { reason: string | undefined } | undefined;
function liveSkipReason(): string | undefined {
	for (const url of [
		`${PUBLIC_REGISTRY}-/ping`,
		"https://api.npmjs.org/downloads/point/last-month/left-pad",
	]) {
		const { status } = spawnSync(
			"curl",
			["-fsS", "-o", "/dev/null", "--max-time", "8", url],
			{ stdio: "ignore" },
		);
		if (status !== 0) return `the npm registry is unreachable: ${url}`;
	}
	return undefined;
}

describe.each(CASES)("$what", (c) => {
	it.for(c.ports)(
		"%s answers alike from the real adapter, the stubs and the in-process fake",
		// guess: two 8 s probes, then npm's 12 s and curl's 8 s, #2912
		{ timeout: 40_000 },
		(port, ctx) => {
			if (c.real === "live") {
				liveSkip ??= { reason: liveSkipReason() };
				if (liveSkip.reason) return ctx.skip(liveSkip.reason);
			}
			const fake = fakeAnswer(port, c);
			expect(verdictOf(port, c.pkg, fake)).toEqual(
				c.verdict === null ? null : expect.stringMatching(c.verdict),
			);
			for (const answer of [realAnswer(port, c), stubAnswer(port, c)]) {
				expect(shapeOf(answer)).toEqual(shapeOf(fake));
				expect(verdictOf(port, c.pkg, answer)).toEqual(
					verdictOf(port, c.pkg, fake),
				);
			}
		},
	);
});
