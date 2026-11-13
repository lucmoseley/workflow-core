// @vitest-environment node
/*
 * Holds lib/checker-run-fake.ts to the real core checkers (§G7, #5148): each
 * checker run through lib/checker-run.js, the shell's own adapters, under the
 * morning review fixture (its count-free core and served gh), off WSL and, for
 * the WSL check, on a stub WSL too, against the fake's recorded envelope. Shape and verdict, never
 * values: the same keys, each of the same type, and the same outcome.
 * Loosened, lib/morning-review-filing.test.ts stays green on an envelope a
 * checker no longer prints, and the review renders a section from fields
 * nothing fills.
 *
 * Red after a checker's envelope changed: print the real side's envelope
 * and re-record the fake's from it.
 */

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

/** A WSL machine whose installed version reads, for check-wsl-currency.js. */
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
		// spawn-kept: the real side is the shell's own adapter, lib/checker-run.js, which spawns the checker
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
