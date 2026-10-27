// @vitest-environment node
/*
 * Direct tests for the gh seam (mantahostels#154), pinning the contract each
 * caller leans on; the callers' own suites exercise it end-to-end.
 *
 * Each case points WFC_GH at a stub script in a temp dir (gh-stub), so no
 * case reaches the network or the founder's `gh` login; gh.contract.test.ts
 * holds the shared fake's answers to the real binary.
 *
 * Every Node script that calls GitHub goes through this seam, the checkers the
 * husky hooks run among them, so a loosened case can let an unreachable `gh`
 * read as all-clear rather than SKIP, or mis-flatten a paginated listing.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { caught } from "./caught.js";
import { ghAnswer, ghFakeScript } from "./gh-fake";
import { GH_FAILING_SCRIPT, stubGhScript } from "./gh-stub";
import { runInProcess } from "./run-in-process";

const ISSUE_LIST = path.join(__dirname, "fixtures/gh/issue-list.json");
const NOT_FOUND = path.join(__dirname, "fixtures/gh/not-found.json");
const UNKNOWN_FLAG = path.join(__dirname, "fixtures/gh/unknown-flag.json");
const VALIDATION_FAILED = path.join(
	__dirname,
	"fixtures/gh/validation-failed.json",
);

const LIB = path.resolve(__dirname, "gh.js");
const CHECK_LIB = path.resolve(__dirname, "check.js");

let dir: string;
let savedEnv: NodeJS.ProcessEnv;

beforeEach(() => {
	savedEnv = { ...process.env };
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "gh-seam-test-"));
});
afterEach(() => {
	process.env = savedEnv;
	fs.rmSync(dir, { recursive: true, force: true });
});

const load = async () => await import(LIB);

const inject = (script: string, { failing = false } = {}) => {
	const stub = stubGhScript(dir, script, { failing });
	process.env.WFC_GH = stub.env.WFC_GH;
};

describe("the injection point", () => {
	it("resolves the binary from WFC_GH, defaulting to gh", async () => {
		const { ghBinary } = await load();
		delete process.env.WFC_GH;
		expect(ghBinary()).toBe("gh");
		process.env.WFC_GH = "/tmp/stub-gh";
		expect(ghBinary()).toBe("/tmp/stub-gh");
	});

	it("gh() runs the injected binary with the given args", async () => {
		const { gh } = await load();
		inject('#!/bin/sh\necho "args: $*"\n');
		expect(gh(["issue", "list"])).toBe("args: issue list\n");
	});
});

describe("a call's wall-clock cap (#2677)", () => {
	/* Asserting the option passed is §X6's internals, kept because the cap's
	 * only outward sign is a call killed at 300 s, which no test can wait out;
	 * gh.js binds execFileSync at load, so it is read fresh over the spy. */
	it("defaults to 300 s", () => {
		inject("#!/bin/sh\nexit 0\n");
		const cp = require("node:child_process");
		const spy = vi.spyOn(cp, "execFileSync");
		try {
			delete require.cache[LIB];
			require(LIB).gh(["issue", "list"]);
			expect(
				(spy.mock.calls[0]?.[2] as { timeout?: number } | undefined)?.timeout,
			).toBe(300_000);
		} finally {
			spy.mockRestore();
			delete require.cache[LIB];
		}
	});

	/* Crosses the real clock: what is pinned is a real process killed at the
	 * caller's own cap. */
	it("leaves a caller's own timeout winning (mantahostels#2134)", async () => {
		const { gh } = await load();
		inject("#!/bin/sh\nsleep 30\n");
		try {
			gh(["issue", "list"], { timeout: 200 });
			expect.unreachable("the stub sleeps past the cap");
		} catch (e) {
			expect(caught(e).code).toBe("ETIMEDOUT");
		}
	});
});

