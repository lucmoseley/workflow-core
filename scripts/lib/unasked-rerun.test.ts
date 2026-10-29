// @vitest-environment node
/*
 * lib/unasked-rerun.js's `judge` (#815, spec #810, #2800, #2913): whether a
 * bare test run is an unasked re-run — certificates attest what it would test,
 * or a red run already red on its base stands in for one (#3633), and the
 * session has not been refused before — and what it hands its latch
 * and refusal log on a refusal.
 *
 * Its branches are module cases over lib/unasked-rerun-io-fake.js, each
 * picking the port answers its situation names; the contract test holds
 * those answers to the real adapter. A few cases still run `judge` over the
 * real adapter in a throwaway repository, where the outcome turns on the
 * own-work selection and the certificate library agreeing about one tree.
 * Which command reaches the judge, and what the guard makes of each answer,
 * is lib/unasked-rerun-guard.test.ts's; the hook end to end is
 * guard-unasked-rerun.test.ts's.
 *
 * The "where it cannot judge" cases are the fail-open record: each must answer
 * `why`, which the guard logs, so dropping one hides a judge that allows
 * silently. Loosen a refusal case and a suite that can only repeat a known
 * verdict runs again unasked; loosen a never-refused one and a session's
 * needed run is denied.
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { sweptMarkers } from "./arbiter-testkit";
import type { JudgeIO } from "./unasked-rerun.js";
import { rerunFixture, SID } from "./unasked-rerun-fixture";

interface Verdict {
	deny?: string;
	note?: string;
	why?: string;
	unread?: string;
}

const { judge } = require("./unasked-rerun.js") as {
	judge: (
		input: { sessionId: string; cwd?: string; command?: string },
		io: JudgeIO,
	) => Verdict;
};
const { judgeIO } = require("./unasked-rerun-io.js") as {
	judgeIO: (root: string) => JudgeIO;
};
const { BASE, fakeIO, HEAD, NEIGHBOUR } =
	require("./unasked-rerun-io-fake.js") as {
		BASE: string;
		fakeIO: (picks?: Record<string, string>) => {
			io: JudgeIO;
			latches: { sessionId: string; at: string }[];
			refusals: Record<string, unknown>[];
		};
		HEAD: string;
		NEIGHBOUR: string;
	};

/** The judge on `command` for SID over the picked answers, and what it wrote. */
function judged(
	command: string,
	picks: Record<string, string> = {},
	over: { sessionId?: string; cwd?: string } = {},
) {
	const fake = fakeIO(picks);
	const out = judge(
		{ sessionId: SID, cwd: "/repo", command, ...over },
		fake.io,
	);
	return { out, latches: fake.latches, refusals: fake.refusals };
}

/** The refusal text, asserting the answer is a refusal and nothing else. */
const refused = (out: Verdict) => {
	expect(Object.keys(out)).toEqual(["deny"]);
	return out.deny as string;
};

