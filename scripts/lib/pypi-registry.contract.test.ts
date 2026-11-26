// @vitest-environment node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { kitContextFake } from "./kit-context-fake";
import {
	buildPassingPyPI,
	type Get,
	type PyPI,
	pypiAnswer,
	statsAnswer,
	writePyPIStub,
} from "./pypi-registry-fake";
import { treePortsFake } from "./tree-ports-fake";

const { decide } = require("./pip-install.js") as {
	decide: (command: string, ctx: object) => { deny: string } | null;
};
const { URLS, buildHostPorts } = require("./pip-install-host.js") as {
	URLS: Record<Port, (name: string) => string>;
	buildHostPorts: () => Record<Port, (name: string) => Get>;
};

type Port = "pypi" | "stats";
type Real = "live" | "cut" | "absent";

const PASSING = buildPassingPyPI(Date.now());

const DEAD = "http://127.0.0.1:9";

const CASES: {
	what: string;
	pkg: string;
	reg: PyPI;
	ports: Port[];
	verdict: RegExp | null;
	real: Real;
}[] = [
	{
		what: "a known package",
		pkg: "playwright",
		reg: PASSING,
		ports: ["pypi", "stats"],
		verdict: null,
		real: "live",
	},
	{
		what: "a package with no upload in five years",
		pkg: "toml",
		reg: {
			...PASSING,
			created: "2013-02-24T22:07:02.172879Z",
			latest: "2020-11-01T01:40:22.204866Z",
		},
		ports: ["pypi"],
		verdict: /^`toml` last had a file published \d+ days ago/,
		real: "live",
	},
	{
		what: "a made-up name",
		pkg: "wfc-contract-no-such-package-5232",
		reg: { created: "404", downloads: "404" },
		ports: ["pypi", "stats"],
		verdict:
			/^(No package named|`wfc-contract-no-such-package-5232` was downloaded 0)/,
		real: "live",
	},
	{
		what: "an unreachable PyPI",
		pkg: "playwright",
		reg: { created: "FAIL", downloads: "FAIL" },
		ports: ["pypi", "stats"],
		verdict: /^PyPI could not be reached/,
		real: "cut",
	},
	{
		what: "a curl that will not start",
		pkg: "playwright",
		reg: { created: "MISSING", downloads: "MISSING" },
		ports: ["pypi", "stats"],
		verdict: /^PyPI could not be reached/,
		real: "absent",
	},
];

function verdictOf(port: Port, pkg: string, answer: Get): string | null {
	const ctx = kitContextFake({
		tree: () => treePortsFake({}),
		pypi: () => pypiAnswer(PASSING),
		stats: () => statsAnswer(PASSING),
		[port]: () => answer,
		now: () => Date.now(),
		startedAt: () => Date.now(),
		allowNewPackage: false,
	});
	return decide(`pip install --only-binary :all: ${pkg}`, ctx)?.deny ?? null;
}

function shapeOf(answer: Get): unknown {
	if ("missing" in answer) return "missing";
	let body: unknown;
	try {
		body = JSON.parse(answer.body);
	} catch {
		return { code: answer.code, body: answer.body === "" ? "" : "text" };
	}
	if (body === null || typeof body !== "object")
		return { code: answer.code, body: typeof body };
	const b = body as Record<string, unknown>;
	if ("releases" in b) {
		const files = Object.values(b.releases as object).flat() as Record<
			string,
			unknown
		>[];
		return {
			code: answer.code,
			releases: [...new Set(files.map((f) => typeof f.upload_time_iso_8601))],
		};
	}
	if ("data" in b)
		return {
			code: answer.code,
			lastMonth: typeof (b.data as Record<string, unknown>).last_month,
		};
	return { code: answer.code, body: "object" };
}

let dir: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "pypi-registry-"));
	for (const v of ["WFC_CURL", "no_proxy", "NO_PROXY"])
		vi.stubEnv(v, undefined);
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

const realAnswer = (port: Port, c: (typeof CASES)[number]) => {
	if (c.real === "cut") {
		vi.stubEnv("https_proxy", DEAD);
		vi.stubEnv("HTTPS_PROXY", DEAD);
	}
	if (c.real === "absent")
		vi.stubEnv("WFC_CURL", path.join(dir, "no-such-curl"));
	return buildHostPorts()[port](c.pkg);
};

const stubAnswer = (port: Port, c: (typeof CASES)[number]) => {
	for (const [k, v] of Object.entries(writePyPIStub(dir)(c.reg)))
		vi.stubEnv(k, v);
	vi.stubEnv("STUB_CALLS", path.join(dir, "calls.log"));
	return buildHostPorts()[port](c.pkg);
};

const fakeAnswer = (port: Port, c: (typeof CASES)[number]) =>
	port === "pypi" ? pypiAnswer(c.reg) : statsAnswer(c.reg);

let liveSkip: { reason: string | undefined } | undefined;
function liveSkipReason(): string | undefined {
	for (const url of [URLS.pypi("playwright"), URLS.stats("playwright")])
		if (!isAnswered(url, { okOnly: true }))
			return `PyPI or pypistats is unreachable: ${url}`;
	return undefined;
}

function isAnswered(url: string, { okOnly = false } = {}): boolean {
	const { status } = spawnSync(
		"curl",
		[
			...(okOnly ? ["-f"] : []),
			"-sS",
			"-o",
			"/dev/null",
			"--max-time",
			"8",
			url,
		],
		{ stdio: "ignore" },
	);
	return status === 0;
}

function silenceReason(port: Port, pkg: string, real: Get): string | undefined {
	if ("missing" in real || real.code !== null) return undefined;
	const url = URLS[port](pkg);
	return isAnswered(url) ? undefined : `no answer from ${url}`;
}

describe.each(CASES)("$what", (c) => {
	it.for(c.ports)(
		"%s answers alike from the real adapter, the stub and the in-process fake",
		// guess, #5402
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
			const alike = (answer: Get) => {
				expect(shapeOf(answer)).toEqual(shapeOf(fake));
				expect(verdictOf(port, c.pkg, answer)).toEqual(
					verdictOf(port, c.pkg, fake),
				);
			};
			const real = realAnswer(port, c);
			alike(stubAnswer(port, c));
			const silence =
				c.real === "live" ? silenceReason(port, c.pkg, real) : undefined;
			if (silence) return ctx.skip(silence);
			alike(real);
		},
	);
});
