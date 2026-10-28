// @vitest-environment node
/*
 * The request register's CLI (mantahostels#1782, spec mantahostels#1702): a session denied a file can
 * ask the live holder for it without waiting on anything, the holder can
 * decline, and the record dies on each of its four lifetime routes.
 *
 * Spawned rather than called in-process, like arbiter-deadlock.test.ts.
 *
 * `request` is the in-band ask a blocked session is told to make once its wait
 * hits its ceiling, and the notice reaches the holder through the
 * lib/file-claim.js `PreToolUse` core: loosen a case and an ask can go
 * undelivered, or a dead request can keep nagging a holder that owes nothing.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	AS_ROOT,
	arbiterCli,
	freshSandbox,
	live,
	proc,
	registerSession,
	store,
} from "./lib/arbiter-testkit";

const sb = freshSandbox();

const { cli, readListing } = arbiterCli(sb);

const inRepo = (rel: string) => path.join(sb.repo, rel);

/** A lock on `subject` held by a live session that is not the one under test. */
const neighbourHolds = (sessionId: string, subject: string) => {
	// A crafted identity rather than live(): the registry keys its file by pid,
	// so registering the neighbour would be undone by the requester's own live()
	// call.
	const me = {
		sessionId,
		pid: process.pid,
		procStart: proc.readProcStartOf(process.pid),
		durable: true,
	};
	const { verdict } = store.acquire(subject, me);
	expect(verdict).toBe("claimed");
};

/** Rewrite `rel`'s lock onto a pid/start pair that cannot be alive. */
const holderDies = (rel: string) => {
	const f = store.paths.lock(rel);
	const rec = JSON.parse(fs.readFileSync(f, "utf8"));
	fs.writeFileSync(f, JSON.stringify({ ...rec, pid: 999_999, procStart: "1" }));
};

const request = (sessionId: string, rel: string, why?: string) =>
	cli(["request", inRepo(rel), ...(why ? [why] : [])], {
		CLAUDE_CODE_SESSION_ID: sessionId,
	});

describe("request — recording the ask (mantahostels#1782)", () => {
	it("records a request against the current holder", () => {
		neighbourHolds("neighbour", "docs/a.md");
		live(sb, "mine");
		const r = request("mine", "docs/a.md", "need it for the B5 entry");
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("Requested docs/a.md");
		// The debt waits on the request's answer, as rule:file-claim orders it (#1855).
		expect(r.stdout).toContain("once it is refused or goes unanswered, record");
		expect(store.readRequests()).toMatchObject([
			{
				subject: "docs/a.md",
				requester: "mine",
				holder: "neighbour",
				why: "need it for the B5 entry",
				declined: null,
			},
		]);
	});

	it("records a why opening `--` as text, never a flag (#1137)", () => {
		neighbourHolds("neighbour", "docs/a.md");
		live(sb, "mine");
		const r = request("mine", "docs/a.md", "--help, I need the B5 entry");
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("Requested docs/a.md");
		expect(store.readRequests()).toMatchObject([
			{ subject: "docs/a.md", why: "--help, I need the B5 entry" },
		]);
	});

	it("records both sessions asking for the same path — the (path, requester) keying", () => {
		neighbourHolds("neighbour", "docs/a.md");
		// Two durable requesters at once need two live pids: the registry keys its
		// entry file by pid.
		registerSession(sb, "mine", process.pid);
		registerSession(sb, "second", process.ppid);
		expect(request("mine", "docs/a.md").status).toBe(0);
		expect(request("second", "docs/a.md").status).toBe(0);
		const requesters = store
			.readRequests()
			.map((r: { requester: string }) => r.requester)
			.sort();
		expect(requesters).toEqual(["mine", "second"]);
	});

	it("refuses a path outside the repo with a clear message, exit 0", () => {
		live(sb, "mine");
		const r = cli(["request", "/tmp/elsewhere.md"], {
			CLAUDE_CODE_SESSION_ID: "mine",
		});
		expect(r.status).toBe(0);
		expect(r.stderr).toContain("not in this repo");
		expect(store.readRequests()).toEqual([]);
	});

	it("refuses an unwatched path with a clear message, exit 0", () => {
		live(sb, "mine");
		const r = request("mine", "notes.txt");
		expect(r.status).toBe(0);
		expect(r.stderr).toContain("takes no claims");
		expect(store.readRequests()).toEqual([]);
	});

	it("refuses a path this session already holds, rather than asking itself", () => {
		live(sb, "mine");
		expect(
			cli(["claim", inRepo("docs/a.md")], { CLAUDE_CODE_SESSION_ID: "mine" })
				.status,
		).toBe(0);
		const r = request("mine", "docs/a.md");
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("already holds");
		expect(store.readRequests()).toEqual([]);
	});

	it("refuses a path nobody holds, and says to just take it", () => {
		live(sb, "mine");
		const r = request("mine", "docs/a.md");
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("Nobody holds docs/a.md");
		expect(r.stdout).toContain(
			"node scripts/session-arbiter.js claim docs/a.md\n",
		);
		expect(store.readRequests()).toEqual([]);
	});

	it("names itself at the plugin root when run as an install (#1110)", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "arbiter-install-"));
		try {
			live(sb, "mine");
			const r = cli(["request", inRepo("docs/a.md")], {
				CLAUDE_CODE_SESSION_ID: "mine",
				WFC_SCRIPT_ROOT: root,
			});
			expect(r.status).toBe(0);
			expect(r.stdout).toContain(
				`node ${root}/scripts/session-arbiter.js claim docs/a.md\n`,
			);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("records the ask against a holder that was RESUMED onto a new pid (#259)", () => {
		// The harmful limb: the lock froze a pid that is gone, but the holder is a
		// live session under a fresh host, and the write path refuses it.
		neighbourHolds("neighbour", "docs/a.md");
		holderDies("docs/a.md");
		registerSession(sb, "neighbour", process.ppid); // the host it resumed onto
		live(sb, "mine");
		const r = request("mine", "docs/a.md", "need the file");
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("Requested docs/a.md");
		expect(r.stdout).not.toContain("Nobody holds");
		expect(store.readRequests()).toHaveLength(1);
	});

	it("still says free where the dead holder was not resumed but ended (#259)", () => {
		// The positive limb of the case above: crediting a resumed holder must not
		// become crediting every dead one.
		neighbourHolds("neighbour", "docs/a.md");
		holderDies("docs/a.md");
		live(sb, "mine");
		const r = request("mine", "docs/a.md", "need the file");
		expect(r.stdout).toContain("Nobody holds docs/a.md");
		expect(store.readRequests()).toEqual([]);
	});
});