describe("the first bare run over an attested HEAD", () => {
	it("is refused, naming the attesting certificate and saying re-typing runs it", () => {
		const reason = refused(judged("npm run test").out);
		expect(reason).toContain(
			`Not run: certificates already attest what this run would test at HEAD ${HEAD.slice(0, 12)}, so it can only repeat their verdict.`,
		);
		expect(reason).toContain("RUN-A");
		expect(reason.split("\n").at(-1)).toBe(
			"Type the same command again and it runs — this refuses once a session.",
		);
	});

	it("lets every later run through once the session is latched, writing nothing", () => {
		for (const command of ["npm run test:changed", "npm run test"]) {
			const { out, latches, refusals } = judged(command, { latched: "yes" });
			expect(out).toEqual({});
			expect([latches, refusals]).toEqual([[], []]);
		}
	});

	it("judges vitest alone, so an unattested pytest file refuses nothing less", () => {
		const { out } = judged("npm run test", { attestation: "pytestOwed" });
		expect(refused(out)).not.toContain("PYTEST");
	});

	it("latches the session before refusing", () => {
		expect(judged("npm run test").latches).toEqual([
			{ sessionId: SID, at: "2026-10-26T00:00:00.000Z" },
		]);
	});

	it("hands the refusal log one line naming the session, command, HEAD and attesting certificate", () => {
		expect(judged("npm run test").refusals).toMatchObject([
			{
				session: SID,
				command: "npm run test",
				head: HEAD,
				members: [
					{ sha: HEAD, at: "RUN-A", full: false, by: "sha", red: false },
				],
			},
		]);
	});

	it("logs a refused queued run under the command it was handed", () => {
		expect(judged("npm run test -- --queue").refusals).toMatchObject([
			{ session: SID, command: "npm run test -- --queue" },
		]);
	});

	it("is refused as a queued changed run", () => {
		refused(
			judged("npm run test:changed -- --queue", {
				selection: "edit",
				attestation: "attestedEdit",
			}).out,
		);
	});

	it("names the overlay's commit where git will not name HEAD", () => {
		const { out } = judged("npm run test", { head: "unresolved" });
		expect(refused(out)).toContain(`at HEAD ${HEAD.slice(0, 12)}, so`);
	});
});

describe("a red run whose every failure was already red on its base (#3633)", () => {
	const red = { attestation: "attestedRed" };

	it("is refused, naming the red, each already-red file with its evidence and the flake note, ending on the retype line", () => {
		const reason = refused(judged("npm run test", red).out);
		expect(reason).toContain(
			`Not run: runs on record already give the verdict on what this run would test at HEAD ${HEAD.slice(0, 12)}, so it can only repeat it.`,
		);
		expect(reason).toContain(
			`The verdict on record from the run at RUN-R on ${HEAD.slice(0, 12)} is a red, not a certificate`,
		);
		expect(reason).toContain(
			`  ALREADY RED on the base ${BASE.slice(0, 12)} (#3624):\n    a.test.ts — by the red store's run at ${NEIGHBOUR.slice(0, 12)}, RUN-EARLIER`,
		);
		expect(reason).toContain("repeats only about half the time between runs");
		expect(reason.split("\n").at(-1)).toBe(
			"Type the same command again and it runs — this refuses once a session.",
		);
	});

	it("logs its member as a red", () => {
		expect(judged("npm run test", red).refusals).toMatchObject([
			{
				members: [
					{ sha: HEAD, at: "RUN-R", full: false, by: "sha", red: true },
				],
			},
		]);
	});

	it("latches as any refusal does, so the session's next run goes through", () => {
		expect(judged("npm run test", red).latches).toHaveLength(1);
		expect(judged("npm run test", { ...red, latched: "yes" }).out).toEqual({});
	});

	it("is refused with no certificate store at all", () => {
		refused(judged("npm run test", { ...red, storeFault: "absent" }).out);
	});

	it("words the attesting count as runs on record, not certificates", () => {
		const reason = refused(judged("npm run test", red).out);
		expect(reason).toContain("1 run(s) on record decide");
		expect(reason).not.toContain("certificate(s) attest");
	});

	it("is refused as a changed run too", () => {
		refused(judged("npm run test:changed", { ...red, selection: "edit" }).out);
	});
});