describe("run and workflow calls reach the code repo (#1963)", () => {
	const host = () => {
		fs.mkdirSync(path.join(dir, ".claude"));
		fs.writeFileSync(
			path.join(dir, ".claude", "workflow-core.json"),
			JSON.stringify({ tracker: "o/tracker", codeRepo: "o/code" }),
		);
		process.env.CLAUDE_PROJECT_DIR = dir;
	};

	it("adds --repo <codeRepo> to a run or workflow call naming no repo", async () => {
		const { gh } = await load();
		host();
		inject('#!/bin/sh\necho "args: $*"\n');
		expect(gh(["run", "list"])).toBe("args: run list --repo o/code\n");
		expect(gh(["workflow", "run", "ci.yml"])).toBe(
			"args: workflow run ci.yml --repo o/code\n",
		);
	});

	it("leaves an issue call, and a call naming its own repo, as given", async () => {
		const { gh } = await load();
		host();
		inject('#!/bin/sh\necho "args: $*"\n');
		expect(gh(["issue", "list"])).toBe("args: issue list\n");
		expect(gh(["run", "list", "--repo", "x/y"])).toBe(
			"args: run list --repo x/y\n",
		);
	});
});

describe("errors", () => {
	it("parseErrLine returns the last stderr line — where gh puts the reason", async () => {
		const { gh, parseErrLine } = await load();
		inject(
			'#!/bin/sh\necho "warning: noise" >&2\necho "gh: no auth" >&2\nexit 1\n',
		);
		try {
			gh(["api", "x"]);
			expect.unreachable("stub exits 1");
		} catch (e) {
			expect(parseErrLine(e)).toBe("gh: no auth");
		}
	});

	/* A JS error is the other way up: the reason leads, and what follows is the
	 * stack, or the input quoted back. */
	it("parseErrLine takes the FIRST line of a thrown error with no stderr", async () => {
		const { ghJson, parseErrLine } = await load();
		inject("#!/bin/sh\nprintf 'not json\\nat all\\n'\n");
		try {
			ghJson(["issue", "list"]);
			expect.unreachable("output is not JSON");
		} catch (e) {
			expect(parseErrLine(e)).toMatch(/^Unexpected token/);
			expect(parseErrLine(e)).not.toBe('at all"');
		}
	});
});

describe("JSON and pagination", () => {
	it("ghJson parses stdout", async () => {
		const { ghJson } = await load();
		inject(ghFakeScript(ISSUE_LIST));
		expect(ghJson(["issue", "list"])).toEqual(
			JSON.parse(ghAnswer(ISSUE_LIST).stdout),
		);
	});

	it("ghApiSlurp flattens --slurp page wrapping", async () => {
		const { ghApiSlurp } = await load();
		inject('#!/bin/sh\necho \'[[{"number":1}],[{"number":2}]]\'\n');
		expect(ghApiSlurp(["repos/o/r/issues"])).toEqual([
			{ number: 1 },
			{ number: 2 },
		]);
	});

	it("ghApiSlurp accepts older gh's flat array too", async () => {
		const { ghApiSlurp } = await load();
		inject("#!/bin/sh\necho '[{\"number\":1}]'\n");
		expect(ghApiSlurp(["repos/o/r/issues"])).toEqual([{ number: 1 }]);
	});

	it("ghApiSlurp passes --paginate --slurp to gh", async () => {
		const { ghApiSlurp } = await load();
		inject(`#!/bin/sh\necho "$*" > ${dir}/args\necho "[]"\n`);
		ghApiSlurp(["repos/o/r/issues", "-f", "state=all"]);
		expect(fs.readFileSync(path.join(dir, "args"), "utf8").trim()).toBe(
			"api repos/o/r/issues -f state=all --paginate --slurp",
		);
	});

	it("ghApiSlurpAsync flattens like the sync form, and reads empty output as []", async () => {
		const { ghApiSlurpAsync } = await load();
		inject("#!/bin/sh\necho '[[{\"number\":3}]]'\n");
		await expect(ghApiSlurpAsync(["repos/o/r/issues"])).resolves.toEqual([
			{ number: 3 },
		]);
		inject("#!/bin/sh\ntrue\n");
		await expect(ghApiSlurpAsync(["repos/o/r/issues"])).resolves.toEqual([]);
	});

	it("ghApiSlurpAsync passes --paginate --slurp to gh", async () => {
		const { ghApiSlurpAsync } = await load();
		inject(`#!/bin/sh\necho "$*" > ${dir}/args\necho "[]"\n`);
		await ghApiSlurpAsync(["repos/o/r/issues", "-f", "state=all"]);
		expect(fs.readFileSync(path.join(dir, "args"), "utf8").trim()).toBe(
			"api repos/o/r/issues -f state=all --paginate --slurp",
		);
	});
});