describe("requests — the requester's own view", () => {
	it("shows the outstanding request as unanswered", () => {
		neighbourHolds("neighbour", "docs/a.md");
		live(sb, "mine");
		request("mine", "docs/a.md", "one line of why");
		const r = cli(["requests"], { CLAUDE_CODE_SESSION_ID: "mine" });
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("docs/a.md");
		expect(r.stdout).toContain("one line of why");
		expect(r.stdout).toContain("unanswered");
	});

	it("shows a decline as read-and-refused, with the holder's reason", () => {
		neighbourHolds("neighbour", "docs/a.md");
		live(sb, "mine");
		request("mine", "docs/a.md");
		expect(
			cli(["decline", inRepo("docs/a.md"), "mid-edit, ask tomorrow"], {
				CLAUDE_CODE_SESSION_ID: "neighbour",
			}).status,
		).toBe(0);
		const r = cli(["requests"], { CLAUDE_CODE_SESSION_ID: "mine" });
		expect(r.stdout).toContain("DECLINED");
		expect(r.stdout).toContain("mid-edit, ask tomorrow");
		expect(r.stdout).not.toContain("unanswered");
	});

	it("says so when this session has asked for nothing", () => {
		live(sb, "mine");
		const r = cli(["requests"], { CLAUDE_CODE_SESSION_ID: "mine" });
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("No outstanding requests");
	});

	it("names the CURRENT holder off the locks, not the one frozen at ask time", () => {
		neighbourHolds("neighbour", "docs/a.md");
		live(sb, "mine");
		request("mine", "docs/a.md");
		holderDies("docs/a.md");
		const r = cli(["requests"], { CLAUDE_CODE_SESSION_ID: "mine" });
		expect(r.stdout).toContain("no longer held");
		expect(r.stdout).not.toContain("held by neighbour");
	});

	it("exits 1 on an unreadable register rather than reporting nothing asked", () => {
		neighbourHolds("neighbour", "docs/a.md");
		live(sb, "mine");
		request("mine", "docs/a.md");
		const dir = store.paths.requestsDir();
		fs.rmSync(dir, { recursive: true, force: true });
		fs.writeFileSync(dir, "not a directory");
		const r = cli(["requests"], { CLAUDE_CODE_SESSION_ID: "mine" });
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("could not be read");
		expect(r.stdout).not.toContain("No outstanding requests");
	});
});

