// @vitest-environment node

import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { freshSandbox } from "./arbiter-testkit";
import {
	CHECKER_ENVELOPES,
	checkerFake,
	WSL_UNREAD_ENVELOPE,
} from "./checker-run-fake";
import { morningReviewFixture } from "./morning-review-fixture";
import { WSL_KERNEL, writeOsrelease, writeWsl } from "./wsl-fake";

const { runChecker, startChecker } = require("./checker-run.js");
const { parseEnvelope } = require("./check-envelope.js");

const sb = freshSandbox();
const { runEnv, seed, wfc } = morningReviewFixture(
	sb,
	path.resolve(__dirname, "..", "file-morning-review.js"),
);

afterEach(() => vi.unstubAllEnvs());

const shapeOf = (envelope: Record<string, unknown>) =>
	Object.fromEntries(
		Object.entries(envelope)
			.map(([k, v]) => [k, Array.isArray(v) ? "array" : typeof v] as const)
			.sort(([a], [b]) => a.localeCompare(b)),
	);

const onWsl = () => {
	const wsl = path.join(sb.dir, "wsl");
	return {
		WFC_PROC: writeOsrelease(wsl, WSL_KERNEL),
		WFC_WSL_EXE: writeWsl(wsl, { version: "2.7.11.0" }),
	};
};

it.each([
	{
		name: "check-primitives.js",
		script: "check-primitives.js",
		run: () => runChecker("check-primitives.js", ["--root", wfc()], wfc()),
		env: () => ({}),
		envelope: CHECKER_ENVELOPES["check-primitives.js"],
	},
	{
		name: "check-idle-efforts.js",
		script: "check-idle-efforts.js",
		run: () => startChecker("check-idle-efforts.js").settle(),
		env: () => ({}),
		envelope: CHECKER_ENVELOPES["check-idle-efforts.js"],
	},
	{
		name: "check-wsl-currency.js off WSL",
		script: "check-wsl-currency.js",
		run: () => startChecker("check-wsl-currency.js").settle(),
		env: () => ({}),
		envelope: CHECKER_ENVELOPES["check-wsl-currency.js"],
	},
	{
		name: "check-wsl-currency.js on WSL",
		script: "check-wsl-currency.js",
		run: () => startChecker("check-wsl-currency.js").settle(),
		env: onWsl,
		envelope: WSL_UNREAD_ENVELOPE,
	},
])(
	"$name prints an envelope of the fake's shape and outcome",
	async ({ script, run, env, envelope }) => {
		seed([]);
		for (const [key, value] of Object.entries({ ...runEnv(), ...env() }))
			if (value !== undefined && process.env[key] !== value)
				vi.stubEnv(key, value);
		const real = await run();
		const realEnvelope = parseEnvelope(real.stdout ?? "");
		expect(realEnvelope, JSON.stringify(real)).not.toBeNull();
		const fake = parseEnvelope(
			checkerFake({ [script]: envelope }).runChecker(script).stdout,
		);
		expect(fake).toEqual(envelope);
		expect(shapeOf(fake)).toEqual(shapeOf(realEnvelope));
		expect(fake.outcome).toBe(realEnvelope.outcome);
	},
);
