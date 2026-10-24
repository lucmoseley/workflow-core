// @vitest-environment node
/*
 * The judge half of mantahostels#1818: given the paths a Bash command is about to write,
 * which of them does a live neighbour hold?
 *
 * Driven in-process inside a sandbox with a real arbiter store, so a claim is
 * held the way a live session holds one. `scripts/guard-claimed-bash-write.sh`,
 * a `PreToolUse` Bash hook, prints what this judges: loosen a case and a `cp`
 * or redirect onto a tier-1 file a neighbour is editing goes unannounced, or
 * every Bash write is buried in claims nobody holds.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	finished,
	freshSandbox,
	ledger,
	live,
	locks as locksMod,
	store,
} from "./lib/arbiter-testkit";
import { runInProcess } from "./lib/run-in-process";

const SCRIPT = path.join(__dirname, "warn-claimed-bash-write.js");

/*
 * The store's own filename for a claim: a truncated sha256 of the repo-relative
 * path, duplicated here — a fixture writing lock files under a name of its own
 * invention is one the arbiter's readers cannot find.
 */
const lockFile = (rel: string) =>
	`${createHash("sha256").update(rel).digest("hex").slice(0, 16)}.json`;

const sb = freshSandbox((fresh) => {
	fs.mkdirSync(path.join(fresh.repo, "docs"), { recursive: true });
	fs.mkdirSync(path.join(fresh.repo, "scripts"), { recursive: true });
	const git = (...args: string[]) =>
		execFileSync("git", args, { cwd: fresh.repo, stdio: "ignore" });
	git("init", "-q", "-b", "main", ".");
	git("config", "user.email", "test@example.com");
	git("config", "user.name", "test");
	// This checkout's core.hooksPath is absolute, so a scratch repo would
	// otherwise run the real Husky gates (mantahostels#100's finding).
	git("config", "core.hooksPath", path.join(fresh.dir, "no-hooks"));
});

/** `sessionId` takes the claim the arbiter would take on its first write. */
function claimedBy(subject: string, sessionId: string) {
	store.acquire(subject, live(sb, sessionId));
}

/** The judge's output for `targets`, run as `sessionId`. */
function judge(sessionId: string, ...targets: string[]) {
	return judgeWith(null, sessionId, ...targets);
}

/**
 * The same, through the session ledger at `ledgerFile` (mantahostels#2345). `null` is the
 * unbounded route the hook takes when it cannot build a session key.
 */
function judgeWith(
	ledgerFile: string | null,
	sessionId: string,
	...targets: string[]
) {
	const r = runInProcess(
		SCRIPT,
		[...(ledgerFile ? ["--ledger", ledgerFile] : []), sessionId, ...targets],
		{ cwd: sb.repo, env: { ...process.env } },
	);
	expect(r.status).toBe(0); // it never fails the command it precedes
	return r.stdout;
}

const ledgerPath = (name: string) => path.join(sb.dir, `ledger-${name}.json`);

/* The figures warn-claimed-bash-write.js states, pinned as its contract:
 * SESSION_BUDGET_BYTES, POINTER_DECAY_MS and WARN_MAX_BYTES. */
const SESSION_BUDGET = 2000;
const HOUR = 60 * 60 * 1000;
const WARN_MAX = 4000;

/** The pointer as the guard prints it, off a ledger whose budget is spent. */
function pointerText(): string {
	claimedBy("docs/pointer-probe.md", "neighbour-session");
	const led = ledgerPath(`pointer-${Math.random().toString(36).slice(2)}`);
	fs.writeFileSync(
		led,
		JSON.stringify({
			bytes: SESSION_BUDGET,
			pairs: [],
			pointedAt: Date.now() - HOUR - 60_000,
		}),
	);
	const text = judgeWith(led, "mine", "docs/pointer-probe.md").trimEnd();
	expect(text).toContain("session budget");
	return text;
}

