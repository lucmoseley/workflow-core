// @vitest-environment node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	buildLockRecord,
	finished,
	freshSandbox,
	ledger,
	live,
	lockFiles,
	store,
} from "./arbiter-testkit";
import { warnings } from "./claim-warning.js";
import { buildHostPorts } from "./claimed-bash-write-host.js";
import { runCore } from "./guard-core-testkit";
import { buildBashPayload } from "./pretool-guard-testkit";

const lockFile = (rel: string) =>
	`${createHash("sha256").update(rel).digest("hex").slice(0, 16)}.json`;

const sb = freshSandbox((fresh) => {
	fs.mkdirSync(path.join(fresh.repo, "docs"), { recursive: true });
	fs.mkdirSync(path.join(fresh.repo, "scripts"), { recursive: true });
	fs.writeFileSync(
		path.join(fresh.repo, "package.json"),
		'{"scripts":{"test":"node scripts/run-vitest.js"}}',
	);
	const git = (...args: string[]) =>
		execFileSync("git", args, { cwd: fresh.repo, stdio: "ignore" });
	git("init", "-q", "-b", "main", ".");
	git("config", "user.email", "test@example.com");
	git("config", "user.name", "test");
	git("config", "core.hooksPath", path.join(fresh.dir, "no-hooks"));
});

function claimedBy(subject: string, sessionId: string) {
	store.acquire(subject, live(sb, sessionId));
}

function judge(sessionId: string, ...targets: string[]) {
	return judgeWith(null, sessionId, ...targets);
}

const NOW = 1_800_000_000_000;

function judgeWith(
	ledgerFile: string | null,
	sessionId: string,
	...targets: string[]
) {
	const ports = { ...buildHostPorts(), now: () => NOW };
	const locks = ports.listLocks() ?? [];
	const text =
		ledgerFile && fs.existsSync(ledgerFile)
			? fs.readFileSync(ledgerFile, "utf8")
			: null;
	const said = warnings(
		targets,
		{ session: sessionId, locks, ledger: text },
		ports,
	);
	if (ledgerFile && said.ledger)
		fs.writeFileSync(ledgerFile, JSON.stringify(said.ledger));
	return said.text ? `${said.text}\n` : "";
}

function runCommand(command: string, sessionId: string | null) {
	return runCore(
		"guard-claimed-bash-write",
		buildBashPayload(command, sessionId),
		{ root: sb.repo },
	);
}

const ledgerPath = (name: string) => path.join(sb.dir, `ledger-${name}.json`);

const SESSION_BUDGET = 2000;
const HOUR = 60 * 60 * 1000;
const WARN_MAX = 4000;

