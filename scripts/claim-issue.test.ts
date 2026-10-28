// @vitest-environment node
/*
 * Pins that a ticket a live session holds is refused with nothing written,
 * that a finished or stopped holder's ticket is claimed, and that two racing
 * sessions never both succeed.
 *
 * claim-issue.js, driven through its command line (#530; the seam ruled on
 * #500, Q1 (A)).
 *
 * Breaking it costs the one guarantee the script exists for — that two
 * sessions never both hold a ticket — so each refusal also asserts that
 * nothing was written: no record, no assignment. It is the claim step
 * `docs/agents/issue-tracker.md` and the rescue-sessions skill send every
 * session through, so a loosened case puts two sessions on one ticket.
 *
 * spawn-kept: the race case runs two processes at once, the one shape here
 * runInProcess cannot take (§X3).
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	freshSandbox,
	issueClaims,
	liveHolder,
	store,
} from "./lib/arbiter-testkit";
import { stubGhScript } from "./lib/gh-stub";
import { writeHeadlessRun } from "./lib/headless-runs-testkit";
import { runInProcess } from "./lib/run-in-process";

const SCRIPT = path.resolve(__dirname, "claim-issue.js");
const ME = "sess-me";

const sb = freshSandbox((s) => {
	fs.mkdirSync(path.join(s.repo, ".claude"), { recursive: true });
	fs.writeFileSync(
		path.join(s.repo, ".claude", "workflow-core.json"),
		JSON.stringify({ contract: 1, founder: "T", tracker: "acme/widgets" }),
	);
});

/** Serve `body` for `gh api <apiPath>`. */
const serve = (apiPath: string, body: object) => {
	const dir = path.join(sb.dir, "api");
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(
		path.join(dir, apiPath.replaceAll("/", "_")),
		JSON.stringify(body),
	);
};

const issue = (over: object = {}) => ({
	number: 530,
	title: "claim-issue: claim a ticket",
	state: "open",
	labels: [{ name: "takes:implement" }, { name: "kind:ticket" }],
	body: "Ticket body text.",
	parent_issue_url: "https://api.github.com/repos/acme/widgets/issues/528",
	...over,
});

const parent = {
	number: 528,
	title: "Spec: claim, file and resolve",
	state: "open",
	labels: [{ name: "kind:spec" }],
	body: "Parent body text.",
	parent_issue_url: null,
};

/**
 * The `gh` stub: `api <path>` answers from serve()'s files, `issue edit`
 * fails only where `assign-fails` exists — a label removal also where
 * `unpark-fails` does — and every argv is logged.
 */
const ghStub = () =>
	stubGhScript(
		sb.dir,
		[
			"#!/bin/sh",
			`echo "$*" >> "${path.join(sb.dir, "gh-calls")}"`,
			'if [ "$1" = api ]; then',
			`  f="${path.join(sb.dir, "api")}/$(echo "$2" | tr / _)"`,
			'  [ -f "$f" ] && cat "$f" && exit 0',
			'  echo "HTTP 404: Not Found" >&2; exit 1',
			"fi",
			`if [ -f "${path.join(sb.dir, "assign-fails")}" ]; then echo "HTTP 403: no" >&2; exit 1; fi`,
			`case "$*" in *--remove-label*) [ -f "${path.join(sb.dir, "unpark-fails")}" ] && { echo "HTTP 502: down" >&2; exit 1; } ;; esac`,
			"exit 0",
		].join("\n"),
	);

type Row = string | { sessionId: string; kind: string; state: string };

/** The liveness oracle, listing exactly `rows` — or failing, given null. */
const oracle = (rows: Row[] | null) => {
	const bin = path.join(sb.dir, "claude-agents");
	fs.writeFileSync(
		bin,
		rows === null
			? "#!/bin/sh\necho daemon down >&2\nexit 1\n"
			: `#!/bin/sh\necho '${JSON.stringify(rows.map((r) => (typeof r === "string" ? { sessionId: r } : r)))}'\n`,
	);
	fs.chmodSync(bin, 0o755);
	return bin;
};

const envFor = (sessionId: string | null, live: Row[] | null) => {
	const env: NodeJS.ProcessEnv = {
		...process.env,
		...ghStub().env,
		WFC_CLAUDE_BIN: oracle(live),
		CLAUDE_CODE_SESSION_ID: sessionId ?? "",
	};
	if (sessionId === null) delete env.CLAUDE_CODE_SESSION_ID;
	return env;
};