describe("a tier-1 path a live neighbour holds", () => {
	it("names the path, the holder and what a write would cost", () => {
		claimedBy("docs/doc-map.md", "neighbour-session");

		const out = judge("mine", path.join(sb.repo, "docs/doc-map.md"));

		expect(out).toContain("docs/doc-map.md");
		expect(out).toContain("neighbour-session");
		expect(out).toContain("clobber");
		expect(out).toContain("session-arbiter.js wait");
		expect(out).toContain("heredoc");
	});

	it("refuses nothing", () => {
		claimedBy("docs/doc-map.md", "neighbour-session");
		const out = judge("mine", "docs/doc-map.md");
		expect(out).toContain("Nothing will refuse it");
		expect(out).not.toContain("permissionDecision");
	});

	it("names a REGION claim, and says which region covers the write", () => {
		// mantahostels#970's finer claim: a whole-file write lands on every region of it.
		claimedBy("docs/doc-map.md#B42", "neighbour-session");
		const out = judge("mine", "docs/doc-map.md");
		expect(out).toContain("docs/doc-map.md#B42");
		expect(out).toContain("covers docs/doc-map.md");
	});
});

describe("what must stay silent", () => {
	it("a path this very session holds", () => {
		claimedBy("docs/doc-map.md", "mine");
		expect(judge("mine", "docs/doc-map.md")).toBe("");
	});

	it("a claim whose holder has stopped running", () => {
		// The lock freezes pid and procStart at claim time, so a holder that has
		// since ended is a lock whose procStart no longer matches its pid —
		// written here rather than acquired, which would freeze this live process
		// in.
		finished(sb, "gone-session");
		const lock = locksMod.newLock({
			path: "docs/doc-map.md",
			sessionId: "gone-session",
			pid: process.pid,
			procStart: "999999999",
		});
		fs.mkdirSync(store.paths.locksDir(), { recursive: true });
		fs.writeFileSync(
			path.join(store.paths.locksDir(), lockFile("docs/doc-map.md")),
			JSON.stringify(lock),
		);

		expect(judge("mine", "docs/doc-map.md")).toBe("");
	});

	it("a held path outside the refusing tier", () => {
		// `scripts/` is detect-only by mantahostels#287's ruling.
		claimedBy("scripts/pick-next.js", "neighbour-session");
		expect(judge("mine", "scripts/pick-next.js")).toBe("");
	});

	it("a held path when the command names a different one", () => {
		claimedBy("docs/doc-map.md", "neighbour-session");
		expect(judge("mine", "docs/environment.md")).toBe("");
	});

	it("a path outside the repo entirely", () => {
		expect(judge("mine", "/tmp/elsewhere.md")).toBe("");
	});

	it("no targets at all", () => {
		expect(judge("mine")).toBe("");
	});
});

describe("the payload is filtered, not the whole store", () => {
	it("prints only the paths the command names", () => {
		// Not the whole-store dump mantahostels#1778 measured — that ruling narrowed
		// `session-arbiter.js list` by liveness, not by path.
		claimedBy("docs/doc-map.md", "neighbour-session");
		claimedBy("docs/environment.md", "another-session");
		claimedBy("CLAUDE.md", "third-session");

		const out = judge("mine", "docs/doc-map.md");

		expect(out).toContain("docs/doc-map.md");
		expect(out).not.toContain("docs/environment.md");
		expect(out).not.toContain("CLAUDE.md");
	});

	/*
	 * mantahostels#2854's fourth criterion end to end (mantahostels#2865). The inline-interpreter arm
	 * hands the judge every tier-1 path a command quotes without resolving any
	 * of them, so the case it exists for is several candidates against ONE live
	 * claim. The test above is the inverse — one target, three claims — and
	 * cannot see a judge that named all the targets it was given.
	 */
	it("names one held path out of five candidates, on one line", () => {
		claimedBy("docs/environment.md", "neighbour-session");

		const out = judge(
			"mine",
			"docs/a.md",
			"docs/environment.md",
			"docs/b.md",
			"CLAUDE.md",
			".claude/settings.json",
		);

		expect(out.split("\n").filter((l) => l.startsWith("  HELD  "))).toEqual([
			expect.stringContaining("docs/environment.md"),
		]);
		expect(out).not.toContain("docs/a.md");
		expect(out).not.toContain("docs/b.md");
	});
});