describe("decline — the holder's explicit no", () => {
	it("is refused for a session that does not hold the path, naming who does", () => {
		neighbourHolds("neighbour", "docs/a.md");
		live(sb, "mine");
		request("mine", "docs/a.md");
		const r = cli(["decline", inRepo("docs/a.md"), "not yours to say"], {
			CLAUDE_CODE_SESSION_ID: "mine",
		});
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("not yours to decline");
		expect(r.stderr).toContain("neighbour");
		expect(store.readRequests()[0].declined).toBeNull();
	});

	it("answers plainly when there is nothing on the path to decline", () => {
		neighbourHolds("neighbour", "docs/a.md");
		const r = cli(["decline", inRepo("docs/a.md")], {
			CLAUDE_CODE_SESSION_ID: "neighbour",
		});
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("No requests on docs/a.md");
	});
});

describe("the four lifetime routes", () => {
	it("skips a request whose requester's process is gone — without deleting it", () => {
		neighbourHolds("neighbour", "docs/a.md");
		live(sb, "mine");
		request("mine", "docs/a.md");
		const f = store.paths.request("docs/a.md", "mine");
		const rec = JSON.parse(fs.readFileSync(f, "utf8"));
		fs.writeFileSync(f, JSON.stringify({ ...rec, procStart: "999999999" }));
		expect(store.readRequests()).toEqual([]);
		// Skipped, not unlinked: a RESUMED requester reads dead to holderAlive, and
		// deleting on that reading would drop a live session's ask for good. The
		// age sweep is what reaps these.
		expect(fs.existsSync(f)).toBe(true);
	});

	it("drops the request when the requester takes the claim", () => {
		neighbourHolds("neighbour", "docs/a.md");
		live(sb, "mine");
		request("mine", "docs/a.md");
		holderDies("docs/a.md");
		expect(
			cli(["claim", inRepo("docs/a.md")], { CLAUDE_CODE_SESSION_ID: "mine" })
				.status,
		).toBe(0);
		expect(fs.existsSync(store.paths.request("docs/a.md", "mine"))).toBe(false);
	});

	it("drops it on a reentrant claim too", () => {
		live(sb, "mine");
		expect(
			cli(["claim", inRepo("docs/a.md")], { CLAUDE_CODE_SESSION_ID: "mine" })
				.status,
		).toBe(0);
		// A record left from before the claim landed — minted through the store,
		// since the CLI rightly refuses to ask for a path this session holds.
		store.recordRequest("docs/a.md", store.identify("mine"), "gone", null);
		expect(store.readRequests()).toHaveLength(1);
		expect(
			cli(["claim", inRepo("docs/a.md")], { CLAUDE_CODE_SESSION_ID: "mine" })
				.status,
		).toBe(0);
		expect(store.readRequests()).toEqual([]);
	});

	it("survives the requester claiming a DIFFERENT path (mantahostels#1702 story 5)", () => {
		neighbourHolds("neighbour", "docs/a.md");
		live(sb, "mine");
		request("mine", "docs/a.md");
		expect(
			cli(["claim", inRepo("docs/b.md")], { CLAUDE_CODE_SESSION_ID: "mine" })
				.status,
		).toBe(0);
		// The want died with that claim; the request must not — it says *asking
		// for*, not *blocked on*.
		expect(store.readWants()).toEqual([]);
		expect(store.readRequests()).toHaveLength(1);
	});

	it("drops it when the hook route takes the claim — check, not claim", () => {
		neighbourHolds("neighbour", "docs/a.md");
		live(sb, "mine");
		request("mine", "docs/a.md");
		holderDies("docs/a.md");
		const r = cli(["check", inRepo("docs/a.md"), "mine"], {
			CLAUDE_CODE_SESSION_ID: "mine",
		});
		expect(r.status).toBe(0);
		expect(r.stdout).not.toContain('"deny"');
		expect(store.readRequests()).toEqual([]);
	});

	it("drops every requester's record when the holder releases the path", () => {
		// A real git repo: release refuses a file whose cleanliness git cannot
		// confirm, and the drop must ride the release actually happening.
		const git = (...a: string[]) =>
			execFileSync("git", a, { cwd: sb.repo, encoding: "utf8" });
		git("init", "-q");
		git("config", "user.email", "t@example.com");
		git("config", "user.name", "T");
		fs.writeFileSync(inRepo("docs/a.md"), "committed\n");
		git("add", "docs/a.md");
		git("-c", "core.hooksPath=/dev/null", "commit", "-qm", "base");

		registerSession(sb, "holder", process.pid);
		expect(
			cli(["claim", inRepo("docs/a.md")], { CLAUDE_CODE_SESSION_ID: "holder" })
				.status,
		).toBe(0);
		registerSession(sb, "mine", process.ppid);
		expect(request("mine", "docs/a.md").status).toBe(0);
		expect(store.readRequests()).toHaveLength(1);

		registerSession(sb, "holder", process.pid);
		expect(
			cli(["release", inRepo("docs/a.md")], {
				CLAUDE_CODE_SESSION_ID: "holder",
			}).status,
		).toBe(0);
		// The next holder inherits no obligation (mantahostels#1702 story 17).
		expect(store.readRequests()).toEqual([]);
		expect(fs.existsSync(store.paths.request("docs/a.md", "mine"))).toBe(false);
	});

	it("prunes a request older than the backstop on the session-start sweep", () => {
		neighbourHolds("neighbour", "docs/a.md");
		live(sb, "mine");
		request("mine", "docs/a.md");
		const f = store.paths.request("docs/a.md", "mine");
		// Past REQUEST_AGE_MS (48h, mantahostels#1784) — set well beyond
		// check-stranded-file-claims.js's 12h report threshold so the two ages
		// cannot be confused for one another.
		const old = new Date(Date.now() - 49 * 60 * 60 * 1000);
		fs.utimesSync(f, old, old);
		expect(cli(["prune-markers"], {}).status).toBe(0);
		expect(fs.existsSync(f)).toBe(false);
	});

	it("keeps one younger than the backstop across the same sweep", () => {
		neighbourHolds("neighbour", "docs/a.md");
		live(sb, "mine");
		request("mine", "docs/a.md");
		expect(cli(["prune-markers"], {}).status).toBe(0);
		expect(fs.existsSync(store.paths.request("docs/a.md", "mine"))).toBe(true);
	});
});