const run = (sessionId: string | null = ME, live: Row[] | null = [ME]) => {
	const r = runInProcess(SCRIPT, ["530"], { env: envFor(sessionId, live) });
	return { status: r.status, stdout: r.stdout, stderr: r.stderr };
};

const readGhCalls = () => {
	try {
		return fs
			.readFileSync(path.join(sb.dir, "gh-calls"), "utf8")
			.split("\n")
			.filter(Boolean);
	} catch {
		return [];
	}
};
const assigned = () => readGhCalls().some((c) => c.startsWith("issue edit"));

const readRecords = () =>
	issueClaims
		.readIssueClaims(530)
		.map((e: { record: { sessionId: string } }) => e.record.sessionId)
		.sort();

/** A record on #530 by `sessionId`, as the arbiter itself writes one. */
const heldBy = (sessionId: string) =>
	issueClaims.claimIssue(530, { sessionId });

const setUp = () => {
	serve("repos/acme/widgets/issues/530", issue());
	serve("repos/acme/widgets/issues/528", parent);
};

describe("a ticket another session holds", () => {
	it("refuses a live holder with exit 2, naming the session and its claim time, and writes nothing", () => {
		setUp();
		const { record } = heldBy("sess-other");
		const r = run(ME, [ME, "sess-other"]);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("held by live session sess-other");
		expect(r.stderr).toContain(record.claimedAt);
		expect(r.stderr).toContain(
			"Nothing written — take other work, or escalate a frozen holder.",
		);
		expect(readRecords()).toEqual(["sess-other"]);
		expect(assigned()).toBe(false);
	});

	it("claims a ticket held only by a finished session", () => {
		setUp();
		heldBy("sess-gone");
		const r = run(ME, [ME]);
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("Recorded the arbiter claim");
		expect(readRecords()).toEqual([ME, "sess-gone"].sort());
		expect(assigned()).toBe(true);
	});

	it("claims a ticket whose holder the oracle still lists, but as stopped (#619)", () => {
		setUp();
		heldBy("sess-stopped");
		const r = run(ME, [
			ME,
			{ sessionId: "sess-stopped", kind: "background", state: "stopped" },
		]);
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("Recorded the arbiter claim");
		expect(readRecords()).toEqual([ME, "sess-stopped"].sort());
		expect(assigned()).toBe(true);
	});

	it("still refuses a holder the oracle lists as working", () => {
		setUp();
		heldBy("sess-busy");
		const r = run(ME, [
			ME,
			{ sessionId: "sess-busy", kind: "background", state: "working" },
		]);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("held by live session sess-busy");
		expect(readRecords()).toEqual(["sess-busy"]);
		expect(assigned()).toBe(false);
	});

	it("counts a record stamped after liveness was read as live, though the oracle lists its session as stopped (#619)", () => {
		setUp();
		fs.mkdirSync(store.paths.issueClaimsDir(), { recursive: true });
		fs.writeFileSync(
			store.paths.issueClaim(530, "sess-new"),
			JSON.stringify({
				issue: 530,
				sessionId: "sess-new",
				claimedAt: new Date(Date.now() + 60_000).toISOString(),
			}),
		);
		const r = run(ME, [
			ME,
			{ sessionId: "sess-new", kind: "background", state: "stopped" },
		]);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("held by live session sess-new");
		expect(assigned()).toBe(false);
	});

	it("counts a record stamped after liveness was read as live, though the oracle did not list it", () => {
		setUp();
		// The holder's session started after this claim's oracle answered.
		fs.mkdirSync(store.paths.issueClaimsDir(), { recursive: true });
		fs.writeFileSync(
			store.paths.issueClaim(530, "sess-new"),
			JSON.stringify({
				issue: 530,
				sessionId: "sess-new",
				claimedAt: new Date(Date.now() + 60_000).toISOString(),
			}),
		);
		const r = run(ME, [ME]);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("held by live session sess-new");
		expect(readRecords()).toEqual(["sess-new"]);
		expect(assigned()).toBe(false);
	});
});

describe("re-claiming", () => {
	it("succeeds for the session already holding it and leaves exactly one record", () => {
		setUp();
		expect(run().status).toBe(0);
		const again = run();
		expect(again.status).toBe(0);
		expect(again.stdout).toContain("Already held by this session");
		expect(readRecords()).toEqual([ME]);
	});
});

describe("inside a headless overflow run (#2608)", () => {
	it("finds itself in the listing the oracle cannot give, and claims", () => {
		setUp();
		const refill = path.join(sb.dir, "refill");
		writeHeadlessRun(refill, "0123abcd", "sess-headless", { cwd: sb.repo });
		const r = runInProcess(SCRIPT, ["530"], {
			env: {
				...envFor("sess-headless", ["sess-other"]),
				WFC_REFILL_DIR: refill,
			},
		});
		expect(r.stderr).not.toContain("session liveness could not be read");
		expect(r.status).toBe(0);
		expect(readRecords()).toEqual(["sess-headless"]);
	});
});