/*
 * raiseGhFailure THROWS into check.js rather than exiting itself
 * (mantahostels#155 — the checker family's exit-code and severity model —
 * decision 6), so it is driven here the way every caller drives it — inside a
 * runCheck, which owns the outcome and the process's exit code.
 */
const inCheck = (body: string) =>
	`const { runCheck } = require(${JSON.stringify(CHECK_LIB)});
	 const { gh, raiseGhFailure, assertWholeTracker, ghOpenIssues, ISSUE_LIST_LIMIT } = require(${JSON.stringify(LIB)});
	 runCheck({ name: "t", usage: "t", run(ctx) { ${body} } });`;

/**
 * Stands in for `spawnSync(process.execPath, ["-e", code], ...)` (mantahostels#1945):
 * `runInProcess` takes a script path, not inline source, so `code` is written
 * to its own fixture file first.
 */
let inlineCount = 0;
const runInline = (code: string, env: Record<string, string | undefined>) => {
	const file = path.join(dir, `inline-${inlineCount++}.js`);
	fs.writeFileSync(file, code);
	return runInProcess(file, [], { env });
};

describe("the SKIP-on-unreachable rule", () => {
	const runSkip = (conclusion?: string) => {
		const stub = stubGhScript(dir, GH_FAILING_SCRIPT);
		const call = conclusion
			? `raiseGhFailure(e, ${JSON.stringify(conclusion)})`
			: "raiseGhFailure(e)";
		return runInline(
			inCheck(
				`try { gh(["issue", "list"]); } catch (e) { ${call} }
				 console.error("UNREACHABLE");
				 return { okLine: "reached the end" };`,
			),
			{ ...process.env, WFC_GH: stub.gh },
		);
	};

	it("prints SKIP with the reason and exits 0 — never reads as all-clear", () => {
		const r = runSkip();
		expect(r.status).toBe(0);
		expect(r.stderr).toContain("SKIP: could not query GitHub issues");
		expect(r.stderr).toContain("populate the GH_TOKEN environment variable");
		expect(r.stderr).toContain("No conclusion drawn.");
		expect(r.stderr).not.toContain("UNREACHABLE");
	});

	it("carries a caller-specific conclusion", () => {
		const r = runSkip("No drift conclusion drawn.");
		expect(r.stderr).toContain("No drift conclusion drawn.");
	});

	it("names the exhausted rate-limit budget rather than telling the reader to authenticate (#93)", () => {
		const stub = stubGhScript(
			dir,
			'#!/bin/sh\necho "gh: API rate limit exceeded (HTTP 403)" >&2\nexit 1\n',
		);
		const r = runInline(
			inCheck(
				`try { gh(["issue", "list"]); } catch (e) { raiseGhFailure(e); }
				 return { okLine: "reached the end" };`,
			),
			{ ...process.env, WFC_GH: stub.gh },
		);
		expect(r.status).toBe(0);
		expect(r.stderr).toContain("SKIP: could not query GitHub issues");
		expect(r.stderr).toContain(
			"GitHub's rate-limit budget is exhausted, not a credential problem.",
		);
		expect(r.stderr).not.toContain("Needs an authenticated `gh`.");
	});
});

/*
 * mantahostels#164 (the ticket that made an unreachable GitHub a SKIP and a gh
 * crash a BROKEN): only no-binary / no-credentials / no-network is a skippable
 * environment fact; everything else is the check itself being broken.
 */
