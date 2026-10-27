// @vitest-environment node
/*
 * The escape-line audit's batch and report (#671 step 3), each run end to end
 * through `runInProcessAsync`: a stub gateway on a local port answers for Jev,
 * and a stub gitleaks stands in for the sweep. The detached batch a
 * `--notify` starts is never let spawn here — it would read this machine's
 * real transcripts — so only its throttle and switch are driven.
 *
 * Its `--notify` runs at every SessionStart, and its windows are the evidence
 * #671's loosening is kept or reversed on: loosen a case and a miscounted or
 * mis-windowed verdict tips that decision, or an unswept question block
 * reaches the gateway.
 */

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import audit from "./lib/escape-audit.js";
import { runInProcessAsync } from "./lib/run-in-process";

const SCRIPT = path.join(__dirname, "audit-escape-lines.js");
const ENV_KEYS = [
	"AI_GATEWAY_API_KEY",
	"WFC_JEV_BASE_URL",
	"WFC_GITLEAKS",
	"CLAUDE_CONFIG_DIR",
] as const;

let dir: string;
let transcripts: string;
let saved: Record<string, string | undefined>;
const servers: http.Server[] = [];

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "audit-escape-"));
	transcripts = path.join(dir, "projects");
	fs.mkdirSync(transcripts);
	saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
	for (const k of ENV_KEYS) delete process.env[k];
	process.env.CLAUDE_CONFIG_DIR = path.join(dir, "config");
});

afterEach(() => {
	for (const k of ENV_KEYS)
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	for (const s of servers.splice(0)) s.close();
	fs.rmSync(dir, { recursive: true, force: true });
});

const round = (n: number, line: string) =>
	`❓ **Q${n}** — Which?\n\nRelation: rivals for one slot\n\n` +
	"(A) option A\nConfidence: 55% (45% - 65%). why\n\n" +
	"(B) option B\nConfidence: 45% (35% - 55%). why\n\n" +
	`${line}\n\n➡ (A).`;

function session(name: string, at: string, ...texts: string[]) {
	const lines = texts.flatMap((text) => [
		JSON.stringify({
			type: "user",
			timestamp: at,
			message: { role: "user", content: "go" },
		}),
		JSON.stringify({
			type: "assistant",
			timestamp: at,
			message: { role: "assistant", content: [{ type: "text", text }] },
		}),
	]);
	fs.writeFileSync(
		path.join(transcripts, `${name}.jsonl`),
		`${lines.join("\n")}\n`,
	);
}

/** A gateway answering each ask from `answers` in turn: a probability, or a status to fail with. */
async function gateway(answers: (number | { status: number })[]) {
	let calls = 0;
	const server = http.createServer((req, res) => {
		req.resume();
		req.on("end", () => {
			const a = answers[Math.min(calls++, answers.length - 1)];
			if (typeof a === "number") {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(
					JSON.stringify({
						answers: {
							bears_on_separator: { type: "boolean", probability: a },
						},
					}),
				);
			} else {
				res.writeHead(a.status);
				res.end("down");
			}
		});
	});
	servers.push(server);
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
	const addr = server.address();
	if (!addr || typeof addr === "string") throw new Error("no port");
	return { base: `http://127.0.0.1:${addr.port}`, calls: () => calls };
}

function gitleaks(code: number) {
	const file = path.join(dir, `gitleaks-${code}`);
	/* A finding only on a non-empty input: the sweep's empty-input probe must
	 * read clean, or the guard files it unswept rather than a finding. */
	fs.writeFileSync(
		file,
		`#!/bin/sh\n[ -n "$(cat)" ] && exit ${code}\nexit 0\n`,
		{
			mode: 0o755,
		},
	);
	return file;
}

async function callable(answers: (number | { status: number })[], sweep = 0) {
	const g = await gateway(answers);
	process.env.AI_GATEWAY_API_KEY = "test-key";
	process.env.WFC_JEV_BASE_URL = g.base;
	process.env.WFC_GITLEAKS = gitleaks(sweep);
	return g;
}

/** One `--judge` run over the fixture transcripts; its JSON summary line. */
const run = async () => {
	const r = await runInProcessAsync(
		SCRIPT,
		["--judge", "--root", dir, "--transcripts", transcripts, "--gap-ms", "0"],
		{ env: { ...process.env } },
	);
	expect(r.status).toBe(0);
	return JSON.parse(r.stdout);
};
const readOutcomes = () =>
	[...audit.readVerdicts(dir).values()].map((v) => v.outcome).sort();