function readPointerText(): string {
	claimedBy("docs/pointer-probe.md", "neighbour-session");
	const led = ledgerPath(`pointer-${Math.random().toString(36).slice(2)}`);
	fs.writeFileSync(
		led,
		JSON.stringify({
			bytes: SESSION_BUDGET,
			pairs: [],
			pointedAt: NOW - HOUR - 60_000,
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
		expect(out).toContain("Leave the path to its holder");
		expect(out).toContain("heredoc");
	});

	it("refuses nothing", () => {
		claimedBy("docs/doc-map.md", "neighbour-session");
		const out = judge("mine", "docs/doc-map.md");
		expect(out).toContain("Nothing will refuse it");
		expect(out).not.toContain("permissionDecision");
	});

	it("names a REGION claim, and says which region covers the write", () => {
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
		finished(sb, "gone-session");
		const lock = buildLockRecord({
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
		claimedBy("docs/doc-map.md", "neighbour-session");
		claimedBy("docs/environment.md", "another-session");
		claimedBy("CLAUDE.md", "third-session");

		const out = judge("mine", "docs/doc-map.md");

		expect(out).toContain("docs/doc-map.md");
		expect(out).not.toContain("docs/environment.md");
		expect(out).not.toContain("CLAUDE.md");
	});

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

		claimedBy("docs/tiny.md", "h");
		expect(judgeWith(led, "mine", "docs/tiny.md")).toBe("");
		expect(judgeWith(led, "mine", rels.at(-1) ?? "")).toBe("");
	});

	it("records no pair on the firing it refused to pay for", () => {
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
		const many: string[] = [];
		for (let i = 0; i < 60; i++) {
			const rel = `docs/clamped-${i}.md`;
			claimedBy(rel, `neighbour-${i}`);
			many.push(rel);
		}
		const led = ledgerPath("clamped");

		const out = judgeWith(led, "mine", ...many);
		expect(out).toMatch(/… and \d+ more/);

		const recorded: string[] = JSON.parse(fs.readFileSync(led, "utf8")).pairs;
		for (const rel of many)
			expect(recorded.some((p) => p.startsWith(`${rel} `))).toBe(
				out.includes(rel),
			);
		expect(recorded.length).toBeLessThan(many.length);
	});

	it("prices the session budget from the case its derivation states (mantahostels#2363)", () => {
		const pointer = readPointerText();
		claimedBy("docs/priced-a.md", "holder-a");
		claimedBy("docs/priced-b.md", "holder-b");
		const one = Buffer.byteLength(judge("mine", "docs/priced-a.md").trimEnd());
		const two = Buffer.byteLength(
			judge("mine", "docs/priced-a.md", "docs/priced-b.md").trimEnd(),
		);
		const fixed = one - (two - one) + 1;
		expect(fixed).toBe(578);

		const lineBytes = 129;
		const stated =
			fixed +
			2 * lineBytes +
			1 +
			(fixed + lineBytes) +
			Buffer.byteLength(pointer);

		expect(stated).toBeLessThanOrEqual(SESSION_BUDGET);
		expect(stated + fixed + lineBytes).toBeGreaterThan(SESSION_BUDGET);
	});

	it("trims a large first firing to the remainder instead of pointing at once (mantahostels#2363)", () => {
		const pointer = readPointerText();
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
	const spentAt = (name: string, agoMs: number) => {
		const led = ledgerPath(name);
		fs.writeFileSync(
			led,
			JSON.stringify({
				bytes: SESSION_BUDGET,
				pairs: [],
				pointedAt: NOW - agoMs,
			}),
		);
		return led;
	};

	it("stays silent inside the hour", () => {
		claimedBy("docs/decay-quiet.md", "neighbour-session");

		expect(
			judgeWith(
				spentAt("decay-quiet", HOUR - 1),
				"mine",
				"docs/decay-quiet.md",
			),
		).toBe("");
	});

	it("says the pointer again once the hour is up, and restarts the clock", () => {
		claimedBy("docs/decay-again.md", "neighbour-session");
		const led = spentAt("decay-again", HOUR);

		const again = judgeWith(led, "mine", "docs/decay-again.md");

		expect(again).toContain("session-arbiter.js list");
		expect(again).not.toContain("HELD");
		expect(judgeWith(led, "mine", "docs/decay-again.md")).toBe("");
	});

	it("charges each repeat, and records no pair for it", () => {
		const pointer = readPointerText();
		claimedBy("docs/decay-charged.md", "neighbour-session");
		const led = spentAt("decay-charged", HOUR + 60_000);

		judgeWith(led, "mine", "docs/decay-charged.md");

		const after = JSON.parse(fs.readFileSync(led, "utf8"));
		expect(after.bytes).toBe(SESSION_BUDGET + Buffer.byteLength(pointer));
		expect(after.pairs).toEqual([]);
		expect(after.pointedAt).toBe(NOW);
	});

	it("does not repeat over contention it has already reported", () => {
		claimedBy("docs/decay-known.md", "neighbour-session");
		const led = ledgerPath("decay-known");
		fs.writeFileSync(
			led,
			JSON.stringify({
				bytes: SESSION_BUDGET,
				pairs: ["docs/decay-known.md neighbour-session docs/decay-known.md"],
				pointedAt: NOW - HOUR - 60_000,
			}),
		);

		expect(judgeWith(led, "mine", "docs/decay-known.md")).toBe("");
	});

	it("hands a pre-mantahostels#2364 ledger the pointer, not a payload it cannot afford", () => {
		claimedBy("docs/legacy-ledger.md", "neighbour-session");
		const led = ledgerPath("legacy");
		fs.writeFileSync(
			led,
			JSON.stringify({ bytes: 3800, pairs: [], pointed: true }),
		);

		const out = judgeWith(led, "mine", "docs/legacy-ledger.md");

		expect(out).toContain("session-arbiter.js list");
		expect(out).not.toContain("HELD");
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
	const crediting = (sessionId: string | null, ...paths: string[]) =>
		runCommand(`tee ${paths.join(" ")} < /dev/null`, sessionId);

	const readWrites = (sessionId: string): string[] =>
		ledger.readWritesBy(sessionId) ?? [];

	it("credits an uncontended code path, which is the whole point", () => {
		crediting("credit-plain", "scripts/plain.js");
		expect(readWrites("credit-plain")).toContain("scripts/plain.js");
	});

	it("credits a `scripts/` path, which the warning half may not name", () => {
		crediting("credit-tier2", "scripts/tier-two.sh");
		expect(readWrites("credit-tier2")).toContain("scripts/tier-two.sh");
	});

	it("never credits a path another LIVE session holds", () => {
		claimedBy("scripts/contended.js", "the-neighbour");
		crediting("credit-contended", "scripts/contended.js");
		expect(readWrites("credit-contended")).not.toContain(
			"scripts/contended.js",
		);
	});

	it("still credits a path the session holds ITSELF", () => {
		claimedBy("scripts/mine.js", "credit-own");
		crediting("credit-own", "scripts/mine.js");
		expect(readWrites("credit-own")).toContain("scripts/mine.js");
	});

	it("credits again once the holder has stopped running", () => {
		finished(sb, "credit-gone-holder");
		const lock = buildLockRecord({
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
		expect(readWrites("credit-after")).toContain("scripts/released.js");
	});

	it("credits the uncontended paths of a command that also names a held one", () => {
		claimedBy("scripts/held-too.js", "another-neighbour");
		crediting("credit-mixed", "scripts/held-too.js", "scripts/free.js");
		const got = readWrites("credit-mixed");
		expect(got).toContain("scripts/free.js");
		expect(got).not.toContain("scripts/held-too.js");
	});

	it("prints nothing at all while crediting", () => {
		const r = crediting("credit-quiet", "scripts/quiet.js");
		expect(r.output).toBe(null);
	});

	it("takes no claim on what it credits", () => {
		crediting("credit-noclaim", "scripts/unclaimed.js");
		const held = lockFiles.readHeldBy("credit-noclaim") ?? [];
		expect(held).not.toContain("scripts/unclaimed.js");
	});

	it("credits a path named twice only once", () => {
		crediting("credit-dupe", "scripts/dupe.js", "scripts/dupe.js");
		expect(
			readWrites("credit-dupe").filter((p) => p === "scripts/dupe.js"),
		).toEqual(["scripts/dupe.js"]);
	});

	it("credits nothing when no session id reaches it", () => {
		crediting(null, "scripts/orphan.js");
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
		claimedBy("scripts/anonymous.js", "about-to-be-anonymous");
		const at = path.join(
			store.paths.locksDir(),
			lockFile("scripts/anonymous.js"),
		);
		const lock = JSON.parse(fs.readFileSync(at, "utf8"));
		lock.sessionId = null;
		fs.writeFileSync(at, JSON.stringify(lock));

		crediting("credit-anon", "scripts/anonymous.js");
		expect(readWrites("credit-anon")).not.toContain("scripts/anonymous.js");
	});
});

describe("noting an inline program's quoted paths for test selection (#1220)", () => {
	const selecting = (sessionId: string, ...paths: string[]) =>
		runCommand(
			`node -e "${paths.map((p) => `r('${p}')`).join(";")}"`,
			sessionId,
		);

	const readQuoted = (sessionId: string) =>
		(ledger.readSelectsBy(sessionId) ?? [])
			.map((e: { path: string }) => e.path)
			.sort();

	it("notes a quoted path on the selection ledger, and prints nothing", () => {
		const r = selecting("select-plain", "scripts/quoted.js", "docs/q.md");
		expect(r.output).toBe(null);
		expect(readQuoted("select-plain")).toEqual([
			"docs/q.md",
			"scripts/quoted.js",
		]);
	});

	it("stamps each quote, so a reader can tell it from the path's last commit", () => {
		const before = Date.now();
		selecting("select-stamp", "scripts/stamped.js");
		const [entry] = ledger.readSelectsBy("select-stamp") ?? [];
		expect(entry.path).toBe("scripts/stamped.js");
		expect(entry.at).toBeGreaterThanOrEqual(before);
	});

	it("leaves the write ledger untouched, mantahostels#114 barring a bill for a path only read", () => {
		selecting("select-nobill", "scripts/read-only.js");
		expect(ledger.readWritesBy("select-nobill")).toEqual([]);
	});

	it("notes a path a live neighbour holds, the reader subtracting it", () => {
		claimedBy("scripts/held-select.js", "select-neighbour");
		selecting("select-held", "scripts/held-select.js");
		expect(readQuoted("select-held")).toEqual(["scripts/held-select.js"]);
	});

	it("rides alongside a credit without either swallowing the other", () => {
		runCommand(
			`node -e "r('scripts/quoted-too.js')" > scripts/written.js`,
			"select-both",
		);
		expect(ledger.readWritesBy("select-both")).toEqual(["scripts/written.js"]);
		expect(readQuoted("select-both")).toEqual(["scripts/quoted-too.js"]);
	});
});

describe("cases a mutant must not survive", () => {
	it("names a target given twice once", () => {
		claimedBy("docs/twice.md", "neighbour-session");
		const out = judge("mine", "docs/twice.md", "docs/twice.md");
		expect(
			out.split("\n").filter((l) => l.startsWith("  HELD  ")),
		).toHaveLength(1);
	});

	it("names no holder it cannot identify", () => {
		claimedBy("docs/anonymous.md", "about-to-be-anonymous");
		const at = path.join(store.paths.locksDir(), lockFile("docs/anonymous.md"));
		const lock = JSON.parse(fs.readFileSync(at, "utf8"));
		lock.sessionId = null;
		fs.writeFileSync(at, JSON.stringify(lock));
		expect(judge("mine", "docs/anonymous.md")).toBe("");
	});

	it("writes back only string pairs from a ledger holding others", () => {
		claimedBy("docs/junk-pairs.md", "neighbour-session");
		const led = ledgerPath("junk-pairs");
		fs.writeFileSync(
			led,
			JSON.stringify({ bytes: 0, pairs: [5, null], pointedAt: null }),
		);
		expect(judgeWith(led, "mine", "docs/junk-pairs.md")).toContain("HELD");
		const pairs = JSON.parse(fs.readFileSync(led, "utf8")).pairs;
		expect(pairs.every((p: unknown) => typeof p === "string")).toBe(true);
	});

	it("reads a pointedAt of zero as never pointed", () => {
		claimedBy("docs/zero-pointer.md", "neighbour-session");
		const led = ledgerPath("zero-pointer");
		fs.writeFileSync(
			led,
			JSON.stringify({ bytes: 0, pairs: [], pointedAt: 0 }),
		);
		expect(judgeWith(led, "mine", "docs/zero-pointer.md")).toContain(
			"HELD  docs/zero-pointer.md",
		);
	});

	it("points again after the decay, never resuming the payload", () => {
		const pointer = readPointerText();
		claimedBy("docs/repoint.md", "neighbour-session");
		const led = ledgerPath("repoint");
		fs.writeFileSync(
			led,
			JSON.stringify({
				bytes: 700,
				pairs: [],
				pointedAt: NOW - 2 * HOUR,
			}),
		);
		expect(judgeWith(led, "mine", "docs/repoint.md").trimEnd()).toBe(pointer);
	});

	it("keeps a first line longer than the line budget, naming it", () => {
		const dir = Array.from({ length: 5 }, (_, i) => `${i}`.repeat(190)).join(
			"/",
		);
		const rel = `docs/${dir}/long.md`;
		claimedBy(rel, "neighbour-session");
		expect(judge("mine", rel)).toContain(`HELD  ${rel}`);
	});

	it("prices a line in bytes, not characters", () => {
		const led = ledgerPath("multibyte");
		const many: string[] = [];
		for (let i = 0; i < 30; i++) {
			const rel = `docs/${"é".repeat(40)}-${i}.md`;
			claimedBy(rel, `holder-${i}`);
			many.push(rel);
		}
		const out = judgeWith(led, "mine", ...many);
		expect(out).toContain("HELD");
		expect(out).not.toContain("session budget");
	});
});