describe("the REQUESTED block under list", () => {
	it("names the requester, the subject and the current holder", () => {
		neighbourHolds("neighbour", "docs/a.md");
		live(sb, "mine");
		request("mine", "docs/a.md", "why line");
		const listing = readListing(["list"]);
		expect(listing).toContain("REQUESTED");
		expect(listing).toContain("mine");
		expect(listing).toContain("docs/a.md");
		expect(listing).toContain("neighbour");
		expect(listing).toContain("why line");
	});

	it("says the path is free once the holder is gone without releasing", () => {
		neighbourHolds("neighbour", "docs/a.md");
		live(sb, "mine");
		request("mine", "docs/a.md");
		holderDies("docs/a.md");
		const listing = readListing(["list"]);
		expect(listing).toContain("nobody holds it now");
	});

	it("names a live lock that records no session as held, never as free (#1492)", () => {
		neighbourHolds("neighbour", "docs/a.md");
		live(sb, "mine");
		request("mine", "docs/a.md");
		const f = store.paths.lock("docs/a.md");
		const rec = JSON.parse(fs.readFileSync(f, "utf8"));
		fs.writeFileSync(f, JSON.stringify({ ...rec, sessionId: null }));
		const listing = readListing(["list"]);
		expect(listing).toContain(
			"asks for docs/a.md, held by an unidentified session",
		);
		expect(listing).not.toContain("nobody holds it now");
	});

	it("carries the declined answer", () => {
		neighbourHolds("neighbour", "docs/a.md");
		live(sb, "mine");
		request("mine", "docs/a.md");
		cli(["decline", inRepo("docs/a.md"), "mid-edit"], {
			CLAUDE_CODE_SESSION_ID: "neighbour",
		});
		const listing = readListing(["list"]);
		expect(listing).toContain("DECLINED");
		expect(listing).toContain("mid-edit");
	});

	it("prints nothing of it when nobody has asked", () => {
		live(sb, "mine");
		cli(["claim", inRepo("docs/a.md")], { CLAUDE_CODE_SESSION_ID: "mine" });
		expect(readListing(["list"])).not.toContain("REQUESTED");
	});

	it("says the register is unreadable rather than printing silence", () => {
		live(sb, "mine");
		cli(["claim", inRepo("docs/a.md")], { CLAUDE_CODE_SESSION_ID: "mine" });
		// A file where the directory should be: readdir fails with ENOTDIR, which
		// is a fault and not an empty register (mantahostels#174).
		fs.writeFileSync(store.paths.requestsDir(), "not a directory");
		const r = cli(["list"], {});
		expect(r.status).toBe(0);
		expect(r.stderr).toContain("request register could not be read");
		expect(r.stdout).toContain("docs/a.md");
	});
});

