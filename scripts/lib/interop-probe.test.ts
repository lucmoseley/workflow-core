// @vitest-environment node
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
	it("falls back to the 12s default where the override is not an integer", () => {
		const r = exported("5s");
		expect(r.status).toBe(0);
		expect(r.stdout).toBe("12");
	});

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

	it("honours an override of one attempt", () => {
		expect(attempts("1").stdout).toBe("1");
	});

	it.each(["00", "3x", ""])("resets %j to the default of three", (v) => {
		expect(attempts(v).stdout).toBe("3");
	});
});