describe("the session ledger (mantahostels#2345)", () => {
	it("says a (path, holder) pair once, not on every firing", () => {
		claimedBy("docs/doc-map.md", "neighbour-session");
		const led = ledgerPath("repeat");

		const first = judgeWith(led, "mine", "docs/doc-map.md");
		const second = judgeWith(led, "mine", "docs/doc-map.md");

		expect(first).toContain("docs/doc-map.md");
		expect(second).toBe("");
	});

	it("still delivers a DIFFERENT held path in full", () => {
		// The unit is the pair, not the rule.
		claimedBy("docs/doc-map.md", "neighbour-session");
		claimedBy("docs/environment.md", "other-session");
		const led = ledgerPath("second-path");

		judgeWith(led, "mine", "docs/doc-map.md");
		const out = judgeWith(led, "mine", "docs/environment.md");

		expect(out).toContain("docs/environment.md");
		expect(out).toContain("other-session");
		expect(out).toContain("Nothing will refuse it");
	});

	it("still delivers the same path under a NEW holder", () => {
		claimedBy("docs/doc-map.md", "first-holder");
		const led = ledgerPath("new-holder");
		judgeWith(led, "mine", "docs/doc-map.md");

		store.release("docs/doc-map.md", live(sb, "first-holder"));
		finished(sb, "first-holder");
		claimedBy("docs/doc-map.md", "second-holder");

		expect(judgeWith(led, "mine", "docs/doc-map.md")).toContain(
			"second-holder",
		);
	});

	it("pays the whole payload every time with no ledger — the hook's fail-open", () => {
		claimedBy("docs/doc-map.md", "neighbour-session");
		const first = judge("mine", "docs/doc-map.md");
		expect(judge("mine", "docs/doc-map.md")).toBe(first);
	});

	it("reads a malformed ledger as empty rather than as silence", () => {
		claimedBy("docs/doc-map.md", "neighbour-session");
		const led = ledgerPath("malformed");
		fs.writeFileSync(led, "{not json");

		expect(judgeWith(led, "mine", "docs/doc-map.md")).toContain(
			"docs/doc-map.md",
		);
	});

	it("degrades to a one-line pointer once the session budget is spent, then goes quiet for the hour", () => {
		const led = ledgerPath("budget");
		const rels: string[] = [];
		for (let i = 0; i < 40; i++) {
			const rel = `docs/spend-${i}.md`;
			claimedBy(rel, `holder-${i}`);
			rels.push(rel);
		}

		let spent = 0;
		let pointer = "";
		for (const rel of rels) {
			const out = judgeWith(led, "mine", rel);
			if (out.includes("session budget")) {
				pointer = out;
				break;
			}
			spent += Buffer.byteLength(out.trimEnd());
		}

		expect(pointer).toContain("session-arbiter.js list");
		expect(spent + Buffer.byteLength(pointer.trimEnd())).toBeLessThanOrEqual(
			SESSION_BUDGET,
		);

		// A SMALL payload is the test that matters: one still fitting the remainder
		// would get through if the latch were only consulted inside the
		// over-budget branch, and the enforced ceiling would then exceed the
		// stated one.
		claimedBy("docs/tiny.md", "h");
		expect(judgeWith(led, "mine", "docs/tiny.md")).toBe("");
		expect(judgeWith(led, "mine", rels.at(-1) ?? "")).toBe("");
	});

	it("records no pair on the firing it refused to pay for", () => {
		// The payload was not delivered, so a compaction — which clears the ledger
		// — must leave every one of those pairs still to come.
		const led = ledgerPath("over-budget-pairs");
		const rels: string[] = [];
		for (let i = 0; i < 40; i++) {
			const rel = `docs/unpaid-${i}.md`;
			claimedBy(rel, `holder-${i}`);
			rels.push(rel);
		}
		let last = "";
		for (const rel of rels) {
			last = rel;
			if (judgeWith(led, "mine", rel).includes("session budget")) break;
		}

		const after = JSON.parse(fs.readFileSync(led, "utf8"));
		expect(after.pointedAt).toBeGreaterThan(0);
		expect(after.pairs.some((p: string) => p.startsWith(`${last} `))).toBe(
			false,
		);
	});

	it("does not record a pair the size ceiling dropped", () => {
		// A line counted into `… and N more` was never said, so recording it
		// would suppress the only delivery it was ever going to get.
		const many: string[] = [];
		for (let i = 0; i < 60; i++) {
			const rel = `docs/clamped-${i}.md`;
			claimedBy(rel, `neighbour-${i}`);
			many.push(rel);
		}
		const led = ledgerPath("clamped");

		const out = judgeWith(led, "mine", ...many);
		expect(out).toMatch(/… and \d+ more/);

		// Pinned both ways: failing to record one that WAS said pays for it twice.
		const recorded: string[] = JSON.parse(fs.readFileSync(led, "utf8")).pairs;
		for (const rel of many)
			expect(recorded.some((p) => p.startsWith(`${rel} `))).toBe(
				out.includes(rel),
			);
		expect(recorded.length).toBeLessThan(many.length);
	});

	it("prices the session budget from the case its derivation states (mantahostels#2363)", () => {
		const pointer = pointerText();
		// The derivation's inputs are `head`, `tail` and `line()`, all ordinary
		// literals, so the fixed prose is measured off real firings rather than
		// restated from the docstring.
		claimedBy("docs/priced-a.md", "holder-a");
		claimedBy("docs/priced-b.md", "holder-b");
		const one = Buffer.byteLength(judge("mine", "docs/priced-a.md").trimEnd());
		const two = Buffer.byteLength(
			judge("mine", "docs/priced-a.md", "docs/priced-b.md").trimEnd(),
		);
		// A second line costs itself plus the newline `clamp` joins it with, so
		// the difference isolates the fixed prose from the lines either payload
		// happens to carry.
		const fixed = one - (two - one) + 1;
		expect(fixed).toBe(677);

		// The line width cannot be measured here — it turns on the holder's
		// session id, its pid width and the path, none of them this sandbox's.
		// 129 B is the docstring's figure for `docs/doc-map.md` under a uuid
		// session id.
		const lineBytes = 129;
		const stated =
			fixed +
			2 * lineBytes +
			1 +
			(fixed + lineBytes) +
			Buffer.byteLength(pointer);

		expect(stated).toBeLessThanOrEqual(SESSION_BUDGET);
		// A further delivery does not fit.
		expect(stated + fixed + lineBytes).toBeGreaterThan(SESSION_BUDGET);
	});

	it("trims a large first firing to the remainder instead of pointing at once (mantahostels#2363)", () => {
		// The session budget is under one delivery's ceiling, so an unfloored
		// clamp would compose a payload no remainder could afford and hand back a
		// pointer naming nothing.
		const pointer = pointerText();
		const led = ledgerPath("trim");
		const many: string[] = [];
		for (let i = 0; i < 40; i++) {
			const rel = `docs/trim-${i}.md`;
			claimedBy(rel, `holder-${i}`);
			many.push(rel);
		}

		const out = judgeWith(led, "mine", ...many).trimEnd();

		expect(out).not.toContain("session budget");
		expect(out).toContain("docs/trim-0.md");
		expect(out).toMatch(/… and \d+ more/);
		expect(JSON.parse(fs.readFileSync(led, "utf8")).bytes).toBeLessThanOrEqual(
			SESSION_BUDGET - Buffer.byteLength(pointer),
		);
	});
});