describe("the notice delivered to the holder (mantahostels#1783)", () => {
	/* A real git repo: release refuses a file whose cleanliness git cannot
	 * confirm, and a notice riding a release needs a verdict. */
	const committedRepo = () => {
		const git = (...a: string[]) =>
			execFileSync("git", a, { cwd: sb.repo, encoding: "utf8" });
		git("init", "-q");
		git("config", "user.email", "t@example.com");
		git("config", "user.name", "T");
		fs.writeFileSync(inRepo("docs/a.md"), "committed\n");
		git("add", "docs/a.md");
		git("-c", "core.hooksPath=/dev/null", "commit", "-qm", "base");
	};

	const claim = (sessionId: string, rel = "docs/a.md") =>
		cli(["claim", inRepo(rel)], { CLAUDE_CODE_SESSION_ID: sessionId });

	/** The ask predates the claim `holder` then takes. */
	const askedFirst = () => {
		neighbourHolds("neighbour", "docs/a.md");
		registerSession(sb, "mine", process.ppid);
		expect(request("mine", "docs/a.md", "the B5 entry").status).toBe(0);
		holderDies("docs/a.md");
		registerSession(sb, "holder", process.pid);
	};

	it("tells the holder at its claim who is waiting, and why", () => {
		askedFirst();
		const r = claim("holder");
		expect(r.status).toBe(0);
		expect(r.stderr).toContain("waiting on a file this one holds");
		expect(r.stderr).toContain("mine asked for docs/a.md");
		expect(r.stderr).toContain("the B5 entry");
		expect(r.stderr).toMatch(/\d+m ago/);
		expect(r.stderr).toContain("decline");
	});

	it("says a request with no why line so, rather than trailing an empty quote", () => {
		neighbourHolds("neighbour", "docs/a.md");
		registerSession(sb, "mine", process.ppid);
		expect(request("mine", "docs/a.md").status).toBe(0);
		holderDies("docs/a.md");
		registerSession(sb, "holder", process.pid);
		const r = claim("holder");
		expect(r.status).toBe(0);
		expect(r.stderr).toContain("no reason given");
	});

	it("says it ONCE per holder session", () => {
		askedFirst();
		expect(claim("holder").stderr).toContain("waiting on a file");
		const again = claim("holder");
		expect(again.status).toBe(0);
		expect(again.stderr).not.toContain("waiting on a file");
	});

	it("keys the dedup on the PAIR, so a second holder is told the same ask", () => {
		neighbourHolds("neighbour", "docs/a.md");
		registerSession(sb, "mine", process.ppid);
		expect(request("mine", "docs/a.md").status).toBe(0);
		// In-process, because the CLI cannot put two holders on one lock: it is
		// the (request, holder) keying itself under test, not a delivery site.
		const opts = {
			nameOf: (id: string | null) => id ?? "",
			dirty: () => false,
		};
		expect(store.buildRequestNotice("docs/a.md", "holder", opts)).toContain(
			"waiting on a file",
		);
		expect(store.buildRequestNotice("docs/a.md", "holder", opts)).toBeNull();
		expect(store.buildRequestNotice("docs/a.md", "second", opts)).toContain(
			"waiting on a file",
		);
	});

	it("delivers at the release when the ask arrived after the claim", () => {
		committedRepo();
		registerSession(sb, "holder", process.pid);
		expect(claim("holder").status).toBe(0);
		registerSession(sb, "mine", process.ppid);
		expect(request("mine", "docs/a.md", "late ask").status).toBe(0);
		registerSession(sb, "holder", process.pid);
		const r = cli(["release", inRepo("docs/a.md")], {
			CLAUDE_CODE_SESSION_ID: "holder",
		});
		expect(r.status).toBe(0);
		expect(r.stderr).toContain("waiting on a file this one holds");
		expect(r.stderr).toContain("late ask");
		// The claim is gone, so the notice must NOT send this session off to
		// release or decline a file it no longer holds — and the park offer, which
		// answers a refusal this release did not hit, stays unsaid.
		expect(r.stderr).toContain("That release answers it");
		expect(r.stderr).not.toContain("--park");
		expect(r.stderr).not.toContain("decline");
	});

	it("offers --park where the release refused the file as dirty", () => {
		committedRepo();
		registerSession(sb, "holder", process.pid);
		expect(claim("holder").status).toBe(0);
		registerSession(sb, "mine", process.ppid);
		expect(request("mine", "docs/a.md").status).toBe(0);
		fs.writeFileSync(inRepo("docs/a.md"), "half-written\n");
		registerSession(sb, "holder", process.pid);
		const r = cli(["release", inRepo("docs/a.md")], {
			CLAUDE_CODE_SESSION_ID: "holder",
		});
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("waiting on a file this one holds");
		expect(r.stderr).toContain("release --park");
		expect(r.stderr).toContain("uncommitted work");
	});

	it("stays silent on a request the holder has already declined", () => {
		neighbourHolds("neighbour", "docs/a.md");
		registerSession(sb, "mine", process.ppid);
		expect(request("mine", "docs/a.md").status).toBe(0);
		expect(
			cli(["decline", inRepo("docs/a.md"), "mid-edit"], {
				CLAUDE_CODE_SESSION_ID: "neighbour",
			}).status,
		).toBe(0);
		holderDies("docs/a.md");
		registerSession(sb, "holder", process.pid);
		const r = claim("holder");
		expect(r.status).toBe(0);
		expect(r.stderr).not.toContain("waiting on a file");
	});

	it("never hands a session back its own ask", () => {
		live(sb, "mine");
		expect(claim("mine").status).toBe(0);
		store.recordRequest("docs/a.md", store.identify("mine"), "gone", null);
		// A reentrant claim drops it anyway, so read the notice off the release,
		// which reports before the drop.
		const r = cli(["release", inRepo("docs/a.md")], {
			CLAUDE_CODE_SESSION_ID: "mine",
		});
		// Exit 1: no git repo here, so the release refuses as `uncheckable` — a
		// verdict this session IS the holder on.
		expect(r.status).toBe(1);
		expect(r.stderr).not.toContain("waiting on a file");
	});

	it("says the register is unreadable rather than reporting nobody waiting", () => {
		live(sb, "holder");
		// Nothing has been requested here, so the parent has to be made first.
		fs.mkdirSync(path.dirname(store.paths.requestsDir()), { recursive: true });
		fs.writeFileSync(store.paths.requestsDir(), "not a directory");
		const r = claim("holder");
		expect(r.status).toBe(0);
		expect(r.stderr).toContain("request register could not be read");
		// Once per session, like every other recurring fault (mantahostels#158 §3).
		expect(claim("holder").stderr).not.toContain(
			"request register could not be read",
		);
	});
});