describe("two live sessions racing for one ticket", () => {
	const spawnClaim = (env: NodeJS.ProcessEnv) =>
		new Promise<{ code: number | null; stderr: string }>((resolve) => {
			const child = spawn(process.execPath, [SCRIPT, "530"], {
				// Held long enough that the two reads certainly overlap without the
				// mutex; with it, the second waits well inside MUTEX_WAIT_MS.
				env: {
					...env,
					CLAUDE_PROJECT_DIR: sb.repo,
					WFC_CLAIM_HOLD_MS: "500",
				},
				stdio: ["ignore", "ignore", "pipe"],
			});
			let stderr = "";
			child.stderr.on("data", (d) => {
				stderr += d;
			});
			child.on("close", (code) => resolve({ code, stderr }));
		});

	it("never lets both succeed", async () => {
		setUp();
		const live = ["sess-a", "sess-b"];
		for (let round = 0; round < 3; round++) {
			fs.rmSync(store.paths.issueClaimsDir(), { recursive: true, force: true });
			// Every env built before the first spawn: envFor rewrites the oracle and
			// gh stub binaries, and a rewrite while a child execs one fails it with
			// ETXTBSY (#1590).
			const envs = live.map((s) => envFor(s, live));
			const [a, b] = await Promise.all(envs.map(spawnClaim));
			expect([a.code, b.code].sort()).toEqual([0, 2]);
			const [winner, loser] = a.code === 0 ? ["sess-a", b] : ["sess-b", a];
			expect(loser.stderr).toContain(`held by live session ${winner}`);
			expect(readRecords()).toEqual([winner]);
		}
	}, 30_000);

	it("breaks a mutex left by a process that died holding it, and claims", () => {
		setUp();
		fs.mkdirSync(store.paths.issueClaimsDir(), { recursive: true });
		fs.writeFileSync(
			path.join(store.paths.issueClaimsDir(), ".mutex-530"),
			JSON.stringify({ pid: 999_999, procStart: "1" }),
		);
		const r = run();
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("Recorded the arbiter claim");
		expect(readRecords()).toEqual([ME]);
	});

	it("exits 1 when a live process holds the mutex past the wait, saying to re-run, and writes nothing", () => {
		setUp();
		fs.mkdirSync(store.paths.issueClaimsDir(), { recursive: true });
		fs.writeFileSync(
			path.join(store.paths.issueClaimsDir(), ".mutex-530"),
			JSON.stringify(liveHolder()),
		);
		const r = runInProcess(SCRIPT, ["530"], {
			env: { ...envFor(ME, [ME]), WFC_CLAIM_WAIT_MS: "50" },
		});
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("held the arbiter's lock past its wait");
		expect(r.stderr).toContain("Nothing written — re-run.");
		expect(readRecords()).toEqual([]);
		expect(assigned()).toBe(false);
	});
});

describe("when doubt stands in for an answer", () => {
	it("refuses with exit 2 on an unreadable claim store, naming it, and assigns nothing", () => {
		setUp();
		fs.mkdirSync(path.dirname(store.paths.issueClaimsDir()), {
			recursive: true,
		});
		fs.writeFileSync(store.paths.issueClaimsDir(), "not a directory");
		const r = run();
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("issue-claim store");
		expect(r.stderr).toContain("never taken on doubt");
		expect(assigned()).toBe(false);
	});

	it("refuses with exit 2 when session liveness cannot be read, naming it", () => {
		setUp();
		const r = run(ME, null);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("session liveness could not be read");
		expect(readRecords()).toEqual([]);
		expect(assigned()).toBe(false);
	});
});

describe("a closed issue", () => {
	it("is refused with exit 2 before any write", () => {
		serve("repos/acme/widgets/issues/530", issue({ state: "closed" }));
		const r = run();
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("#530 is closed");
		expect(readRecords()).toEqual([]);
		expect(readGhCalls()).toEqual(["api repos/acme/widgets/issues/530"]);
	});
});