describe("the pointer decays hourly (mantahostels#2364)", () => {
	/** A ledger whose payload budget is spent, pointed `agoMs` ago. */
	const spentAt = (name: string, agoMs: number) => {
		const led = ledgerPath(name);
		fs.writeFileSync(
			led,
			JSON.stringify({
				bytes: SESSION_BUDGET,
				pairs: [],
				pointedAt: Date.now() - agoMs,
			}),
		);
		return led;
	};

	it("stays silent inside the hour", () => {
		claimedBy("docs/decay-quiet.md", "neighbour-session");

		expect(
			judgeWith(
				spentAt("decay-quiet", HOUR - 60_000),
				"mine",
				"docs/decay-quiet.md",
			),
		).toBe("");
	});

	it("says the pointer again once the hour is up, and restarts the clock", () => {
		claimedBy("docs/decay-again.md", "neighbour-session");
		const led = spentAt("decay-again", HOUR + 60_000);

		const again = judgeWith(led, "mine", "docs/decay-again.md");

		expect(again).toContain("session-arbiter.js list");
		// An hour passing does not buy a session past its budget a claim list it
		// did not pay for.
		expect(again).not.toContain("HELD");
		expect(judgeWith(led, "mine", "docs/decay-again.md")).toBe("");
	});

	it("charges each repeat, and records no pair for it", () => {
		const pointer = pointerText();
		claimedBy("docs/decay-charged.md", "neighbour-session");
		const led = spentAt("decay-charged", HOUR + 60_000);

		const before = Date.now();
		judgeWith(led, "mine", "docs/decay-charged.md");

		const after = JSON.parse(fs.readFileSync(led, "utf8"));
		expect(after.bytes).toBe(SESSION_BUDGET + Buffer.byteLength(pointer));
		expect(after.pairs).toEqual([]);
		// The stamp is this firing's, not the seeded one an hour back.
		expect(after.pointedAt).toBeGreaterThanOrEqual(before);
	});

	it("does not repeat over contention it has already reported", () => {
		// The pair filter runs before the decay, so an unchanging neighbour is
		// not re-announced however many hours pass.
		claimedBy("docs/decay-known.md", "neighbour-session");
		const led = ledgerPath("decay-known");
		fs.writeFileSync(
			led,
			JSON.stringify({
				bytes: SESSION_BUDGET,
				pairs: ["docs/decay-known.md neighbour-session docs/decay-known.md"],
				pointedAt: Date.now() - HOUR - 60_000,
			}),
		);

		expect(judgeWith(led, "mine", "docs/decay-known.md")).toBe("");
	});

	it("hands a pre-mantahostels#2364 ledger the pointer, not a payload it cannot afford", () => {
		// Such a ledger carries `pointed: true` and no stamp, so it reads as
		// never-pointed — but its `bytes` spent the old 4,000 B budget, leaving a
		// negative remainder.
		claimedBy("docs/legacy-ledger.md", "neighbour-session");
		const led = ledgerPath("legacy");
		fs.writeFileSync(
			led,
			JSON.stringify({ bytes: 3800, pairs: [], pointed: true }),
		);

		const out = judgeWith(led, "mine", "docs/legacy-ledger.md");

		expect(out).toContain("session-arbiter.js list");
		expect(out).not.toContain("HELD");
		// And it is stamped, so the decay runs from here rather than never.
		expect(JSON.parse(fs.readFileSync(led, "utf8")).pointedAt).toBeGreaterThan(
			0,
		);
	});

	it("says nothing at all where there is no fresh contention to repeat over", () => {
		expect(
			judgeWith(
				spentAt("decay-nonews", HOUR + 60_000),
				"mine",
				"docs/unheld.md",
			),
		).toBe("");
	});
});

