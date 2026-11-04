// @vitest-environment node
/*
 * Every script that finds this repo's transcripts by project slug finds one a
 * session wrote from a linked worktree (#4236). Such a session writes under
 * its worktree's own slug, `<main checkout>/.claude/worktrees/<name>`, not the
 * main checkout's (#4229). Break it and every measure and checker reads only
 * the main checkout's sessions, which once every session runs in a worktree
 * is none: each reads an empty corpus, or refuses one that is there.
 *
 * One fixture for every reader: a real main checkout with a linked worktree,
 * and a seat whose only transcript sits under the worktree's slug, with NO
 * main-slug directory, the seat every session in a worktree leaves.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { projectSlug as slug } from "./lib/project-slug.js";
import { runInProcess, runInProcessAsync } from "./lib/run-in-process.js";

const SID = "aaaaaa11-0000-4000-8000-000000000001";

let home = "";
let main = "";
let seat = "";
let transcript = "";
let env: Record<string, string | undefined> = {};

const session = () => {
	const at = new Date().toISOString();
	return [
		{ type: "user", timestamp: at, message: { role: "user", content: "go" } },
		{
			type: "assistant",
			timestamp: at,
			requestId: "req-1",
			uuid: "u-1",
			message: {
				id: "msg-1",
				model: "claude-sonnet-5",
				usage: { input_tokens: 2, output_tokens: 100_000 },
				content: [
					{
						type: "tool_use",
						id: "t1",
						name: "Bash",
						input: { command: "gh issue close 12" },
					},
				],
			},
		},
	]
		.map((r) => JSON.stringify(r))
		.join("\n");
};

beforeAll(() => {
	home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wt-readers-")));
	main = path.join(home, "main");
	const git = (...args: string[]) =>
		execFileSync("git", args, { cwd: main, stdio: "ignore" });
	fs.mkdirSync(main);
	git("init", "-q");
	git(
		"-c",
		"user.name=t",
		"-c",
		"user.email=t@t",
		"commit",
		"-q",
		"--allow-empty",
		"-m",
		"init",
	);
	const worktree = path.join(main, ".claude", "worktrees", "w1");
	git("worktree", "add", "-q", "--detach", worktree);
	fs.writeFileSync(path.join(main, "package.json"), "{}\n");
	const ledger = path.join(
		main,
		".claude",
		"tmp",
		"markers",
		".pick-next",
		"dispatched.jsonl",
	);
	fs.mkdirSync(path.dirname(ledger), { recursive: true });
	fs.writeFileSync(ledger, `${JSON.stringify({ jobId: "aaaaaa11" })}\n`);

	/* At `$HOME/.claude`, the seat `measure-echo-chain.js` reads. */
	seat = path.join(home, ".claude");
	const project = path.join(seat, "projects", slug(worktree));
	fs.mkdirSync(project, { recursive: true });
	transcript = path.join(project, `${SID}.jsonl`);
	fs.writeFileSync(transcript, `${session()}\n`);

	env = {
		...process.env,
		HOME: home,
		CLAUDE_PROJECT_DIR: main,
		CLAUDE_CONFIG_DIR: seat,
		WFC_CLAUDE_CONFIG_A: seat,
		WFC_CLAUDE_CONFIG_B: seat,
		WFC_CLAUDE_CONFIG_C: seat,
		WFC_DISPATCH_ROOT: main,
		WFC_TRANSCRIPT_DIR: undefined,
		GITHUB_ACTIONS: "",
	};
});

afterAll(() => fs.rmSync(home, { recursive: true, force: true }));

const script = (name: string) => path.join(__dirname, name);
const run = (name: string, args: string[] = []) =>
	runInProcess(script(name), args, { env, cwd: main });
const runAsync = (name: string, args: string[] = []) =>
	runInProcessAsync(script(name), args, { env, cwd: main });

describe("a worktree session's transcript is read by every transcript reader (#4236)", () => {
	it.each([
		["count-guard-fires.js", "transcripts"],
		["measure-encoding-use.js", "transcripts"],
		["lost-deny-rates.js", "files"],
	])("%s counts it in its --json corpus", (name, field) => {
		const r = run(name, ["--json"]);
		expect(r.stderr).not.toMatch(/cannot read/i);
		expect(JSON.parse(r.stdout).corpus[field]).toBe(1);
	});

	it("measure-if-overmatch.js counts it in its --json corpus", async () => {
		const r = await runAsync("measure-if-overmatch.js", ["--json"]);
		expect(JSON.parse(r.stdout).transcripts).toBe(1);
	});

	it("measure-bundle-cost.js reads it as an issue-closing session", () => {
		const r = run("measure-bundle-cost.js");
		expect(r.stdout).toContain("Corpus: 1 transcripts");
		expect(r.stdout).toContain("1 issue-closing");
	});

	it("measure-turn-band.js reads it as a session", () => {
		const r = run("measure-turn-band.js");
		expect(r.stdout).toContain("Corpus: 1 transcripts");
	});

	it("measure-session-cost.js prices it from its ledger job", () => {
		const r = run("measure-session-cost.js", ["--config-dir", seat]);
		expect(r.stdout).toContain("n=1 ");
	});

	it("check-hook-liveness.js accounts for it", () => {
		const r = run("check-hook-liveness.js");
		expect(`${r.stdout}${r.stderr}`).toContain("1 of 1 transcript file(s)");
	});

	it("measure-dispatch-compliance.js reads it", () => {
		const r = run("measure-dispatch-compliance.js");
		expect(r.stdout).toContain("Corpus: 1 transcripts");
	});

	it("measure-bash-write-firing/extract-bash-commands.js extracts its command", async () => {
		const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "wt-readers-out-"));
		try {
			const out = path.join(outDir, "commands.jsonl");
			const r = await runAsync(
				"measure-bash-write-firing/extract-bash-commands.js",
				[out],
			);
			expect(r.stderr).toContain("transcripts=1 commands=1");
			expect(fs.readFileSync(out, "utf8")).toContain("gh issue close 12");
		} finally {
			fs.rmSync(outDir, { recursive: true, force: true });
		}
	});

	it("measure-echo-chain.js reads it as a top-level transcript", () => {
		const r = run("measure-echo-chain.js");
		expect(r.stdout).toMatch(/transcripts : 1 top-level/);
	});

	it("hook-message.js finds it where the payload names no transcript", () => {
		const saved = { ...process.env };
		Object.assign(process.env, {
			CLAUDE_PROJECT_DIR: main,
			CLAUDE_CONFIG_DIR: seat,
		});
		try {
			const { transcriptPath } = require("./lib/hook-message.js");
			expect(transcriptPath(null, SID)).toBe(transcript);
		} finally {
			for (const k of ["CLAUDE_PROJECT_DIR", "CLAUDE_CONFIG_DIR"])
				if (saved[k] === undefined) delete process.env[k];
				else process.env[k] = saved[k];
		}
	});
});
