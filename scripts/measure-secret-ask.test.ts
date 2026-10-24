// @vitest-environment node
/*
 * The corpus reading behind the rate guard-priced-options.js records for its
 * prose secret ask (#1817). Synthetic transcripts in a temp dir, read through
 * `--json` in process (#1369, §G6). Break the ending-message cut and the
 * recorded rate counts mid-turn text the guard never sees; break the dedupe
 * and a resumed session counts its flags twice.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInProcessAsync } from "./lib/run-in-process.js";

const SCRIPT = path.join(__dirname, "measure-secret-ask.js");

let dir: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "secret-ask-"));
	fs.mkdirSync(path.join(dir, "-home-x-repo", "subagents"), {
		recursive: true,
	});
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

const say = (text: string) => ({
	type: "assistant",
	message: { content: [{ type: "text", text }] },
});
const prompt = { type: "user", message: { content: "go on" } };
const toolResult = {
	type: "user",
	message: { content: [{ type: "tool_result", content: "ok" }] },
};

function transcript(name: string, records: object[]) {
	fs.writeFileSync(
		path.join(dir, "-home-x-repo", `${name}.jsonl`),
		`${records.map((r) => JSON.stringify(r)).join("\n")}\n`,
	);
}

async function measure() {
	const r = await runInProcessAsync(SCRIPT, ["--dir", dir, "--json"]);
	return JSON.parse(r.stdout) as {
		messages: number;
		flags: { file: string; line: number; phrase: string }[];
	};
}

describe("measure-secret-ask", () => {
	it("reads only ending messages, once each, and flags the prose ask", async () => {
		const records = [
			say("Paste the token into `.env` first."),
			toolResult,
			say("Now paste your API key into `.env`, then tell me done."),
			prompt,
			say("Done; nothing else waits."),
		];
		transcript("a", records);
		transcript("a-resumed", records);
		fs.writeFileSync(
			path.join(dir, "-home-x-repo", "subagents", "agent-1.jsonl"),
			`${JSON.stringify(say("Paste the token here."))}\n`,
		);
		const { messages, flags } = await measure();
		expect(messages).toBe(2);
		expect(flags).toHaveLength(1);
		expect(flags[0].phrase).toBe("paste your API key");
		expect(flags[0].line).toBe(3);
	});

	it("exits 1 where no directory is readable, never a zero count", async () => {
		const r = await runInProcessAsync(SCRIPT, [
			"--dir",
			path.join(dir, "absent"),
		]);
		expect(r.status).toBe(1);
		expect(r.stderr).toContain(path.join(dir, "absent"));
		expect(r.stderr).toContain("Pass --dir <projects dir>");
	});

	it("counts no message stamped after --until", async () => {
		transcript("b", [
			{ ...say("Paste your API key here."), timestamp: "2026-10-15T23:59:00Z" },
			prompt,
			{
				...say("Paste your API token here."),
				timestamp: "2026-10-16T00:01:00Z",
			},
		]);
		const r = await runInProcessAsync(SCRIPT, [
			"--dir",
			dir,
			"--until",
			"2026-10-15",
			"--json",
		]);
		const { messages, flags } = JSON.parse(r.stdout);
		expect(messages).toBe(1);
		expect(flags[0].phrase).toBe("Paste your API key");
	});
});
