// @vitest-environment node
/*
 * A free-text goal's resolution (#3884). Broken, a number the model invents reaches `set`, or a failed
 * lookup reads as an empty set.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeClaudeStub } from "./claude-stub";
import { GH_LOGGED_OUT_STDERR, printed, stubGhRoutes } from "./gh-stub";

const { resolveTopic } = require("./refill-panel-topic.js");

const OPEN = [
	{ number: 5, title: "Speed the suite" },
	{ number: 7, title: "Rename a flag" },
];

describe("resolveTopic", () => {
	let dir: string;
	let log: string;
	let env: NodeJS.ProcessEnv;
	const repos = () => [{ name: "wc", root: path.join(dir, "wc") }];
	const signal = () => new AbortController().signal;

	function stubClaude(lines: string[], exit = 0) {
		writeClaudeStub(
			path.join(dir, "bin", "claude"),
			[
				`pwd > ${log}.cwd`,
				`printf '%s\\n' "$@" > ${log}.argv`,
				`cat > ${log}.stdin`,
				...lines,
			],
			exit,
		);
	}
	const resolveIn = (ticked = repos()) =>
		resolveTopic("clear Phase 0", ticked, { env, signal: signal() });

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "topic-"));
		log = path.join(dir, "claude");
		fs.mkdirSync(path.join(dir, "bin"));
		fs.mkdirSync(path.join(dir, "wc"));
		const { gh } = stubGhRoutes(dir, {
			"issue list*": printed(JSON.stringify(OPEN)),
		});
		vi.stubEnv("WFC_GH", gh);
		const { ...rest } = process.env;
		const bin = path.join(dir, "bin", "claude");
		vi.stubEnv("WFC_CLAUDE_BIN", bin);
		env = { ...rest, WFC_CLAUDE_BIN: bin };
	});
	afterEach(() => {
		vi.unstubAllEnvs();
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it("returns a good set with its titles, asking from / with no tools", async () => {
		stubClaude(["echo 'wc#5, wc#7'"]);
		expect(await resolveIn()).toEqual({
			issues: [
				{ repo: "wc", number: 5, title: "Speed the suite" },
				{ repo: "wc", number: 7, title: "Rename a flag" },
			],
			dropped: 0,
		});
		expect(fs.readFileSync(`${log}.cwd`, "utf8").trim()).toBe("/");
		const argv = fs.readFileSync(`${log}.argv`, "utf8");
		expect(argv).toContain("-p\n--model\nhaiku\n--effort\nxhigh\n--tools\n\n");
		const prompt = fs.readFileSync(`${log}.stdin`, "utf8");
		expect(prompt).toContain('Topic: "clear Phase 0"');
		expect(prompt).toContain("wc#5 Speed the suite");
	});

	it("launches the binary its env names, whatever process.env holds (#3991)", async () => {
		stubClaude(["echo 'wc#5'"]);
		vi.stubEnv("WFC_CLAUDE_BIN", path.join(dir, "absent"));
		expect(await resolveIn()).toMatchObject({ issues: [{ number: 5 }] });
	});

	it("drops numbers outside the ticked repos' open issues", async () => {
		stubClaude(["echo 'wc#5, wc#99, other#7'"]);
		expect(await resolveIn()).toEqual({
			issues: [{ repo: "wc", number: 5, title: "Speed the suite" }],
			dropped: 2,
		});
	});

	it("reads a bare #N as the one ticked repo's", async () => {
		stubClaude(["echo '#7'"]);
		expect(await resolveIn()).toMatchObject({
			issues: [{ repo: "wc", number: 7 }],
		});
	});

	it("gives a reason where every number is dropped", async () => {
		stubClaude(["echo 'wc#99'"]);
		expect(await resolveIn()).toEqual({
			why: "none of the 1 named is open in a ticked repo",
		});
	});

	it.each(["echo ''", "echo NONE"])(
		"gives a reason on an empty reply: %s",
		async (line) => {
			stubClaude([line]);
			expect(await resolveIn()).toEqual({ why: "the model named no issue" });
		},
	);

	it("gives claude's own words on a failure", async () => {
		stubClaude(["echo 'rate limited' >&2"], 3);
		expect(await resolveIn()).toEqual({ why: "claude -p: rate limited" });
	});

	it("gives gh's words where the list will not read, asking no model", async () => {
		stubClaude(["echo 'wc#5'"]);
		const { gh } = stubGhRoutes(dir, {}, { failing: true });
		vi.stubEnv("WFC_GH", gh);
		const { why } = await resolveIn();
		expect(GH_LOGGED_OUT_STDERR).toContain(why);
		expect(fs.existsSync(`${log}.cwd`)).toBe(false);
	});

	it("refuses a launch that would bill per token", async () => {
		stubClaude(["echo 'wc#5'"]);
		env.ANTHROPIC_BASE_URL = "http://elsewhere";
		const result = await resolveIn();
		expect(result.why).toContain("REFUSED");
		expect(fs.existsSync(`${log}.cwd`)).toBe(false);
	});

	it("reads an empty list twice, then gives no-issues as its reason", async () => {
		stubClaude(["echo 'wc#5'"]);
		const calls = path.join(dir, "gh-calls");
		const { gh } = stubGhRoutes(
			dir,
			{ "issue list*": printed("[]") },
			{ log: calls },
		);
		vi.stubEnv("WFC_GH", gh);
		expect(await resolveIn()).toEqual({
			why: "the ticked repos have no open issue",
		});
		expect(fs.readFileSync(calls, "utf8").trim().split("\n")).toHaveLength(2);
	});

	it("asks nothing with no repo ticked", async () => {
		expect(await resolveIn([])).toEqual({ why: "no repo is ticked" });
	});
});
