// @vitest-environment node
/*
 * Holds lib/checker-run-fake.ts to the real core checkers (§G7, #5148): each
 * checker's `--json` run as scripts/file-morning-review.js's adapters spawn
 * it, under the morning review fixture (its count-free core, served gh and
 * no WSL), against the fake's recorded envelope. Shape and verdict, never
 * values: the same keys, each of the same type, and the same outcome.
 * Loosened, lib/morning-review-filing.test.ts stays green on an envelope a
 * checker no longer prints, and the review renders a section from fields
 * nothing fills.
 *
 * Red after a checker's envelope changed: print the real side's envelope
 * and re-record the fake's from it.
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import { expect, it } from "vitest";
import { freshSandbox } from "./arbiter-testkit";
import { CHECKER_ENVELOPES, checkerFake } from "./checker-run-fake";
import { morningReviewFixture } from "./morning-review-fixture";

const { parseEnvelope } = require("./check-envelope.js");

const sb = freshSandbox();
const { runEnv, seed, wfc } = morningReviewFixture(
	sb,
	path.resolve(__dirname, "..", "file-morning-review.js"),
);

/** Each key's type, arrays told apart from objects. */
const shapeOf = (envelope: Record<string, unknown>) =>
	Object.fromEntries(
		Object.entries(envelope)
			.map(([k, v]) => [k, Array.isArray(v) ? "array" : typeof v] as const)
			.sort(([a], [b]) => a.localeCompare(b)),
	);

it.each([
	{ script: "check-primitives.js", args: () => ["--root", wfc()] },
	{ script: "check-idle-efforts.js", args: () => [] },
	{ script: "check-wsl-currency.js", args: () => [] },
])(
	"$script prints an envelope of the fake's shape and outcome",
	({ script, args }) => {
		seed([]);
		const env = runEnv();
		// spawn-kept: the real side runs where the production adapter does, and the shell's adapter spawns the checker
		const real = spawnSync(
			process.execPath,
			[path.join(env.WFC_SCRIPT_ROOT, "scripts", script), "--json", ...args()],
			{ cwd: wfc(), env, encoding: "utf8" },
		);
		const realEnvelope = parseEnvelope(real.stdout);
		expect(realEnvelope, real.stderr).not.toBeNull();
		const fake = parseEnvelope(checkerFake().runChecker(script).stdout);
		expect(fake).toEqual(CHECKER_ENVELOPES[script]);
		expect(shapeOf(fake)).toEqual(shapeOf(realEnvelope));
		expect(fake.outcome).toBe(realEnvelope.outcome);
	},
);