describe("attestation judged on the session's own work, not all of HEAD (#1218)", () => {
	it("refuses once, naming the attesting certificate and the neighbour commit left out", () => {
		const { out, refusals } = judged("npm run test", {
			selection: "neighbour",
		});
		const reason = refused(out);
		expect(reason).toContain(
			`The 1 neighbour commit(s) in the range, ${NEIGHBOUR.slice(0, 12)}, are left to their own sessions' certificates and this run would not test them (#1216).`,
		);
		expect(reason).toContain("attest every file this run would test");
		expect(reason).toContain("RUN-A");
		expect(refusals).toMatchObject([
			{ own: { paths: ["a.js"], dropped: [NEIGHBOUR] } },
		]);
	});

	it("refuses where a certificate already attests the session's uncommitted edit too, counting the uncommitted files, naming the attesting certificate and logging the paths", () => {
		const { out, refusals } = judged("npm run test", {
			selection: "editUnderNeighbour",
			attestation: "attestedEdit",
		});
		const reason = refused(out);
		expect(reason).toContain("plus this session's 1 uncommitted file(s)");
		expect(reason).toContain("RUN-C");
		expect(refusals).toMatchObject([
			{
				own: { uncommitted: ["c.js"], paths: ["c.js"], dropped: [NEIGHBOUR] },
			},
		]);
	});

	it("allows where certificates do not attest the selection", () => {
		expect(
			judged("npm run test", {
				selection: "neighbour",
				attestation: "unattested",
			}).out,
		).toEqual({});
	});

	it("allows where every commit is a neighbour's, the run selecting nothing", () => {
		expect(judged("npm run test", { selection: "allNeighbours" }).out).toEqual(
			{},
		);
	});

	it("judges test:changed on the session's uncommitted files alone, allowing it where it has none", () => {
		expect(
			judged("npm run test:changed", { selection: "neighbour" }).out,
		).toEqual({});
		refused(judged("npm run test", { selection: "neighbour" }).out);
	});

	it("falls back to the HEAD test where the commit ledger will not read, and says so", () => {
		const { out } = judged("npm run test", {
			selection: "unread",
			attestation: "unattested",
		});
		expect(out.deny).toBeUndefined();
		expect(out.unread).toEqual(expect.any(String));
	});
});

describe("never refused", () => {
	it("no session id, latching and logging nothing", () => {
		const { out, latches, refusals } = judged(
			"npm run test",
			{},
			{ sessionId: "" },
		);
		expect(out).toEqual({});
		expect([latches, refusals]).toEqual([[], []]);
	});

	it("a HEAD no certificate attests", () => {
		expect(judged("npm run test", { attestation: "unattested" }).out).toEqual(
			{},
		);
	});

	it("no pass-marker store at all, which is no fault", () => {
		expect(
			judged("npm run test", {
				storeFault: "absent",
				attestation: "unattested",
			}).out,
		).toEqual({});
	});

	it("a run from another checkout", () => {
		expect(judged("npm run test", { gitDir: "elsewhere" }).out).toEqual({});
	});
});

describe("where it cannot judge, it says why", () => {
	const why = (picks: Record<string, string>) =>
		judged("npm run test", picks).out;

	it("an unreadable marker store", () => {
		expect(why({ storeFault: "unreadable" })).toEqual({
			why: "the pass-marker store could not be read (EISDIR)",
		});
	});

	it("an unreadable ledger", () => {
		expect(why({ ledger: "unreadable" })).toEqual({
			why: "this session's write ledger could not be read",
		});
	});

	it("a working directory git cannot read", () => {
		expect(why({ gitDir: "unresolved" })).toEqual({
			why: "git could not resolve the run's working directory",
		});
	});

	it("a repository root git cannot read", () => {
		expect(why({ rootGitDir: "unresolved" })).toEqual({
			why: "git could not resolve the repository root",
		});
	});

	it("own work git cannot read or write the overlay for", () => {
		expect(why({ selection: "unreadable" })).toEqual({
			why: "git could not say which files are uncommitted, or write the overlay's tree",
		});
	});

	it("certificates git cannot judge", () => {
		expect(why({ attestation: "unjudged" })).toEqual({
			why: `git could not resolve the merge-base of ${HEAD.slice(0, 12)} with origin/main`,
		});
	});

	it("an unattested HEAD over malformed store lines", () => {
		expect(why({ attestation: "unattested", malformed: "some" })).toEqual({
			why: "no certificate attests the run's selection and the pass-marker store holds 1 malformed line(s)",
		});
	});

	it("an unattested HEAD over a red store that would not read", () => {
		expect(why({ attestation: "unattestedRedFault" })).toEqual({
			why: "no certificate attests the run's selection and the red store could not be read (1 malformed line(s))",
		});
	});

	it("an unwritable refusal log still refuses, and says the line was lost", () => {
		const out = why({ logRefusal: "unwritable" });
		expect(out.deny).toEqual(expect.any(String));
		expect(out.note).toBe("the refusal log could not be written (EISDIR)");
	});

	it("an unwritable latch allows rather than refusing every run", () => {
		const { out, refusals } = judged("npm run test", { latch: "unwritable" });
		expect(out).toEqual({
			why: "the refusal latch could not be written (EACCES)",
		});
		expect(refusals).toEqual([]);
	});
});

