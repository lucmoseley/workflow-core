// @vitest-environment node
/*
 * Pins that the bundle-cost instrument prices each cache write at its own TTL
 * (#1203) and refuses a malformed `--since` or an unknown flag with exit 2
 * (mantahostels#1094, the measurement).
 *
 * Drives the real script through lib/run-in-process.js (§X3), over a corpus of
 * one-session transcripts minted per test in a temp dir.
 *
 * CI's vitest step runs this file; the script itself gates nothing and is run
 * by hand. Breaking it skews the bundle costs
 * `.claude/skills/pick-next/references/measured-figures.md` cites, which
 * `/pick-next` sizes its dispatch bundles by.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInProcess } from "./lib/run-in-process.js";

const SCRIPT = path.join(__dirname, "measure-bundle-cost.js");

let corpus: string;

beforeEach(() => {
	corpus = fs.mkdtempSync(path.join(os.tmpdir(), "wfc-bundle-cost-"));
});

afterEach(() => {
	fs.rmSync(corpus, { recursive: true, force: true });
});

let seq = 0;

/** One solo session: a user turn, then one assistant turn that closes #12. */
const session = (usage: Record<string, unknown>) => {
	const id = `sess-${++seq}`;
	const at = "2026-10-01T00:00:00Z";
	const lines = [
		{ type: "user", timestamp: at, message: { role: "user", content: "go" } },
		// Not transcript-testkit's buildBashCall: the cost read needs `message.id`
		// and `message.usage`, which it does not set.
		{
			type: "assistant",
			timestamp: at,
			message: {
				id: `${id}-msg`,
				usage: { input_tokens: 0, output_tokens: 0, ...usage },
				content: [
					{
						type: "tool_use",
						name: "Bash",
						input: { command: "gh issue close 12" },
					},
				],
			},
		},
	];
	fs.writeFileSync(
		path.join(corpus, `${id}.jsonl`),
		`${lines.map((l) => JSON.stringify(l)).join("\n")}\n`,
	);
};

const run = (args: string[] = []) =>
	runInProcess(SCRIPT, args, {
		env: { ...process.env, WFC_TRANSCRIPT_DIR: corpus },
	});

/** The solo band's row, whose third column is the median $/session. */
const soloRow = (stdout: string) =>
	stdout.split("\n").find((l) => /^1\s+\d+\s+\$/.test(l)) ?? "";

describe("pricing each cache write at its own TTL (#1203)", () => {
	// Opus 5 dollars: a 5-minute write is $18.75/Mtok, a 1-hour write $30.
	it("prices a 1-hour write at 2x fresh input", () => {
		session({
			cache_creation_input_tokens: 1_000_000,
			cache_creation: { ephemeral_1h_input_tokens: 1_000_000 },
		});

		const r = run(["--since", "2026-09-01"]);
		expect(r.status).toBe(0);
		expect(soloRow(r.stdout)).toContain("$30.00");
	});

	it("prices a write the split does not cover at the 5-minute 1.25x", () => {
		session({ cache_creation_input_tokens: 1_000_000 });

		const r = run(["--since", "2026-09-01"]);
		expect(r.status).toBe(0);
		expect(soloRow(r.stdout)).toContain("$18.75");
	});
});

describe("refusals", () => {
	it("exits 2 naming the date format on a --since that is not a date", () => {
		const r = run(["--since", "nope"]);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("--since needs an ISO date, e.g. 2026-08-18.");
	});

	it("exits 2 with the usage on an unknown flag", () => {
		const r = run(["--until", "2026-09-01"]);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("unknown flag: --until");
		expect(r.stderr).toContain("Usage: node scripts/measure-bundle-cost.js");
	});
});