describe("the batch", () => {
	it("judges each item once, filing bears at 0.5 and above", async () => {
		session("s1", "2026-09-28T12:00:00Z", round(1, "Checked: read it; B wins"));
		session(
			"s2",
			"2026-09-28T12:00:00Z",
			round(1, "Unmeasured: taste, because"),
		);
		const g = await callable([0.9, 0.1]);
		expect(await run()).toMatchObject({ items: 2, answered: 2, failed: 0 });
		expect(readOutcomes()).toEqual(["bears", "misses"]);
		await run();
		expect(g.calls()).toBe(2);
	});

	it("records an outage and retries it on the next run", async () => {
		session("s1", "2026-09-28T12:00:00Z", round(1, "Checked: read it"));
		const g = await callable([{ status: 500 }, { status: 500 }, 0.8]);
		expect(await run()).toMatchObject({ answered: 0, failed: 1 });
		expect(readOutcomes()).toEqual(["outage"]);
		expect(await run()).toMatchObject({ answered: 1 });
		expect(readOutcomes()).toEqual(["bears"]);
		expect(g.calls()).toBe(3);
	});

	it("sends nothing gitleaks flags, and never retries it", async () => {
		session("s1", "2026-09-28T12:00:00Z", round(1, "Checked: read it"));
		const g = await callable([0.9], 1);
		await run();
		await run();
		expect(readOutcomes()).toEqual(["finding"]);
		expect(g.calls()).toBe(0);
	});

	it("indexes but sends nothing without a key", async () => {
		session("s1", "2026-09-28T12:00:00Z", round(1, "Checked: read it"));
		expect(await run()).toMatchObject({ items: 1, asked: 0, reason: "key" });
		expect(audit.readItems(dir)?.items).toHaveLength(1);
	});

	it("stands aside while another run holds the lock", async () => {
		const markers = path.join(dir, ".claude", "tmp", "markers");
		fs.mkdirSync(markers, { recursive: true });
		fs.writeFileSync(path.join(markers, ".escape-audit-lock"), "1");
		expect(await run()).toMatchObject({ reason: "locked" });
	});
});

describe("the report", () => {
	const outOf = (r: { stdout: string; stderr: string }) =>
		`${r.stdout}${r.stderr}`;
	const report = (args: string[] = [], env: Record<string, string> = {}) =>
		runInProcessAsync(SCRIPT, ["--root", dir, ...args], {
			env: { ...process.env, WFC_ESCAPE_AUDIT: "0", ...env },
		});
	const kicked = () =>
		path.join(dir, ".claude", "tmp", "markers", ".escape-audit-kicked");

	it("says so before any batch has run", async () => {
		expect(outOf(await report())).toContain("has not run here yet");
	});

	it("starts no batch at session start while switched off", async () => {
		await report(["--notify"]);
		expect(fs.existsSync(kicked())).toBe(false);
	});

	it("starts no batch within six hours of the last", async () => {
		fs.mkdirSync(path.dirname(kicked()), { recursive: true });
		fs.writeFileSync(kicked(), "earlier");
		const before = fs.statSync(kicked()).mtimeMs;
		await report(["--notify"], { WFC_ESCAPE_AUDIT: "1" });
		expect(fs.readFileSync(kicked(), "utf8")).toBe("earlier");
		expect(fs.statSync(kicked()).mtimeMs).toBe(before);
	});

	it("tallies judged, share bearing and pending per window and sight", async () => {
		session(
			"s1",
			"2026-09-27T12:00:00Z",
			round(1, "Checked: a"),
			round(2, "Checked: b"),
			round(3, "Checked: c"),
		);
		await callable([0.9, 0.2, { status: 500 }, { status: 500 }]);
		await run();
		const out = outOf(await report());
		expect(out).toMatch(/pre-660 first\s+2 judged,\s+50% bore; 1 pending/);
		expect(out).not.toContain("671 first");
		expect(out).toContain("1061 refuses every close question once again");
		expect(out).toContain("unmeasured (#667)");
	});

	it("prints nothing at session start, a verdict having landed (#2038)", async () => {
		session("s1", "2026-09-27T12:00:00Z", round(1, "Checked: a"));
		await callable([0.9]);
		await run();
		const r = await report(["--notify"]);
		expect(outOf(r)).toBe("");
	});
});
