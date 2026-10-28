// @vitest-environment node
/*
 * Pins that check-harness-canary.js goes red when a description-less plugin
 * skill is in the start listing or does not load, records the version only on
 * green, and speaks at session start only while red (#2037).
 *
 * The live probe is stubbed: WFC_CANARY_CLAUDE points at a stub `claude` that
 * replays the transcript rows recorded from a real 2.1.302 probe
 * (scripts/fixtures/harness-canary-listing.jsonl) into a sandbox
 * CLAUDE_CONFIG_DIR, varied per case.
 *
 * The agent_id probe (#2819) reads the stub itself as the binary, so a case
 * appends 2.1.310's excerpts (scripts/fixtures/agent-id-2.1.310.txt) to it.
 * It runs in the core's checkout alone: run() points CLAUDE_PROJECT_DIR at a
 * scratch adopter, and a core case points it back at this checkout.
 *
 * Loosen a case and a harness update can bring ~1,280 tokens back to every
 * adopter start, or break every description-less skill, with this check still green.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stubGhScript } from "./lib/gh-stub.js";
import { runInProcess } from "./lib/run-in-process.js";

const SCRIPT = path.join(__dirname, "check-harness-canary.js");
const FIXTURE = path.join(
	__dirname,
	"fixtures",
	"harness-canary-listing.jsonl",
);

/* Rows: [listing, Skill call, loaded body]. The body carries the recorded
 * CANARY-0000, swapped for the nonce in the plugin it is handed. */
const STUB = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const argv = process.argv.slice(2);
if (argv[0] === "--version") {
	if (process.env.STUB_VERSION) console.log(process.env.STUB_VERSION + " (Claude Code)");
	process.exit(0);
}
const after = (f) => argv[argv.indexOf(f) + 1];
fs.appendFileSync(process.env.STUB_CALLS, "probe\\n");
const [listing, call, body] = fs.readFileSync(process.env.STUB_FIXTURE, "utf8").trim().split("\\n").map((l) => JSON.parse(l));
let names = listing.attachment.names;
if (process.env.STUB_LIST_BARE) names = [...names, "wfccanary:bare"];
if (process.env.STUB_NO_CONTROL) names = names.filter((n) => n !== "wfccanary:control");
listing.attachment.names = names;
const skill = fs.readFileSync(path.join(after("--plugin-dir"), "skills/bare/SKILL.md"), "utf8");
const nonce = /CANARY-[0-9a-f]+/.exec(skill)[0];
const rows = [listing];
if (!process.env.STUB_NO_CALL) rows.push(call);
if (!process.env.STUB_NO_CALL && !process.env.STUB_NO_LOAD)
	rows.push(JSON.parse(JSON.stringify(body).replace("CANARY-0000", nonce)));