describe("who the notice is NOT for", () => {
	/*
	 * A forcing session is not the holder: every --force verdict names somebody
	 * else's claim, so handing it the courtesy would leak the requester's `why`
	 * line and tell a session to release a file it never claimed.
	 */
	it("says nothing to a session force-releasing another's claim", () => {
		neighbourHolds("neighbour", "docs/a.md");
		registerSession(sb, "mine", process.ppid);
		expect(request("mine", "docs/a.md").status).toBe(0);
		holderDies("docs/a.md");
		registerSession(sb, "forcer", process.pid);
		const r = cli(["release", "--force", inRepo("docs/a.md")], {
			CLAUDE_CODE_SESSION_ID: "forcer",
		});
		expect(r.stderr).not.toContain("waiting on a file");
		expect(r.stderr).not.toContain("mine asked for");
	});

	it("says nothing to a session releasing a path it never held", () => {
		neighbourHolds("neighbour", "docs/a.md");
		registerSession(sb, "mine", process.ppid);
		expect(request("mine", "docs/a.md").status).toBe(0);
		registerSession(sb, "stranger", process.pid);
		const r = cli(["release", inRepo("docs/a.md")], {
			CLAUDE_CODE_SESSION_ID: "stranger",
		});
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("not by this session");
		expect(r.stderr).not.toContain("waiting on a file");
	});

	it("reaches a holder that arrived by claim-all, the contended route", () => {
		neighbourHolds("neighbour", "docs/a.md");
		registerSession(sb, "mine", process.ppid);
		expect(request("mine", "docs/a.md", "via claim-all").status).toBe(0);
		holderDies("docs/a.md");
		registerSession(sb, "holder", process.pid);
		const r = cli(["claim-all", inRepo("docs/a.md"), inRepo("docs/b.md")], {
			CLAUDE_CODE_SESSION_ID: "holder",
		});
		expect(r.status).toBe(0);
		expect(r.stderr).toContain("waiting on a file this one holds");
		expect(r.stderr).toContain("via claim-all");
	});
});

