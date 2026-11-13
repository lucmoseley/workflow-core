// @vitest-environment node
/*
 * Pins the interop-bridge probe's shipped budget end to end (mantahostels#3111,
 * mantahostels#3535): a wedged Windows bridge refuses the dispatch inside the
 * 45s docs/environment.md §9 gives it, at the default 3 x 12s attempts.
 *
 * The real expiry against a hung reg.exe is dispatch-sessions-bridge.test.ts's.
 *
 * Loosen it and a raised budget, grace or attempt count lets a dispatch hang
 * on a wedged bridge past the time its caller reports in.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { dispatchFixture } from "./lib/dispatch-sessions-testkit";
import { readText } from "./lib/file-read.js";
import { shellQuote } from "./lib/sh-quote.js";

const fx = dispatchFixture();
const { stubClaude, regWedged, run } = fx;

/** docs/environment.md §9: the time the dispatcher's caller reports in by. */
const REPORT_IN_S = 45;

function seconds(raw: string | undefined): number {
	if (!/^\d+$/.test(raw ?? ""))
		throw new Error(`unparsed duration ${JSON.stringify(raw)}`);
	return Number(raw);
}

function worstCase(argv: string[]): number {
	const graced = argv[0] === "-k";
	return seconds(argv[graced ? 2 : 0]) + (graced ? seconds(argv[1]) : 0);
}

describe("the interop-bridge probe's shipped budget (mantahostels#3111)", () => {
	it("refuses inside 45s at the shipped probe budget", () => {
		stubClaude({});
		const reg = regWedged();
		const log = path.join(fx.dir, "probe-calls");
		const bin = path.join(fx.dir, "timeout-bin");
		fs.mkdirSync(bin, { recursive: true });
		/* `timeout` and `sleep` on PATH: #146 forbids
		 * a seam added to the dispatcher for a test, and the shell's command
		 * resolution is one already there. Each probe call counts with its
		 * `-k` grace, the wait a TERM-ignoring reg.exe adds; every `sleep` counts
		 * too, so a wait between attempts is caught. */
		const realTimeout = execFileSync("bash", ["-c", "command -v timeout"], {
			encoding: "utf8",
		}).trim();
		fs.writeFileSync(
			path.join(bin, "timeout"),
			[
				"#!/bin/bash",
				`for a in "$@"; do [[ "$a" == ${shellQuote(reg)} ]] && { printf '%s\\n' "$*" >> ${shellQuote(log)}; exit 124; }; done`,
				`exec ${shellQuote(realTimeout)} "$@"`,
			].join("\n"),
			{ mode: 0o755 },
		);
		const sleeps = path.join(fx.dir, "sleeps");
		fs.writeFileSync(
			path.join(bin, "sleep"),
			`#!/bin/bash\nprintf '%s\\n' "$1" >> ${shellQuote(sleeps)}\n`,
			{ mode: 0o755 },
		);
		const r = run(["sonnet", "/implement 341"], {
			CLAUDE_INTEROP_REG: reg,
			/* Empty reads as unset, so the shipped defaults hold over the ones an
			 * interactive shell exports from sourcing the library. */
			CLAUDE_INTEROP_PROBE_TIMEOUT: "",
			CLAUDE_INTEROP_PROBE_ATTEMPTS: "",
			PATH: `${bin}:${process.env.PATH ?? ""}`,
		});
		expect(r.code).toBe(5);
		const calls = fs
			.readFileSync(log, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => line.split(" "));
		expect(calls.length).toBeGreaterThan(0);
		const read = readText(sleeps);
		if (read.state === "unreadable") throw read.error;
		const slept =
			read.state === "read" ? read.data.split("\n").filter(Boolean) : [];
		const total =
			calls.reduce((sum, argv) => sum + worstCase(argv), 0) +
			slept.reduce((sum, s) => sum + Number(s), 0);
		expect(total).toBeLessThan(REPORT_IN_S);
	});
});