describe("classifying why a gh call failed", () => {
	const reasonOf = async (stderr: string) => {
		const { gh, parseGhFailureReason } = await load();
		inject(`#!/bin/sh\necho ${JSON.stringify(stderr)} >&2\nexit 1\n`);
		try {
			gh(["issue", "list"]);
			return expect.unreachable("stub exits 1");
		} catch (e) {
			return parseGhFailureReason(e);
		}
	};

	it.each([
		["gh auth login required", "no credentials"],
		["error: Bad credentials", "a rejected token"],
		["HTTP 401: Unauthorized", "a 401"],
		["dial tcp: lookup api.github.com: no such host", "no DNS"],
		["Could not resolve host: api.github.com", "no DNS, gh's other wording"],
		["connection refused", "nothing listening"],
		["API rate limit exceeded", "GitHub refusing everyone for now"],
	])("reads %j as unreachable — %s", async (stderr) => {
		expect(await reasonOf(stderr)).toBe("unreachable");
	});

	/* Hand-written, not a fixture: no read-only call reaches a scope 403 to
	 * record. */
	it.each([
		[
			"HTTP 403: `checks` scope required",
			"a 403 that is a scope fault, not a rate limit",
		],
	])("reads %j as broken — %s", async (stderr) => {
		expect(await reasonOf(stderr)).toBe("broken");
	});

	it.each([
		[NOT_FOUND, "asking for something absent"],
		[VALIDATION_FAILED, "a malformed request"],
		[UNKNOWN_FLAG, "a typo in the call"],
	])("reads gh's answer in %s as broken — %s", async (fixture) => {
		const { gh, parseGhFailureReason } = await load();
		inject(ghFakeScript(fixture));
		try {
			gh(["api", "repos/o/r"]);
			expect.unreachable("the fixture exits 1");
		} catch (e) {
			expect(parseGhFailureReason(e)).toBe("broken");
		}
	});

	it("ignores the argv: an unreachable phrase in the ARGS stays broken", async () => {
		const { gh, parseGhFailureReason } = await load();
		inject('#!/bin/sh\necho "gh: HTTP 422" >&2\nexit 1\n');
		try {
			gh(["issue", "list", "--search", "rate limit GH_TOKEN"]);
			expect.unreachable("stub exits 1");
		} catch (e) {
			expect((e as Error).message).toContain("rate limit");
			expect(parseGhFailureReason(e)).toBe("broken");
		}
	});

	it("reads a missing gh binary as unreachable", async () => {
		const { gh, parseGhFailureReason } = await load();
		process.env.WFC_GH = path.join(dir, "no-such-gh");
		try {
			gh(["issue", "list"]);
			expect.unreachable("no binary to run");
		} catch (e) {
			expect(caught(e).code).toBe("ENOENT");
			expect(parseGhFailureReason(e)).toBe("unreachable");
		}
	});

	it("reads an overrun buffer as broken", async () => {
		const { gh, parseGhFailureReason } = await load();
		inject("#!/bin/sh\necho 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'\n");
		try {
			gh(["issue", "list"], { maxBuffer: 4 });
			expect.unreachable("output exceeds the 4-byte buffer");
		} catch (e) {
			expect(caught(e).code).toBe("ENOBUFS");
			expect(parseGhFailureReason(e)).toBe("broken");
		}
	});

	it("reads unparseable output as broken, not as a quiet skip", async () => {
		const { ghJson, parseGhFailureReason } = await load();
		inject("#!/bin/sh\necho 'not json'\n");
		try {
			ghJson(["issue", "list"]);
			expect.unreachable("output is not JSON");
		} catch (e) {
			expect(parseGhFailureReason(e)).toBe("broken");
		}
	});
});

describe("a broken call exits loudly at 2", () => {
	const runBroken = (stderr: string) => {
		const stub = stubGhScript(
			dir,
			`#!/bin/sh\necho ${JSON.stringify(stderr)} >&2\nexit 1\n`,
		);
		return runInline(
			inCheck(
				`try { gh(["issue", "list"]); } catch (e) { raiseGhFailure(e, "No conclusion drawn."); }
				 console.error("KEPT GOING");
				 return { okLine: "reached the end" };`,
			),
			{ ...process.env, WFC_GH: stub.gh },
		);
	};

	it("exits 2 — distinct from the 1 a finding uses and the 0 a skip uses", () => {
		const r = runBroken("HTTP 422: Validation Failed");
		expect(r.status).toBe(2);
	});

	it("says BROKEN and names the reason, and never says SKIP", () => {
		const r = runBroken("HTTP 422: Validation Failed");
		expect(r.stderr).toContain("BROKEN");
		expect(r.stderr).toContain("HTTP 422: Validation Failed");
		expect(r.stderr).toContain("fault in the check, not a finding");
		expect(r.stderr).not.toContain("SKIP");
		expect(r.stderr).not.toContain("KEPT GOING");
	});

	it("hints at the buffer when the cause is ENOBUFS", () => {
		const stub = stubGhScript(dir, "#!/bin/sh\necho 'aaaaaaaaaaaaaaaa'\n");
		const r = runInline(
			inCheck(
				`try { gh(["issue","list"], { maxBuffer: 4 }); } catch (e) { raiseGhFailure(e); }
				 return { okLine: "reached the end" };`,
			),
			{ ...process.env, WFC_GH: stub.gh },
		);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("MAX_BUFFER");
	});
});