describe("claim-all settles only what it really claimed (#1487)", () => {
	// scripts/ is watched but never refused on, so a neighbour's claim there
	// leaves the set taken while that subject stays the neighbour's.
	const detectOnly = "scripts/x.js";

	it("leaves standing a request on a subject the set did not claim", () => {
		neighbourHolds("neighbour", detectOnly);
		neighbourHolds("neighbour", "docs/b.md");
		registerSession(sb, "mine", process.ppid);
		expect(request("mine", detectOnly).status).toBe(0);
		expect(request("mine", "docs/b.md").status).toBe(0);
		holderDies("docs/b.md");
		const r = cli(["claim-all", inRepo(detectOnly), inRepo("docs/b.md")], {
			CLAUDE_CODE_SESSION_ID: "mine",
		});
		expect(r.status).toBe(0);
		expect(store.readRequests()).toMatchObject([
			{ subject: detectOnly, requester: "mine" },
		]);
	});

	it.skipIf(AS_ROOT)(
		"leaves standing a request on a subject the store could not check",
		() => {
			neighbourHolds("neighbour", "docs/a.md");
			registerSession(sb, "mine", process.ppid);
			expect(request("mine", "docs/a.md").status).toBe(0);
			const locks = store.paths.locksDir();
			fs.chmodSync(locks, 0o000);
			try {
				const r = cli(["claim-all", inRepo("docs/a.md")], {
					CLAUDE_CODE_SESSION_ID: "mine",
				});
				expect(r.status).toBe(0);
				expect(r.stderr).toContain("could not check docs/a.md");
			} finally {
				fs.chmodSync(locks, 0o755);
			}
			expect(store.readRequests()).toMatchObject([
				{ subject: "docs/a.md", requester: "mine" },
			]);
		},
	);

	it("drops the request on the id alloc-entry hands out", () => {
		const docMap = "docs/doc-map.md";
		fs.writeFileSync(inRepo(docMap), "# doc map\n\n### B7 · The last one\n");
		neighbourHolds("neighbour", `${docMap}#B8`);
		registerSession(sb, "mine", process.ppid);
		expect(request("mine", `${docMap}#B8`).status).toBe(0);
		holderDies(`${docMap}#B8`);
		const r = cli(["alloc-entry"], { CLAUDE_CODE_SESSION_ID: "mine" });
		expect(r.stdout.trim()).toBe("B8");
		expect(store.readRequests()).toEqual([]);
	});

	it("leaves the want standing where the set claimed nothing", () => {
		neighbourHolds("neighbour", "docs/a.md");
		neighbourHolds("neighbour", detectOnly);
		registerSession(sb, "mine", process.ppid);
		expect(
			cli(["claim", inRepo("docs/a.md")], { CLAUDE_CODE_SESSION_ID: "mine" })
				.status,
		).toBe(1);
		expect(
			cli(["claim-all", inRepo(detectOnly)], {
				CLAUDE_CODE_SESSION_ID: "mine",
			}).status,
		).toBe(0);
		expect(store.readWants()).toMatchObject([
			{ sessionId: "mine", wants: "docs/a.md" },
		]);
	});
});

describe("the hook route — where ordinary writes take their claims (mantahostels#1702 story 7)", () => {
	it("tells the holder at `check`", () => {
		neighbourHolds("neighbour", "docs/a.md");
		registerSession(sb, "mine", process.ppid);
		expect(request("mine", "docs/a.md", "the hook route").status).toBe(0);
		holderDies("docs/a.md");
		registerSession(sb, "holder", process.pid);
		const r = cli(["check", inRepo("docs/a.md"), "holder"], {
			CLAUDE_CODE_SESSION_ID: "holder",
		});
		expect(r.status).toBe(0);
		// The hook's own channel: additionalContext on stdout, never stderr, which
		// Claude Code does not read on a PreToolUse allow.
		expect(r.stdout).toContain("waiting on a file this one holds");
		expect(r.stdout).toContain("the hook route");
	});

	it("says it once across the two routes — the key is the request, not the verb", () => {
		neighbourHolds("neighbour", "docs/a.md");
		registerSession(sb, "mine", process.ppid);
		expect(request("mine", "docs/a.md").status).toBe(0);
		holderDies("docs/a.md");
		registerSession(sb, "holder", process.pid);
		expect(
			cli(["check", inRepo("docs/a.md"), "holder"], {
				CLAUDE_CODE_SESSION_ID: "holder",
			}).stdout,
		).toContain("waiting on a file");
		const again = cli(["claim", inRepo("docs/a.md")], {
			CLAUDE_CODE_SESSION_ID: "holder",
		});
		expect(again.stderr).not.toContain("waiting on a file");
	});
});

