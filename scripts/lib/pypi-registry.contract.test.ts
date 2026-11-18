// @vitest-environment node
/*
 * The PyPI fake's contract (§G7, #5232): one case list run against
 * lib/pip-install-host.js's real curl calls, against lib/pypi-registry-fake.ts's
 * WFC_CURL stub through the same adapter, and against its in-process ports.
 * Each answer gives the same verdict from lib/pip-install.js's `decide` and
 * the same shape in the fields the core reads; values are never compared.
 * Loosened, the guard's tests stay green on a fake while the guard misreads
 * what PyPI or pypistats really answers.
 *
 * Red after an API change: re-run the case's URL by hand, copy what changed
 * into lib/pypi-registry-fake.ts.
 */

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

const { decide } = require("./pip-install.js") as {
	decide: (command: string, ctx: object) => { deny: string } | null;
};
const { buildHostPorts } = require("./pip-install-host.js") as {
	buildHostPorts: () => Record<Port, (name: string) => Get>;
};

type Port = "pypi" | "stats";
type Real = "live" | "cut" | "absent";

const PASSING = buildPassingPyPI(Date.now());

/** Port 9, discard, which nothing listens on here. */
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

/** The verdict `decide` gives an install of `pkg` where `port` answers
 * `answer` and the other port passes. */
function verdictOf(port: Port, pkg: string, answer: Get): string | null {
	const ctx = kitContextFake({
		tree: () => ({
			root: "/repo",
			git: () => ({ ok: true, out: "" }),
			readText: () => null,
			repoRel: (f: string) => f,
		}),
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

// Residual: where the public services do not answer, the live cases skip and
// the fake's success and 404 answers go unchecked. The probe reads PyPI's
// cached paths; a made-up name's 404 comes from its origin, which can stall
// past curl's 8 s while the probe answers (#5402), so a live case whose own
// call goes unanswered skips too.
let liveSkip: { reason: string | undefined } | undefined;
function liveSkipReason(): string | undefined {
	for (const url of [
		"https://pypi.org/pypi/playwright/json",
		"https://pypistats.org/api/packages/playwright/recent",
	]) {
		const { status } = spawnSync(
			"curl",
			["-fsS", "-o", "/dev/null", "--max-time", "8", url],
			{ stdio: "ignore" },
		);
		if (status !== 0) return `PyPI or pypistats is unreachable: ${url}`;
	}
	return undefined;
}

/** Why a live answer says nothing of the contract: the service gave none. */
function unanswered(answer: Get): string | undefined {
	if ("missing" in answer) return undefined;
	if (answer.code === null) return "curl got no answer";
	if (answer.code === 429 || answer.code >= 500)
		return `the service answered ${answer.code}`;
	return undefined;
}

describe.each(CASES)("$what", (c) => {
	it.for(c.ports)(
		"%s answers alike from the real adapter, the stub and the in-process fake",
		// At worst the two 8 s probes on the first live case, then curl's 8 s.
		{ timeout: 30_000 },
		(port, ctx) => {
			if (c.real === "live") {
				liveSkip ??= { reason: liveSkipReason() };
				if (liveSkip.reason) return ctx.skip(liveSkip.reason);
			}
			const fake = fakeAnswer(port, c);
			expect(verdictOf(port, c.pkg, fake)).toEqual(
				c.verdict === null ? null : expect.stringMatching(c.verdict),
			);
			const real = realAnswer(port, c);
			const silent = c.real === "live" ? unanswered(real) : undefined;
			if (silent) return ctx.skip(`${port} for ${c.pkg}: ${silent}`);
			for (const answer of [real, stubAnswer(port, c)]) {
				expect(shapeOf(answer)).toEqual(shapeOf(fake));
				expect(verdictOf(port, c.pkg, answer)).toEqual(
					verdictOf(port, c.pkg, fake),
				);
			}
		},
	);
});