/*
 * `gh issue list --limit N` returns at most N rows and says nothing about the
 * rest, so a tracker that reaches the ceiling silently narrows every check to a
 * subset of itself.
 */
describe("the truncation ceiling", () => {
	it("passes a short result straight through", async () => {
		const { assertWholeTracker } = await load();
		const rows = [{ number: 1 }];
		expect(assertWholeTracker(rows)).toBe(rows);
	});

	it("ghIssueListAll appends the ceiling to the caller's own args", async () => {
		const { ghIssueListAll, ISSUE_LIST_LIMIT } = await load();
		inject(`#!/bin/sh\necho "$*" > ${dir}/args\necho "[]"\n`);
		ghIssueListAll("closed issues", ["--state", "closed", "--json", "number"]);
		expect(fs.readFileSync(path.join(dir, "args"), "utf8").trim()).toBe(
			`issue list --state closed --json number --limit ${ISSUE_LIST_LIMIT}`,
		);
	});

	it("exits 2 as BROKEN when the result is exactly the ceiling, naming the list and ISSUE_LIST_LIMIT and going no further", () => {
		const r = runInline(
			inCheck(
				`assertWholeTracker(new Array(ISSUE_LIST_LIMIT).fill({}), "closed issues");
				 console.error("KEPT GOING");
				 return { okLine: "reached the end" };`,
			),
			{ ...process.env },
		);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("BROKEN");
		expect(r.stderr).toContain("closed issues");
		expect(r.stderr).toContain("ISSUE_LIST_LIMIT");
		expect(r.stderr).not.toContain("KEPT GOING");
	});
});

describe("ghAllIssues", () => {
	it("asks for closed issues too, 100 to a page", async () => {
		const { ghAllIssues } = await load();
		inject(`#!/bin/sh\necho "$*" > ${dir}/args\necho '[[{"number":1}]]'\n`);
		ghAllIssues();
		const args = fs.readFileSync(path.join(dir, "args"), "utf8");
		// state=all: a closed parent still has to resolve, or every child of one
		// reads as an orphan.
		expect(args).toContain("-f state=all");
		// per_page=100 against the endpoint's default of 30 (#2300).
		expect(args).toContain("-f per_page=100");
		expect(args).toContain("repos/{owner}/{repo}/issues");
	});

	it("flattens the pages into one list of issues", async () => {
		const { ghAllIssues } = await load();
		inject('#!/bin/sh\necho \'[[{"number":1}],[{"number":2}]]\'\n');
		expect(ghAllIssues()).toEqual([{ number: 1 }, { number: 2 }]);
	});
});

describe("an empty open-issue read (#2565)", () => {
	/** A stub answering the nth issues call with `pages[n]`, the last one
	 * repeating, and the repo read with `count`. */
	const lists = (pages: string[], count: number) => {
		for (const [n, p] of pages.entries())
			fs.writeFileSync(path.join(dir, `page${n}`), p);
		const last = pages.length - 1;
		inject(
			[
				"#!/bin/sh",
				`echo "$*" >> ${dir}/calls`,
				'case "$*" in',
				'*"/issues "*)',
				`  n=$(cat ${dir}/n 2>/dev/null || echo 0); expr $n + 1 > ${dir}/n`,
				`  [ "$n" -gt ${last} ] && n=${last}; cat ${dir}/page$n ;;`,
				`*) echo '{"open_issues_count":${count}}' ;;`,
				"esac",
				"",
			].join("\n"),
		);
	};
	const readCalls = () =>
		fs.readFileSync(path.join(dir, "calls"), "utf8").trim().split("\n");

	it("re-reads once and returns the second answer, with no repo read", async () => {
		const { ghOpenIssues } = await load();
		lists(["[[]]", '[[{"number":7}]]'], 116);
		expect(ghOpenIssues()).toEqual([{ number: 7 }]);
		expect(readCalls()).toHaveLength(2);
	});

	it("is believed when the repo counts no open issues either", async () => {
		const { ghOpenIssues } = await load();
		lists(["[[]]"], 0);
		expect(ghOpenIssues()).toEqual([]);
		expect(readCalls()[2]).toBe("api repos/{owner}/{repo}");
	});

	it("is BROKEN, exit 2 and going no further, when the repo counts open issues", () => {
		lists(["[[]]"], 116);
		const r = runInline(
			inCheck(
				`try { ghOpenIssues(); } catch (e) { raiseGhFailure(e, "No gate was read."); }
				 console.error("KEPT GOING");
				 return { okLine: "reached the end" };`,
			),
			{ ...process.env },
		);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("GitHub counts 116 open");
		// raiseGhFailure passes the refusal on rather than re-reading it as a gh fault.
		expect(r.stderr).not.toContain("not because GitHub was unreachable");
		expect(r.stderr).not.toContain("KEPT GOING");
	});

	it.each([["ghClosedIssuesWithLabel"], ["ghOpenIssuesWithLabel"]])(
		"%s believes an empty re-run, a filtered read being empty for real",
		async (fn) => {
			const lib = await load();
			lists(["[[]]"], 116);
			expect(lib[fn]("x")).toEqual([]);
			expect(readCalls()).toHaveLength(2);
			expect(readCalls()).not.toContain("api repos/{owner}/{repo}");
		},
	);
});