/*
 * #271: with the sessions registry unreadable, a RESUMED holder's lock reads as
 * dead, and a report calling the claim free sends the caller to write a file
 * somebody is editing. The registry sealed here is this session's OWN dir, the
 * only one whose failure makes readSessionEntries("best-effort") null; identify()
 * survives it (it degrades to a non-durable identity), so `request` still gets
 * far enough to answer.
 */
describe("request — a registry that will not open (#271)", () => {
	/** Make the own sessions registry refuse to open, for the body's duration. */
	const sealed = (body: () => void) => {
		const dir = store.paths.sessionsDir();
		fs.chmodSync(dir, 0o000);
		try {
			body();
		} finally {
			fs.chmodSync(dir, 0o755);
		}
	};

	it.skipIf(AS_ROOT)(
		"calls the holder UNKNOWN rather than nobody, and records no request",
		() => {
			neighbourHolds("neighbour", "docs/a.md");
			holderDies("docs/a.md");
			live(sb, "mine");
			sealed(() => {
				const r = request("mine", "docs/a.md", "need the file");
				expect(r.status).toBe(0);
				expect(r.stdout).toContain("UNKNOWN");
				expect(r.stdout).not.toContain("the claim is free");
				expect(r.stdout).not.toContain("Nobody holds");
			});
			expect(store.readRequests()).toEqual([]);
		},
	);

	it.skipIf(AS_ROOT)(
		"still says free where no lock overlaps the subject at all",
		() => {
			// The doubt has to be doubt about THIS path.
			neighbourHolds("neighbour", "docs/b.md");
			holderDies("docs/b.md");
			live(sb, "mine");
			sealed(() => {
				const r = request("mine", "docs/a.md");
				expect(r.stdout).toContain("Nobody holds docs/a.md");
				expect(r.stdout).not.toContain("UNKNOWN");
			});
		},
	);

	it.skipIf(AS_ROOT)(
		"still names the holder where the lock's own pid is alive",
		() => {
			// holderAlive() answers without the registry, so darkness never arises.
			neighbourHolds("neighbour", "docs/a.md");
			live(sb, "mine");
			sealed(() => {
				const r = request("mine", "docs/a.md", "need the file");
				expect(r.stdout).toContain("Requested docs/a.md");
				expect(r.stdout).not.toContain("UNKNOWN");
			});
			// No readRequests() check: under the seal identify() is non-durable, so
			// the record carries no pid and the reader's own liveness filter skips
			// it.
		},
	);

	it.skipIf(AS_ROOT)(
		"does not tell a session holding cover that the write is safely its own",
		() => {
			// The own-cover branch says "the write is yours to make", which is the
			// same harmful direction as "the claim is free": a region claim is
			// granted beside a whole-file lock that read stale, so cover of our own
			// does not settle whether a resumed neighbour holds the file too.
			live(sb, "mine");
			expect(
				cli(["claim", inRepo("docs/doc-map.md")], {
					CLAUDE_CODE_SESSION_ID: "mine",
				}).status,
			).toBe(0);
			// The neighbour's overlapping REGION lock, written straight to disk:
			// acquire would refuse it against the whole-file claim above.
			fs.writeFileSync(
				store.paths.lock("docs/doc-map.md#B1"),
				JSON.stringify({
					path: "docs/doc-map.md#B1",
					sessionId: "neighbour",
					pid: 999_999,
					procStart: "1",
					claimedAt: new Date().toISOString(),
				}),
			);
			sealed(() => {
				const r = request("mine", "docs/doc-map.md");
				expect(r.stdout).toContain("UNKNOWN");
				expect(r.stdout).not.toContain("yours to make");
			});
		},
	);

	it.skipIf(AS_ROOT)(
		"reports an outstanding request as UNKNOWN, not as no longer held",
		() => {
			neighbourHolds("neighbour", "docs/a.md");
			live(sb, "mine");
			expect(request("mine", "docs/a.md").status).toBe(0);
			holderDies("docs/a.md");
			sealed(() => {
				const r = cli(["requests"], { CLAUDE_CODE_SESSION_ID: "mine" });
				expect(r.status).toBe(0);
				expect(r.stdout).toContain("UNKNOWN");
				expect(r.stdout).not.toContain("no longer held");
			});
		},
	);
});
