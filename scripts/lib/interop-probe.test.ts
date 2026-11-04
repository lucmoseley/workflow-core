// @vitest-environment node
/*
 * The probe library's budget reset, read off what it exports after sourcing.
 * The end-to-end limb — a wedged bridge refused inside 45s at the default —
 * is dispatch-sessions-bridge-budget.test.ts's (mantahostels#3535). It sources the real
 * library in bash, since the reset is shell arithmetic no in-process call runs.
 *
 * dispatch-sessions.sh and the interactive `claude` guard both source this
 * library before every launch, so a loosened case lets a non-integer override
 * set the probe's budget, against the 12s docs/environment.md §9 derives for a
 * wedged interop bridge.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { shellQuote } from "./sh-quote.js";

const LIB = path.resolve(__dirname, "interop-probe.sh");

const exported = (override: string) =>
	spawnSync(
		"bash",
		[
			"-c",
			`source ${shellQuote(LIB)} && printf '%s' "$CLAUDE_INTEROP_PROBE_TIMEOUT"`,
		],
		{
			encoding: "utf8",
			env: { ...process.env, CLAUDE_INTEROP_PROBE_TIMEOUT: override },
		},
	);

describe("CLAUDE_INTEROP_PROBE_TIMEOUT", () => {
	// 12 is docs/environment.md §9's derivation.
	it("falls back to the 12s default where the override is not an integer", () => {
		// `timeout` accepts a `5s` suffix, so the value itself would run.
		const r = exported("5s");
		expect(r.status).toBe(0);
		expect(r.stdout).toBe("12");
	});

	// `[[ -ge ]]` reads a leading zero as octal, where `08` is an error (#3384).
	it("honours a zero-padded override as decimal", () => {
		const r = exported("08");
		expect(r.status).toBe(0);
		expect(r.stderr).toBe("");
		expect(r.stdout).toBe("8");
	});
});

describe("CLAUDE_INTEROP_PROBE_ATTEMPTS", () => {
	const attempts = (override: string) =>
		spawnSync(
			"bash",
			[
				"-c",
				`source ${shellQuote(LIB)} && printf '%s' "$CLAUDE_INTEROP_PROBE_ATTEMPTS"`,
			],
			{
				encoding: "utf8",
				env: { ...process.env, CLAUDE_INTEROP_PROBE_ATTEMPTS: override },
			},
		);

	// dispatch-sessions-bridge.test.ts's wedge cases run on this override.
	it("honours an override of one attempt", () => {
		expect(attempts("1").stdout).toBe("1");
	});

	it.each(["00", "3x", ""])("resets %j to the default of three", (v) => {
		expect(attempts(v).stdout).toBe("3");
	});
});