describe("the size ceiling", () => {
	it("stays under it, naming the overflow rather than dropping it", () => {
		const many: string[] = [];
		for (let i = 0; i < 60; i++) {
			const rel = `docs/held-${i}.md`;
			claimedBy(rel, `neighbour-${i}`);
			many.push(rel);
		}

		const out = judge("mine", ...many).trimEnd();

		expect(Buffer.byteLength(out)).toBeLessThanOrEqual(WARN_MAX);
		expect(out).toMatch(/… and \d+ more/);
		expect(out).toContain("session-arbiter.js list");
	});
});

describe("crediting a Bash-route code write to the ledger (mantahostels#2778)", () => {
	function crediting(sessionId: string, ...paths: string[]) {
		const r = runInProcess(
			SCRIPT,
			[...paths.flatMap((p) => ["--credit", p]), sessionId],
			{ cwd: sb.repo, env: { ...process.env } },
		);
		expect(r.status).toBe(0);
		return r;
	}

	/** What the write ledger holds for `sessionId`. */
	const wrote = (sessionId: string): string[] =>
		ledger.writesBy(sessionId) ?? [];

	it("credits an uncontended code path, which is the whole point", () => {
		// Without this the session reaches concision-backstop.sh with an empty
		// ledger, and its code signal never fires on any threshold.
		crediting("credit-plain", "scripts/plain.js");
		expect(wrote("credit-plain")).toContain("scripts/plain.js");
	});

	it("credits a `scripts/` path, which the warning half may not name", () => {
		crediting("credit-tier2", "scripts/tier-two.sh");
		expect(wrote("credit-tier2")).toContain("scripts/tier-two.sh");
	});

	it("never credits a path another LIVE session holds", () => {
		// mantahostels#114's property, and the reason this is safe at all: billing a session
		// for a neighbour's file sends it to edit what that neighbour is holding.
		claimedBy("scripts/contended.js", "the-neighbour");
		crediting("credit-contended", "scripts/contended.js");
		expect(wrote("credit-contended")).not.toContain("scripts/contended.js");
	});

	it("still credits a path the session holds ITSELF", () => {
		claimedBy("scripts/mine.js", "credit-own");
		crediting("credit-own", "scripts/mine.js");
		expect(wrote("credit-own")).toContain("scripts/mine.js");
	});

	it("credits again once the holder has stopped running", () => {
		// The lock is written rather than acquired, for the reason "a claim whose
		// holder has stopped running" above gives: acquiring would freeze this live
		// process into it and the holder would read as alive.
		finished(sb, "credit-gone-holder");
		const lock = locksMod.newLock({
			path: "scripts/released.js",
			sessionId: "credit-gone-holder",
			pid: process.pid,
			procStart: "999999999",
		});
		fs.mkdirSync(store.paths.locksDir(), { recursive: true });
		fs.writeFileSync(
			path.join(store.paths.locksDir(), lockFile("scripts/released.js")),
			JSON.stringify(lock),
		);

		crediting("credit-after", "scripts/released.js");
		expect(wrote("credit-after")).toContain("scripts/released.js");
	});

	it("credits the uncontended paths of a command that also names a held one", () => {
		claimedBy("scripts/held-too.js", "another-neighbour");
		crediting("credit-mixed", "scripts/held-too.js", "scripts/free.js");
		const got = wrote("credit-mixed");
		expect(got).toContain("scripts/free.js");
		expect(got).not.toContain("scripts/held-too.js");
	});

	it("prints nothing at all while crediting", () => {
		// It rides a PreToolUse hook that turns stdout into additionalContext, so
		// anything printed here would be charged to every Bash call that writes code.
		const r = crediting("credit-quiet", "scripts/quiet.js");
		expect(r.stdout).toBe("");
	});

	it("takes no claim on what it credits", () => {
		// The ledger and the lock store are separate (mantahostels#114 vs mantahostels#113): crediting must
		// not make a `scripts/` path look held, or the next session is warned off it.
		crediting("credit-noclaim", "scripts/unclaimed.js");
		const held = locksMod.heldBy("credit-noclaim") ?? [];
		expect(held).not.toContain("scripts/unclaimed.js");
	});

	it("credits a path named twice only once", () => {
		crediting("credit-dupe", "scripts/dupe.js", "scripts/dupe.js");
		expect(wrote("credit-dupe").filter((p) => p === "scripts/dupe.js")).toEqual(
			["scripts/dupe.js"],
		);
	});

	it("credits nothing when no session id reaches it", () => {
		// Asserted on the WHOLE store, not on `writesBy("")` — that answers null
		// unconditionally, so an assertion against it would pass whatever the
		// script did.
		const r = runInProcess(SCRIPT, ["--credit", "scripts/orphan.js"], {
			cwd: sb.repo,
			env: { ...process.env },
		});
		expect(r.status).toBe(0);
		const dir = store.paths.writesDir();
		const anywhere = fs.existsSync(dir)
			? fs
					.readdirSync(dir)
					.map((f) => fs.readFileSync(path.join(dir, f), "utf8"))
					.join("\n")
			: "";
		expect(anywhere).not.toContain("scripts/orphan.js");
	});

	it("treats a live lock with NO session id as contention, not as free", () => {
		// The inverse of `warnings()`, where a holder it cannot name is skipped
		// because the line would say nothing. Here skipping would CREDIT the path.
		// Acquired for real and then anonymised, so pid and procStart stay this
		// LIVE process's and the lock keeps reading alive.
		claimedBy("scripts/anonymous.js", "about-to-be-anonymous");
		const at = path.join(
			store.paths.locksDir(),
			lockFile("scripts/anonymous.js"),
		);
		const lock = JSON.parse(fs.readFileSync(at, "utf8"));
		lock.sessionId = null;
		fs.writeFileSync(at, JSON.stringify(lock));

		crediting("credit-anon", "scripts/anonymous.js");
		expect(wrote("credit-anon")).not.toContain("scripts/anonymous.js");
	});
});