describe("a git read that times out allows, and says so (ADR-0010)", () => {
	it.each([
		[
			"resolving the run's directory",
			{ gitDir: "timedOut" },
			"git timed out resolving the run's working directory",
		],
		[
			"resolving the repository root",
			{ rootGitDir: "timedOut" },
			"git timed out resolving the repository root",
		],
		[
			"finding the write ledger",
			{ ledger: "timedOut" },
			"a git read timed out finding this session's write ledger",
		],
		[
			"reading the session's own work",
			{ selection: "timedOut" },
			"a git read timed out reading this session's own work",
		],
		[
			"judging the certificates",
			{ attestation: "timedOut" },
			"a git read timed out judging the certificates",
		],
		[
			"naming HEAD, before any latch",
			{ head: "timedOut" },
			"a git read timed out naming HEAD",
		],
	])("allows and says why on a timeout %s", (_, picks, reason) => {
		const { out, latches } = judged("npm run test", picks);
		expect(out).toEqual({ why: reason });
		expect(latches).toEqual([]);
	});
});

describe("over the real adapter, where selection and certificates must agree on one tree", () => {
	const fx = rerunFixture();
	const real = (command: string) =>
		judge(
			{ sessionId: SID, cwd: fx.f.project, command },
			judgeIO(fx.f.project),
		);

	it("refuses once over an attested HEAD, leaving a latch the marker sweep knows and one refusal line", () => {
		const sha = fx.attestedHead();
		refused(real("npm run test"));
		expect(real("npm run test")).toEqual({});
		const latches = fs.readdirSync(fx.markers()).filter((f) => f.endsWith(SID));
		expect(latches).toHaveLength(1);
		expect(sweptMarkers(latches)).toEqual(latches);
		expect(fx.readRefusals()).toMatchObject([
			{ session: SID, head: sha, members: [{ sha, at: "RUN-A", by: "sha" }] },
		]);
	});

	it("refuses a changed run whose overlay a certificate's tree already carries", () => {
		const sha = fx.ownEdit();
		const tree = fx.git("rev-parse", `${fx.git("stash", "create")}^{tree}`);
		fx.writeStore({
			...fx.narrowedOn(sha, ["c.js"], "RUN-C"),
			treeAtEnd: tree,
		});
		expect(refused(real("npm run test:changed"))).toContain("RUN-C");
	});

	it("refuses on the session's own commit alone, a neighbour's on top left out", () => {
		const { theirs } = fx.neighbourOnTop("b.js");
		expect(refused(real("npm run test"))).toContain(theirs.slice(0, 12));
	});

	it("still refuses a session whose ledger names only committed files", () => {
		fx.attestedHead();
		fx.writeLedger(SID, "a.js");
		refused(real("npm run test"));
	});

	it("allows a session whose ledger names a new, untracked file", () => {
		fx.attestedHead();
		fs.writeFileSync(path.join(fx.f.project, "b.js"), "new\n");
		fx.writeLedger(SID, "b.js");
		expect(real("npm run test")).toEqual({});
	});

	it("allows where the neighbour's commit changed a file in the attesting certificate's read closure", () => {
		fx.neighbourOnTop("a.js", "b.js");
		expect(real("npm run test")).toEqual({});
	});

	it("allows an own uncommitted edit made after the attesting certificate's run", () => {
		fx.neighbourOnTop("b.js");
		fs.writeFileSync(path.join(fx.f.project, "a.js"), "edited\n");
		fx.writeLedger(SID, "a.js");
		expect(real("npm run test")).toEqual({});
	});
});