const dir = path.join(process.env.CLAUDE_CONFIG_DIR, "projects", process.cwd().replace(/[^A-Za-z0-9]/g, "-"));
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, after("--session-id") + ".jsonl"), rows.map((r) => JSON.stringify(r)).join("\\n") + "\\n");
console.log(nonce);
`;

const EXCERPTS = fs.readFileSync(
	path.join(__dirname, "fixtures", "agent-id-2.1.310.txt"),
	"utf8",
);
const CONTEXT_ARG = EXCERPTS.replace("Vu(e,Cg())", "Vu(e,Cg(),void 0,r)");
const CORE = path.join(__dirname, "..");

let dir: string;
let config: string;
let calls: string;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-canary-"));
	config = path.join(dir, "config");
	calls = path.join(dir, "calls");
	fs.mkdirSync(config);
	fs.writeFileSync(path.join(dir, "claude"), STUB, { mode: 0o755 });
});
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

function run(args: string[], env: Record<string, string> = {}) {
	return runInProcess(SCRIPT, args, {
		env: {
			...process.env,
			GITHUB_ACTIONS: "",
			CLAUDE_CONFIG_DIR: config,
			CLAUDE_PROJECT_DIR: dir,
			WFC_CANARY_CLAUDE: path.join(dir, "claude"),
			STUB_FIXTURE: FIXTURE,
			STUB_CALLS: calls,
			STUB_VERSION: "2.1.302",
			...env,
		},
	});
}

const statePath = () => path.join(config, "wfc-harness-canary.json");
const readState = () => JSON.parse(fs.readFileSync(statePath(), "utf8"));
const probes = () =>
	fs.existsSync(calls)
		? fs.readFileSync(calls, "utf8").split("\n").length - 1
		: 0;
const HOUR = 3_600_000;
function seedUnprobed(agoMs: number) {
	const at = new Date(Date.now() - agoMs).toISOString();
	fs.writeFileSync(
		statePath(),
		JSON.stringify({
			last: { version: "2.1.302", verdict: "unprobed", reasons: ["x"], at },
		}),
	);
}

/* Real time, not a seam: the probe is a detached process the call does not
 * wait for, so only polling its state file sees it finish. 10 s is a ceiling
 * on a stub that writes one file; a guess. */
const POLLS = 100;
const POLL_MS = 100;
async function until(done: () => boolean) {
	for (let i = 0; i < POLLS && !done(); i++)
		await new Promise((res) => setTimeout(res, POLL_MS));
}
const untilProbed = (version: string) =>
	until(
		() => fs.existsSync(statePath()) && readState().last?.version === version,
	);

describe("the probe (--probe)", () => {
	it("is green on the recorded transcript, records the version, and leaves no transcript", () => {
		const r = run(["--probe"]);
		expect(r.status).toBe(0);
		expect(r.stderr).toContain("OK: a description-less plugin skill");
		expect(readState().passed).toBe("2.1.302");
		expect(fs.readdirSync(path.join(config, "projects"))).toEqual([]);
	});

	it("is red when the description-less skill is listed, and records nothing", () => {
		const r = run(["--probe"], { STUB_LIST_BARE: "1" });
		expect(r.status).toBe(1);
		expect(r.stderr).toContain(
			"wfccanary:bare, which has no description, is in the start listing",
		);
		expect(readState().passed).toBeUndefined();
		expect(readState().last.verdict).toBe("red");
	});

	it("is red when the Skill call loads no body", () => {
		const r = run(["--probe"], { STUB_NO_LOAD: "1" });
		expect(r.status).toBe(1);
		expect(r.stderr).toContain(
			"the Skill tool loaded no body for wfccanary:bare",
		);
		expect(readState().passed).toBeUndefined();
	});

	it("is unprobed, not red, when the model never calls the Skill tool", () => {
		const r = run(["--probe"], { STUB_NO_CALL: "1" });
		expect(r.status).toBe(0);
		expect(r.stderr).toContain("never called the Skill tool");
		expect(readState().last.verdict).toBe("unprobed");
	});

	it("is unprobed, not green, when the control skill is missing from the listing", () => {
		const r = run(["--probe"], { STUB_NO_CONTROL: "1" });
		expect(r.status).toBe(0);
		expect(r.stderr).toContain("UNPROBED");
		expect(r.stderr).toContain("--probe");
		expect(readState().passed).toBeUndefined();
	});

	it("keeps an earlier pass but reports a red re-probe on the same version", () => {
		run(["--probe"]);
		const r = run(["--probe"], { STUB_NO_LOAD: "1" });
		expect(r.status).toBe(1);
		expect(readState().passed).toBe("2.1.302");
	});

	it("runs no probe while another holds the lock", () => {
		fs.writeFileSync(path.join(config, "wfc-harness-canary.lock"), "");
		const r = run(["--probe"]);
		expect(r.status).toBe(0);
		expect(r.stderr).toContain("another probe holds");
		expect(probes()).toBe(0);
	});
});

describe("a hand run", () => {
	it("warns on a version not yet probed, names the way out, and spends nothing", () => {
		const r = run([]);
		expect(r.status).toBe(0);
		expect(r.stderr).toContain("NOT-PROBED");
		expect(r.stderr).toContain("--probe");
		expect(probes()).toBe(0);
	});

	it("reports the recorded red verdict", () => {
		run(["--probe"], { STUB_LIST_BARE: "1" });
		const r = run([]);
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("HARNESS-CANARY");
	});

	it("skips where `claude --version` gives nothing", () => {
		const r = run([], { STUB_VERSION: "" });
		expect(r.status).toBe(0);
		expect(r.stderr).toContain("SKIP:");
	});
});

describe("at session start (--notify)", () => {
	it("is silent on a version that passed, and launches nothing", () => {
		run(["--probe"]);
		const r = run(["--notify"]);
		expect(r.status).toBe(0);
		expect(r.stdout).toBe("");
		expect(probes()).toBe(1);
	});

	it("prints the red verdict at every start while red, without re-probing", () => {
		run(["--probe"], { STUB_NO_LOAD: "1" });
		for (let i = 0; i < 2; i++) {
			const r = run(["--notify"]);
			expect(r.status).toBe(0);
			expect(r.stdout).toContain("HARNESS-CANARY — Claude Code 2.1.302");
			expect(r.stdout).toContain("--probe");
		}
		expect(probes()).toBe(1);
	});

	it("prints a red re-probe on a version that had passed", () => {
		run(["--probe"]);
		run(["--probe"], { STUB_LIST_BARE: "1" });
		expect(run(["--notify"]).stdout).toContain("HARNESS-CANARY");
	});

	it("launches the probe detached on a new version, silently, and the next start reads its verdict", async () => {
		run(["--probe"], { STUB_VERSION: "2.1.301" });
		const r = run(["--notify"], { STUB_LIST_BARE: "1" });
		expect(r.status).toBe(0);
		expect(r.stdout).toBe("");
		await untilProbed("2.1.302");
		expect(readState().last).toMatchObject({
			version: "2.1.302",
			verdict: "red",
		});
		expect(readState().passed).toBe("2.1.301");
		expect(run(["--notify"]).stdout).toContain("HARNESS-CANARY");
	});

	it("is silent and launches nothing on an unprobed verdict inside the retry window", () => {
		seedUnprobed(HOUR);
		const r = run(["--notify"]);
		expect(r.status).toBe(0);
		expect(r.stdout).toBe("");
		expect(readState().last.verdict).toBe("unprobed");
		expect(probes()).toBe(0);
	});

	it("re-launches the probe once the retry window has passed", async () => {
		seedUnprobed(7 * HOUR);
		const r = run(["--notify"]);
		expect(r.stdout).toBe("");
		await until(() => readState().last.verdict !== "unprobed");
		expect(readState().passed).toBe("2.1.302");
	});
});

describe("the agent_id probe, in the core's checkout", () => {
	let comments: string;
	function core(excerpts: string) {
		fs.appendFileSync(path.join(dir, "claude"), `/*\n${excerpts}*/\n`);
		comments = path.join(dir, "comments");
		const gh = stubGhScript(dir, `#!/bin/sh\necho "$@" >> ${comments}\n`);
		return { CLAUDE_PROJECT_DIR: CORE, ...gh.env };
	}
	const readComments = () =>
		fs.existsSync(comments)
			? fs.readFileSync(comments, "utf8").trim().split("\n")
			: [];

	it("records not fixed on 2.1.310's excerpts, comments nothing, and says so in the OK line", () => {
		const env = core(EXCERPTS);
		const r = run(["--probe"], env);
		expect(r.status).toBe(0);
		expect(readState().agentId).toMatchObject({
			version: "2.1.302",
			verdict: "not fixed",
		});
		expect(r.stderr).toContain(
			"compaction payloads still carry no agent_id (#1837)",
		);
		expect(readComments()).toEqual([]);
		expect(run(["--notify"], env).stdout).toBe("");
	});

	it("on a context argument records fixed, comments on #1837 once, and prints it at each start", () => {
		const env = core(CONTEXT_ARG);
		run(["--probe-agent-id"], env);
		run(["--probe-agent-id"], env);
		expect(readState().agentId).toMatchObject({
			verdict: "fixed",
			commented: true,
		});
		const posts = readComments().filter((l) => l.startsWith("issue comment"));
		expect(posts).toEqual([
			expect.stringContaining("issue comment 1837 --repo"),
		]);
		expect(readComments().join("\n")).toContain(
			"PreCompact builder Vu now gets 4 arguments",
		);
		for (let i = 0; i < 2; i++)
			expect(run(["--notify"], env).stdout).toContain(
				"AGENT-ID-FIXED — Claude Code 2.1.302 looks to send agent_id",
			);
		const hand = run([], env);
		expect(hand.stderr).toContain("AGENT-ID-FIXED");
	});

	it("is unprobed, not fixed, on a binary with no anchor, and warns on a hand run", () => {
		const env = core("");
		run(["--probe-agent-id"], env);
		expect(readState().agentId.verdict).toBe("unprobed");
		expect(run([], env).stderr).toContain("AGENT-ID-UNPROBED");
		expect(readComments()).toEqual([]);
	});

	it("at start on a passed version, launches the agent_id probe alone", async () => {
		const env = core(EXCERPTS);
		run(["--probe"], { STUB_VERSION: "2.1.302" });
		expect(readState().agentId).toBeUndefined();
		expect(run(["--notify"], env).stdout).toBe("");
		await until(() => Boolean(readState().agentId));
		expect(readState().agentId.verdict).toBe("not fixed");
		expect(probes()).toBe(1);
	});

	it("never runs outside the core", () => {
		core(CONTEXT_ARG);
		run(["--probe"]);
		expect(readState().agentId).toBeUndefined();
		expect(run(["--probe-agent-id"]).stderr).toContain("SKIP:");
		expect(readComments()).toEqual([]);
	});
});
