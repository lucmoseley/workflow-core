// @vitest-environment node
/*
 * The registry fake's contract (§G7, #2207, #2912): one case list run against
 * lib/npm-install-host.js's real `npm view` and curl calls, against
 * lib/npm-registry-fake.ts's WFC_NPM and WFC_CURL stubs through the same
 * adapter, and against its in-process ports. Each answer gives the same
 * verdict from lib/npm-install.js's `decide` and, where it is JSON, the same
 * keys and types; values are never compared. Loosened, the guard's tests stay
 * green on a fake while the guard misreads what npm or the downloads API
 * really answers.
 *
 * The unreachable case points npm's registry and curl's proxy at a closed
 * local port, and the not-starting case points WFC_NPM and WFC_CURL at no
 * program, so both need no network and run wherever npm and curl do. The
 * other two ask the public registry, and skip, saying so, where it does not
 * answer.
 *
 * Red after an npm or API change: re-run the case's call by hand, copy what
 * changed into lib/npm-registry-fake.ts.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

/** The registry the live cases ask, whatever npm's own config names. */
const PUBLIC_REGISTRY = "https://registry.npmjs.org/";

/** Port 9, discard, which nothing listens on here: a connection to it is
 * refused at once. */
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
		// The downloads port is never asked about a name npm does not have.
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

/** The verdict `decide` gives an install of `pkg` where `port` answers
 * `answer` and the other port passes. */
function verdictOf(port: Port, pkg: string, answer: Call): string | null {
	const ctx = kitContextFake({
		isDir: () => true,
		treeClass: fakeTreeClassifier({ "/repo": "shared" }),
		readPackageJson: () => ({ path: "/repo/package.json", text: "{}" }),
		readManifest: () => null,
		npmView: () => npmViewAnswer(PASSING),
		downloads: () => downloadsAnswer(PASSING),
		[port]: () => answer,
		now: () => Date.now(),
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
const SAVED_ENV = { ...process.env };

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "npm-registry-"));
	for (const v of ["WFC_NPM", "WFC_CURL", "no_proxy", "NO_PROXY"])
		delete process.env[v];
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
	process.env = { ...SAVED_ENV };
});

function cutRegistry() {
	process.env.npm_config_registry = `${DEAD}/`;
	process.env.npm_config_fetch_retries = "0";
	process.env.https_proxy = DEAD;
	process.env.HTTPS_PROXY = DEAD;
}

const realAnswer = (port: Port, c: (typeof CASES)[number]) => {
	if (c.real === "live") process.env.npm_config_registry = PUBLIC_REGISTRY;
	if (c.real === "cut") cutRegistry();
	if (c.real === "absent") {
		process.env.WFC_NPM = path.join(dir, "no-such-npm");
		process.env.WFC_CURL = path.join(dir, "no-such-curl");
	}
	return buildHostPorts({ root: dir })[port](c.pkg);
};

const stubAnswer = (port: Port, c: (typeof CASES)[number]) => {
	Object.assign(process.env, writeRegistryStubs(dir)(c.reg), {
		STUB_CALLS: path.join(dir, "calls.log"),
	});
	return buildHostPorts({ root: dir })[port](c.pkg);
};

const fakeAnswer = (port: Port, c: (typeof CASES)[number]) =>
	port === "npmView" ? npmViewAnswer(c.reg) : downloadsAnswer(c.reg);

// Residual: where the public registry does not answer, the live cases skip
// and the fake's success and E404 answers go unchecked.
let liveSkip: { reason: string | undefined } | undefined;
function liveSkipReason(): string | undefined {
	for (const url of [
		`${PUBLIC_REGISTRY}-/ping`,
		"https://api.npmjs.org/downloads/point/last-month/left-pad",
	]) {
		// The adapter's own curl limit.
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
		// At worst the two 8 s probes on the first live case, then npm's own 12 s
		// limit and curl's 8 s: 36 s.
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
