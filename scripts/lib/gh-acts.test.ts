// @vitest-environment node
/*
 * lib/gh-acts.js, record-acts.js's core (#2799), in process: a session's raw
 * `gh` close, question round, `takes:` relabel and blocked-by edge, one acts
 * ledger line each (#2308, #2464, spec #2245).
 *
 * The ports are the production ones, lib/gh-recorder-host.js's, over the
 * arbiter testkit's sandbox and a real git checkout whose origin names
 * owner/repo; the ledger is read back through readActsBy.
 *
 * The refill loop judges a launch's progress from these lines: a case loosened
 * here lets a launch that did nothing read as progress, or one that asked a
 * round read as idle and count toward the loop's no-progress stop.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { freshSandbox, gitRepo, store } from "./arbiter-testkit";
import { kitContextFake } from "./kit-context-fake";

const { decide } = require("./gh-acts.js") as {
	decide: (command: string, ctx: object) => null;
};
const { buildHostPorts } = require("./gh-recorder-host.js") as {
	buildHostPorts: (env: object) => Record<string, unknown>;
};

const SID = "sess-acts";
const ROUND =
	"Some context.\n\n❓ **Q1** Which way?\n(A) This\nConfidence: 70% (60% - 80%). why\n";

const sb = freshSandbox();
let logged: string[];
/** Every act the core handed the ledger, written or not. */
let handed: string[];

beforeEach(() => {
	gitRepo(sb);
	execFileSync(
		"git",
		["remote", "add", "origin", "https://github.com/owner/repo.git"],
		{ cwd: sb.repo },
	);
	logged = [];
	handed = [];
});

const run = (
	command: string,
	{ sessionId = SID as string | null, stderr = "", tool = "Bash" } = {},
) => {
	const payload: Record<string, unknown> = {
		tool_name: tool,
		tool_response: { stdout: "", stderr },
	};
	if (sessionId !== null) payload.session_id = sessionId;
	const log = (what: string) => logged.push(what);
	const ports = buildHostPorts({ root: sb.repo, payload, log });
	const recordAct = ports.recordAct as (act: string, sid: string) => void;
	return decide(
		command,
		kitContextFake({
			...ports,
			recordAct: (act: string, sid: string) => {
				handed.push(act);
				recordAct(act, sid);
			},
			envSession: "",
			tool,
			cwd: sb.repo,
			fallbackCwd: sb.repo,
			isDir: () => true,
			log,
		}),
	);
};

const readActs = () => store.readActsBy(SID, [sb.repo]).acts;

describe("close", () => {
	it("records one close line on gh issue close <n>", () => {
		expect(run("gh issue close 12 --reason completed")).toBeNull();
		expect(readActs()).toEqual(["close owner/repo#12"]);
	});

	it("names the --repo a close names, and an issue URL's own repo", () => {
		run("gh issue close 3 --repo other/thing");
		run("gh issue close https://github.com/far/away/issues/9");
		expect(readActs()).toEqual(["close other/thing#3", "close far/away#9"]);
	});

	it("takes no repo from a URL whose number is no issue number (#2367)", () => {
		run("gh issue close 5 https://github.com/far/away/issues/1234567890");
		expect(readActs()).toEqual(["close owner/repo#5"]);
	});

	it("records nothing for a close gh reports as already closed", () => {
		run("gh issue close 12", {
			stderr: "! Issue owner/repo#12 (Some title) is already closed\n",
		});
		expect(readActs()).toEqual([]);
	});

	it("records a close whose output names it as closed, not already closed", () => {
		run("gh issue close 12", {
			stderr: "✓ Closed issue owner/repo#12 (Some title)\n",
		});
		expect(readActs()).toEqual(["close owner/repo#12"]);
	});

	it("records a close whose already-closed line names another issue", () => {
		run("gh issue close 12 13", {
			stderr: "! Issue owner/repo#13 (Some title) is already closed\n",
		});
		expect(readActs()).toEqual(["close owner/repo#12"]);
	});

	it("never reads a --duplicate-of value as a second issue closed", () => {
		run("gh issue close 5 --reason duplicate --duplicate-of 3");
		expect(readActs()).toEqual(["close owner/repo#5"]);
	});

	it("records nothing for a pr close, a non-Bash tool, or with no session id", () => {
		run("gh pr close 12");
		run("gh issue close 13", { tool: "Write" });
		run("gh issue close 13", { sessionId: null });
		expect(readActs()).toEqual([]);
	});
});