describe("what a claim prints", () => {
	it("prints the ticket's title, state, labels and body, then the parent's number, title, labels and body", () => {
		setUp();
		const r = run();
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("#530 claim-issue: claim a ticket");
		expect(r.stdout).toContain("state: open");
		expect(r.stdout).toContain("labels: takes:implement, kind:ticket");
		expect(r.stdout).toContain("Ticket body text.");
		expect(r.stdout).toContain("Parent #528 Spec: claim, file and resolve");
		expect(r.stdout).toContain("labels: kind:spec");
		expect(r.stdout).toContain("Parent body text.");
	});

	it('says "no parent" plainly for a standalone ticket', () => {
		serve("repos/acme/widgets/issues/530", issue({ parent_issue_url: null }));
		const r = run();
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("No parent: #530 is standalone.");
	});
});

describe("from the founder's terminal, with no session id", () => {
	it("assigns the issue and says no arbiter record was written", () => {
		setUp();
		const r = run(null);
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("no arbiter record was written");
		expect(readRecords()).toEqual([]);
		expect(assigned()).toBe(true);
	});
});

describe("an assignment failing after the record", () => {
	it("exits 1, saying the record stands and the assignment did not land", () => {
		setUp();
		fs.writeFileSync(path.join(sb.dir, "assign-fails"), "");
		const r = run();
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("assigning #530 failed (HTTP 403: no)");
		expect(r.stderr).toContain("re-run to assign");
		expect(readRecords()).toEqual([ME]);
	});
});

describe("the tracker", () => {
	it("is read from .claude/workflow-core.json for every call", () => {
		setUp();
		expect(run().status).toBe(0);
		expect(readGhCalls()).toEqual([
			"api repos/acme/widgets/issues/530",
			"issue edit 530 --repo acme/widgets --add-assignee @me",
			"api repos/acme/widgets/issues/528",
		]);
	});
});

describe("usage", () => {
	it.each([
		["a malformed", ["abc"]],
		["a missing", []],
	])("refuses %s issue number with exit 2 and the usage line", (_, args) => {
		const r = runInProcess(SCRIPT, args, { env: envFor(ME, [ME]) });
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("usage: node scripts/claim-issue.js");
		expect(readGhCalls()).toEqual([]);
	});

	it("refuses a second issue number, naming it and printing usage, rather than claiming the first", () => {
		const r = runInProcess(SCRIPT, ["530", "531"], { env: envFor(ME, [ME]) });
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("unexpected argument: 531");
		expect(r.stderr).toContain("usage:");
		expect(readGhCalls()).toEqual([]);
	});

	it("refuses a pull request with exit 2 before any write", () => {
		serve("repos/acme/widgets/issues/530", issue({ pull_request: {} }));
		const r = run();
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("#530 is a pull request, not an issue.");
		expect(readRecords()).toEqual([]);
		expect(assigned()).toBe(false);
	});
});

describe("a gh read that does not answer", () => {
	it("exits 1 when the ticket cannot be read, naming gh's reason, and writes nothing", () => {
		const r = run();
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("could not read #530 from acme/widgets");
		expect(r.stderr).toContain("HTTP 404");
		expect(readRecords()).toEqual([]);
	});

	it("exits 1 when the parent cannot be read, saying the claim itself stands", () => {
		serve("repos/acme/widgets/issues/530", issue());
		const r = run();
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("#530 is claimed, but its parent");
		expect(r.stdout).toContain("Ticket body text.");
		expect(readRecords()).toEqual([ME]);
	});
});

/* #2000: a fresh session answering a parked ticket's round clears the park. */
describe("claiming a parked ticket", () => {
	const parked = () =>
		serve(
			"repos/acme/widgets/issues/530",
			issue({ labels: [{ name: "takes:wayfinder" }, { name: "parked" }] }),
		);
	const unparked = () =>
		readGhCalls().some((c) =>
			/^issue edit 530 .*--remove-label parked$/.test(c),
		);

	it("removes the parked label and says so", () => {
		parked();
		serve("repos/acme/widgets/issues/528", parent);
		const r = run();
		expect(r.status).toBe(0);
		expect(unparked()).toBe(true);
		expect(r.stdout).toContain("Removed `parked` from #530.");
	});

	it("leaves an unparked ticket's labels alone", () => {
		setUp();
		expect(run().status).toBe(0);
		expect(unparked()).toBe(false);
	});

	it("still claims where the removal fails, warning with the command", () => {
		parked();
		serve("repos/acme/widgets/issues/528", parent);
		fs.writeFileSync(path.join(sb.dir, "unpark-fails"), "");
		const r = run();
		expect(r.status).toBe(0);
		expect(readRecords()).toEqual([ME]);
		expect(r.stderr).toContain(
			"could not remove `parked` from #530 (HTTP 502: down)",
		);
		expect(r.stderr).toContain("gh issue edit 530 --remove-label parked");
	});
});