describe("noting an inline program's quoted paths for test selection (#1220)", () => {
	function selecting(sessionId: string, ...paths: string[]) {
		const r = runInProcess(
			SCRIPT,
			[...paths.flatMap((p) => ["--select", p]), sessionId],
			{ cwd: sb.repo, env: { ...process.env } },
		);
		expect(r.status).toBe(0);
		return r;
	}

	const quoted = (sessionId: string) =>
		(ledger.selectsBy(sessionId) ?? [])
			.map((e: { path: string }) => e.path)
			.sort();

	it("notes a quoted path on the selection ledger, and prints nothing", () => {
		const r = selecting("select-plain", "scripts/quoted.js", "docs/q.md");
		expect(r.stdout).toBe("");
		expect(quoted("select-plain")).toEqual(["docs/q.md", "scripts/quoted.js"]);
	});

	it("stamps each quote, so a reader can tell it from the path's last commit", () => {
		const before = Date.now();
		selecting("select-stamp", "scripts/stamped.js");
		const [entry] = ledger.selectsBy("select-stamp") ?? [];
		expect(entry.path).toBe("scripts/stamped.js");
		expect(entry.at).toBeGreaterThanOrEqual(before);
	});

	it("leaves the write ledger untouched, mantahostels#114 barring a bill for a path only read", () => {
		selecting("select-nobill", "scripts/read-only.js");
		expect(ledger.writesBy("select-nobill")).toEqual([]);
	});

	it("notes a path a live neighbour holds, the reader subtracting it", () => {
		claimedBy("scripts/held-select.js", "select-neighbour");
		selecting("select-held", "scripts/held-select.js");
		expect(quoted("select-held")).toEqual(["scripts/held-select.js"]);
	});

	it("rides alongside --credit without either swallowing the other", () => {
		const r = runInProcess(
			SCRIPT,
			[
				"--credit",
				"scripts/written.js",
				"--select",
				"scripts/quoted-too.js",
				"select-both",
			],
			{ cwd: sb.repo, env: { ...process.env } },
		);
		expect(r.status).toBe(0);
		expect(ledger.writesBy("select-both")).toEqual(["scripts/written.js"]);
		expect(quoted("select-both")).toEqual(["scripts/quoted-too.js"]);
	});
});