describe("round — every comment spelling the hook can see", () => {
	it("reads an inline --body", () => {
		run(`gh issue comment 5 --body '${ROUND}'`);
		expect(readActs()).toEqual(["round owner/repo#5"]);
	});

	it("reads a --body-file path", () => {
		fs.writeFileSync(path.join(sb.repo, "c.md"), ROUND);
		run("gh issue comment 5 --body-file c.md");
		expect(readActs()).toEqual(["round owner/repo#5"]);
	});

	it("reads stdin from a single-quoted heredoc", () => {
		run(`gh issue comment 5 --body-file - <<'EOF'\n${ROUND}EOF`);
		expect(readActs()).toEqual(["round owner/repo#5"]);
	});

	it("reads stdin from a cat of a file", () => {
		fs.writeFileSync(path.join(sb.repo, "c.md"), ROUND);
		run("cat c.md | gh issue comment 5 --body-file -");
		expect(readActs()).toEqual(["round owner/repo#5"]);
	});

	it("records nothing for a comment that opens no round", () => {
		run(`gh issue comment 5 --body 'Done: Q1 answered (A).'`);
		expect(readActs()).toEqual([]);
	});

	it("records nothing where the body cannot be read, or no new comment is posted", () => {
		run(`gh issue comment 5 --body "$(cat c.md)"`);
		run(`gh issue comment 5 --edit-last --body '${ROUND}'`);
		run("gh issue comment 5 --body-file missing.md");
		run("gh issue comment 5");
		expect(readActs()).toEqual([]);
	});

	it("logs a body file it could not read, and records no round", () => {
		fs.mkdirSync(path.join(sb.repo, "c.md"));
		run("gh issue comment 5 --body-file c.md");
		expect(readActs()).toEqual([]);
		expect(logged).toEqual([
			"could not read the body file of a gh issue comment — no round recorded",
		]);
	});
});

describe("relabel", () => {
	it("records each takes: label added, per issue", () => {
		run(
			"gh issue edit 7 8 --add-label takes:implement,kind:ticket --remove-label takes:triage",
		);
		expect(readActs()).toEqual([
			"relabel owner/repo#7 takes:implement",
			"relabel owner/repo#8 takes:implement",
		]);
	});

	it("never reads a --parent value as an issue relabelled", () => {
		run("gh issue edit 7 --add-label takes:implement --parent 2245");
		expect(readActs()).toEqual(["relabel owner/repo#7 takes:implement"]);
	});

	it("records nothing for a removal alone, a label that is not takes:, or one it cannot read", () => {
		run("gh issue edit 7 --remove-label takes:triage");
		run("gh issue edit 7 --add-label urgent");
		run("gh issue edit 7 --add-label takes:");
		run('gh issue edit 7 --add-label "$L"');
		expect(readActs()).toEqual([]);
		// Never handed over: the ledger would drop it silently (#2799).
		expect(handed).toEqual([]);
	});

	it("never reads a body flag on an edit as a round", () => {
		run(`gh issue edit 7 --body '${ROUND}'`);
		expect(readActs()).toEqual([]);
	});
});

describe("block", () => {
	it("records a gh api POST to an issue's blocked_by, in each method spelling", () => {
		run(
			"gh api repos/far/away/issues/2347/dependencies/blocked_by -X POST -F issue_id=99",
		);
		run(
			"gh api --method post /repos/far/away/issues/2348/dependencies/blocked_by -F issue_id=99",
		);
		run(
			"gh api repos/{owner}/{repo}/issues/2349/dependencies/blocked_by -F issue_id=99",
		);
		run(
			"gh api https://api.github.com/repos/far/away/issues/2350/dependencies/blocked_by -F issue_id=99",
		);
		expect(readActs()).toEqual([
			"block far/away#2347",
			"block far/away#2348",
			"block owner/repo#2349",
			"block far/away#2350",
		]);
	});

	it("records a gh issue edit --add-blocked-by, per issue", () => {
		run("gh issue edit 7 8 --add-blocked-by 200");
		expect(readActs()).toEqual(["block owner/repo#7", "block owner/repo#8"]);
	});

	it("records nothing for a read, a removal, a half-placeholder repo or an unreadable word", () => {
		run("gh api repos/far/away/issues/5/dependencies/blocked_by");
		run("gh api -X DELETE repos/far/away/issues/5/dependencies/blocked_by/99");
		run(
			"gh api repos/{owner}/away/issues/5/dependencies/blocked_by -F issue_id=99",
		);
		run("gh api repos/far/away/issues/5/comments -f body=hi");
		run('gh api -X "$M" repos/far/away/issues/5/dependencies/blocked_by');
		run('gh api "$E" -F issue_id=99');
		run("gh issue edit 5 --remove-blocked-by 200");
		expect(readActs()).toEqual([]);
	});
});

describe("the repo a line names", () => {
	it("reads the origin of the directory a `cd` moves the call into", () => {
		const other = path.join(sb.dir, "other");
		fs.mkdirSync(other);
		execFileSync("git", ["init", "-q"], { cwd: other });
		execFileSync(
			"git",
			["remote", "add", "origin", "git@github.com:else/where.git"],
			{ cwd: other },
		);
		run(`cd ${other} && gh issue close 4`);
		expect(readActs()).toEqual(["close else/where#4"]);
	});

	it("records nothing where no repo can be named", () => {
		const bare = path.join(sb.dir, "bare");
		fs.mkdirSync(bare);
		run(`cd ${bare} && gh issue close 4`);
		expect(readActs()).toEqual([]);
	});
});
