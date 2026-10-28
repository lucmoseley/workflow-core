// @vitest-environment node
/*
 * Pins session-context.js's reading and verdict against the cap, and its
 * refusal to report an unreadable transcript as a low figure.
 *
 * The live-context reader driven as a subprocess, the way a bundle session at a
 * member boundary drives it.
 *
 * A reading is a reading whether it is over or under the cap — exit 0 either
 * way, because nothing is enforced on this (mantahostels#1094, the ticket that capped a
 * dispatch bundle on accumulated context). And an UNREADABLE transcript must
 * never degrade to a low number: a session that reads 0 tokens of standing
 * context would merge on for ever.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runInProcess } from "./lib/run-in-process.js";

const SCRIPT = path.join(__dirname, "session-context.js");
const SID = "11111111-2222-3333-4444-555555555555";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0))
		fs.rmSync(d, { recursive: true, force: true });
});

/** A config dir laid out the way Claude Code lays one out. */
function configDir() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sessctx-"));
	dirs.push(dir);
	fs.mkdirSync(path.join(dir, "projects", "-home-lucmo-mantahostels"), {
		recursive: true,
	});
	return dir;
}

function writeTranscript(cfg: string, sid: string, ...lines: unknown[]) {
	fs.writeFileSync(
		path.join(cfg, "projects", "-home-lucmo-mantahostels", `${sid}.jsonl`),
		lines
			.map((l) => (typeof l === "string" ? l : JSON.stringify(l)))
			.join("\n"),
	);
}

/** An assistant turn whose request carried `ctx` tokens of standing context. */
const turn = (ctx: number, extra: Record<string, unknown> = {}) => ({
	type: "assistant",
	timestamp: "2026-08-22T04:00:00.000Z",
	message: {
		id: `msg_${ctx}`,
		usage: {
			input_tokens: 2,
			cache_creation_input_tokens: 1000,
			cache_read_input_tokens: ctx - 1002,
			output_tokens: 400,
		},
	},
	...extra,
});

const run = (cfg: string, args: string[] = []) =>
	runInProcess(SCRIPT, args, {
		env: {
			...process.env,
			CLAUDE_CONFIG_DIR: cfg,
			CLAUDE_CODE_SESSION_ID: SID,
		},
	});

describe("session-context", () => {
	it("reports the standing context of the last assistant turn", () => {
		const cfg = configDir();
		writeTranscript(cfg, SID, turn(50_000), turn(120_000));
		const r = run(cfg);
		expect(r.status).toBe(0);
		expect(r.stdout).toMatch(/120,000 tokens/);
	});

	it("counts a subagent's turns against the subagent, not the parent", () => {
		const cfg = configDir();
		writeTranscript(
			cfg,
			SID,
			turn(120_000),
			turn(400_000, { isSidechain: true }),
		);
		expect(run(cfg).stdout).toMatch(/120,000 tokens/);
	});

	it("skips a malformed line rather than dying on it", () => {
		const cfg = configDir();
		writeTranscript(cfg, SID, turn(120_000), "{not json", "");
		const r = run(cfg);
		expect(r.status).toBe(0);
		expect(r.stdout).toMatch(/120,000 tokens/);
	});

	it("calls a bundle under the cap safe to extend", () => {
		const cfg = configDir();
		writeTranscript(cfg, SID, turn(120_000));
		const out = run(cfg).stdout;
		expect(out).toMatch(/UNDER/);
		expect(out).not.toMatch(/OVER/);
	});

	it("tells a bundle over the cap to stop at this member boundary", () => {
		const cfg = configDir();
		writeTranscript(cfg, SID, turn(260_000));
		const r = run(cfg);
		expect(r.status).toBe(0);
		expect(r.stdout).toMatch(/OVER/);
		expect(r.stdout).toMatch(/boundary/i);
	});

	it("takes a cap override", () => {
		const cfg = configDir();
		writeTranscript(cfg, SID, turn(120_000));
		expect(run(cfg, ["--cap", "100000"]).stdout).toMatch(/OVER/);
	});

	it("reads the session named in argv over the one in the environment", () => {
		const cfg = configDir();
		const other = "99999999-8888-7777-6666-555555555555";
		writeTranscript(cfg, SID, turn(120_000));
		writeTranscript(cfg, other, turn(310_000));
		expect(run(cfg, [other]).stdout).toMatch(/310,000 tokens/);
	});

	it("refuses to read a missing transcript as a low figure", () => {
		const cfg = configDir();
		const r = run(cfg);
		expect(r.status).toBe(2);
		expect(r.stdout + r.stderr).toMatch(/not a low reading/i);
		expect(r.stdout + r.stderr).not.toMatch(/UNDER/);
	});

	it("refuses to read a transcript with no usage record yet as a low figure", () => {
		const cfg = configDir();
		writeTranscript(cfg, SID, { type: "user", message: { content: "hi" } });
		const r = run(cfg);
		expect(r.status).toBe(2);
		expect(r.stdout + r.stderr).toMatch(/not a low reading/i);
	});

	it("says which session it could not identify when nothing names one", () => {
		const cfg = configDir();
		const r = runInProcess(SCRIPT, [], {
			env: {
				...process.env,
				CLAUDE_CONFIG_DIR: cfg,
				CLAUDE_CODE_SESSION_ID: "",
			},
		});
		expect(r.status).toBe(2);
		expect(r.stdout + r.stderr).toMatch(/CLAUDE_CODE_SESSION_ID/);
	});

	it("carries the verdict in --json", () => {
		const cfg = configDir();
		writeTranscript(cfg, SID, turn(260_000));
		const j = JSON.parse(run(cfg, ["--json"]).stdout);
		expect(j).toMatchObject({ tokens: 260_000, cap: 200_000, overCap: true });
	});
});