describe("ghGetRetrying — the shared fan-out read (mantahostels#1145)", () => {
	it("retries once, then reports the failure rather than throwing", async () => {
		const { ghGetRetrying } = await load();
		// Succeeds only on the second call, which is the transient 502 the retry
		// exists for.
		inject(
			`#!/bin/sh\nn=$(cat ${dir}/n 2>/dev/null || echo 0)\nexpr $n + 1 > ${dir}/n\nif [ "$n" = "0" ]; then echo "gh: HTTP 502" >&2; exit 1; fi\necho '[[{"number":7}]]'\n`,
		);
		expect(await ghGetRetrying("repos/o/r/issues/1")).toEqual({
			ok: true,
			out: [{ number: 7 }],
		});
	});

	it("gives up after the second failure, carrying gh's own reason", async () => {
		const { ghGetRetrying } = await load();
		inject('#!/bin/sh\necho "gh: HTTP 502 Bad Gateway" >&2\nexit 1\n');
		const r = await ghGetRetrying("repos/o/r/issues/1");
		expect(r.ok).toBe(false);
		expect(r.error).toContain("502");
	});

	it("reads an empty stdout as an empty list by default", async () => {
		const { ghGetRetrying } = await load();
		inject("#!/bin/sh\nexit 0\n");
		expect(await ghGetRetrying("repos/o/r/issues/1")).toEqual({
			ok: true,
			out: [],
		});
	});

	it("under strict, an exit 0 that printed nothing is a failure", async () => {
		// On dependencies/blocked_by that empty list is indistinguishable from
		// "no blockers", so a caller building a frontier cannot accept it.
		const { ghGetRetrying } = await load();
		inject("#!/bin/sh\nexit 0\n");
		const r = await ghGetRetrying("repos/o/r/issues/1", { strict: true });
		expect(r.ok).toBe(false);
		expect(r.error).toContain("printed nothing");
	});

	it("strict still accepts a genuinely empty JSON list", async () => {
		const { ghGetRetrying } = await load();
		inject("#!/bin/sh\necho '[[]]'\n");
		expect(await ghGetRetrying("x", { strict: true })).toEqual({
			ok: true,
			out: [],
		});
	});
});

describe("mapLimit — the bounded fan-out (mantahostels#1145)", () => {
	it("returns results in input order, not completion order", async () => {
		const { mapLimit } = await load();
		// The first item finishes last, so a function collecting results as they
		// land would return them reversed — and both callers pair result[i] with
		// items[i].
		const out = await mapLimit(
			[30, 20, 10],
			3,
			(ms: number) => new Promise((res) => setTimeout(() => res(ms), ms)),
		);
		expect(out).toEqual([30, 20, 10]);
	});

	it("never runs more than `limit` at once", async () => {
		const { mapLimit } = await load();
		let inFlight = 0;
		let peak = 0;
		await mapLimit(
			Array.from({ length: 20 }, (_, i) => i),
			3,
			async () => {
				peak = Math.max(peak, ++inFlight);
				await new Promise((res) => setTimeout(res, 1));
				inFlight--;
			},
		);
		expect(peak).toBe(3);
	});

	it("clamps the limit to the item count rather than spawning idle workers", async () => {
		const { mapLimit } = await load();
		expect(await mapLimit([1], 8, async (n: number) => n * 2)).toEqual([2]);
		expect(await mapLimit([], 8, async () => 1)).toEqual([]);
	});
});
