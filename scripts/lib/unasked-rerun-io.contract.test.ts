// @vitest-environment node
/*
 * The contract lib/unasked-rerun-io-fake.js keeps with lib/unasked-rerun-io.js
 * (#2913, §G7): each answer the fake serves is the shape and verdict the real
 * adapter gives, over real fs and git, in the situation the answer names. Only
 * the situation's own values — shas, paths, the git dir — differ. These cases
 * are also the adapter's one real crossing (§X8 (2)). Let the fake drift and
 * judge's module cases pass on answers production never gives.
 *
 * The timed-out situations cross the real clock: the adapter's bound is a
 * child-process timeout, which only a git that really overruns trips, so
 * each points WFC_GIT at a stub that sleeps past a 200 ms bound (§X9) — short
 * enough to keep the file fast, long enough that a real git under a loaded
 * machine never trips it on the other situations, which keep the 3 s default.
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { storePath } from "./test-pass-marker.js";
import type { JudgeIO } from "./unasked-rerun.js";
import {
	LATCH_PREFIX,
	REFUSAL_LOG,
	rerunFixture,
	SID,
} from "./unasked-rerun-fixture";

const { ANSWERS, ROOT_GIT_DIR } = require("./unasked-rerun-io-fake.js") as {
	ANSWERS: Record<string, Record<string, unknown>>;
	ROOT_GIT_DIR: string;
};
const { judgeIO } = require("./unasked-rerun-io.js") as {
	judgeIO: (root: string, options?: { timeoutMs?: number }) => JudgeIO;
};

const fx = rerunFixture();
const { f } = fx;

/** A git that overruns any bound under 5 s. */
function slowGit() {
	const stub = path.join(f.dir, "slow-git");
	fs.writeFileSync(stub, "#!/bin/sh\nexec sleep 5\n", { mode: 0o755 });
	process.env.WFC_GIT = stub;
	return judgeIO(f.project, { timeoutMs: 200 });
}

/** The thrown error, or null where the write went through. */
const outcome = (write: () => void) => {
	try {
		write();
		return null;
	} catch (e) {
		return e;
	}
};

interface Dir {
	dir: string | null;
	timedOut: boolean;
}
type Selected = ReturnType<JudgeIO["selection"]>;
type Attested = ReturnType<JudgeIO["attestation"]>;

/** An answer less its situation's values, keyed by port. */
const SHAPES: Record<string, (v: unknown, rootDir: string) => unknown> = {
	latched: (v) => v,
	latch: (v) => (v as { code?: string } | null)?.code ?? null,
	logRefusal: (v) => (v as { code?: string } | null)?.code ?? null,
	gitDir: (v, rootDir) => {
		const { dir, timedOut } = v as Dir;
		if (dir === null) return { dir, timedOut };
		return { dir: dir === rootDir ? "root" : "elsewhere", timedOut };
	},
	rootGitDir: (v) => {
		const { dir, timedOut } = v as Dir;
		return { dir: dir === null ? null : "dir", timedOut };
	},
	head: (v) => {
		const { sha, timedOut } = v as { sha: string | null; timedOut: boolean };
		return { sha: sha === null ? null : /^[0-9a-f]{40}$/.test(sha), timedOut };
	},
	ledger: (v) => v,
	selection: (v) => {
		const { selection: s, timedOut } = v as Selected;
		return {
			timedOut,
			selection: s && {
				keys: Object.keys(s).sort(),
				mine: s.mine.length > 0,
				uncommitted: s.uncommitted?.length ?? null,
				scoped: s.scoped && {
					paths: s.scoped.paths.length,
					dropped: s.scoped.dropped.length,
				},
				unread: typeof s.unread,
			},
		};
	},
	storeFault: (v) => v,
	attestation: (v) => {
		const { verdict, timedOut } = v as Attested;
		return {
			timedOut,
			keys: Object.keys(verdict).sort(),
			judged: verdict.judged,
			suites: verdict.judged
				? verdict.suites.map((s) => ({
						keys: Object.keys(s).sort(),
						suite: s.suite,
						attested: s.attested,
						members: s.attested
							? s.members.map(({ marker, match }) => ({
									sha: typeof marker.sha,
									at: typeof marker.at,
									by: match.by,
								}))
							: null,
					}))
				: null,
		};
	},
	malformed: (v) => (v as number) > 0,
};

const io = () => judgeIO(f.project);

const SITUATIONS: Record<string, Record<string, () => unknown>> = {
	latched: {
		no: () => io().latched(SID),
		yes: () => {
			fs.mkdirSync(fx.markers(), { recursive: true });
			fs.writeFileSync(path.join(fx.markers(), LATCH_PREFIX + SID), "x\n");
			return io().latched(SID);
		},
	},
	latch: {
		written: () => {
			const real = io();
			const out = outcome(() => real.latch(SID, "now"));
			expect(real.latched(SID)).toBe(true);
			return out;
		},
		unwritable: () => {
			fs.mkdirSync(fx.markers(), { recursive: true });
			fs.chmodSync(fx.markers(), 0o555);
			try {
				return outcome(() => io().latch(SID, "now"));
			} finally {
				fs.chmodSync(fx.markers(), 0o755);
			}
		},
	},
	logRefusal: {
		written: () => {
			const out = outcome(() => io().logRefusal({ session: SID }));
			expect(fx.readRefusals()).toEqual([{ session: SID }]);
			return out;
		},
		unwritable: () => {
			fs.mkdirSync(path.join(fx.markers(), REFUSAL_LOG), { recursive: true });
			return outcome(() => io().logRefusal({ session: SID }));
		},
	},
	gitDir: {
		root: () => io().gitDir(f.project),
		elsewhere: () => {
			const other = path.join(f.dir, "elsewhere");
			fx.git("worktree", "add", "-q", "--detach", other);
			return io().gitDir(other);
		},
		unresolved: () => io().gitDir(fx.outside()),
		timedOut: () => slowGit().gitDir(f.project),
	},
	rootGitDir: {
		resolved: () => io().rootGitDir(),
		unresolved: () => judgeIO(fx.outside()).rootGitDir(),
		timedOut: () => slowGit().rootGitDir(),
	},
	head: {
		sha: () => io().head(),
		unresolved: () => judgeIO(fx.outside()).head(),
		timedOut: () => slowGit().head(),
	},
	ledger: {
		readable: () => io().ledger(SID),
		unreadable: () => {
			fs.mkdirSync(fx.ledgerPath(SID), { recursive: true });
			return io().ledger(SID);
		},
		/* Without CLAUDE_PROJECT_DIR the store finds its root with git, from a
		 * directory its per-cwd memo has not seen. */
		timedOut: () => {
			const fresh = path.join(f.project, "fresh");
			fs.mkdirSync(fresh);
			const before = process.cwd();
			delete process.env.CLAUDE_PROJECT_DIR;
			process.chdir(fresh);
			try {
				return slowGit().ledger(SID);
			} finally {
				process.chdir(before);
			}
		},
	},
	selection: {
		head: () => {
			fx.attestedHead();
			return io().selection(SID);
		},
		edit: () => {
			fx.ownEdit();
			return io().selection(SID);
		},
		neighbour: () => {
			fx.neighbourOnTop("b.js");
			return io().selection(SID);
		},
		editUnderNeighbour: () => {
			const own = fx.ownEdit();
			fx.git("commit", "-q", "--allow-empty", "-m", "theirs");
			fx.writeCommits(SID, own);
			fx.writeCommits("neighbour", fx.git("rev-parse", "HEAD"));
			return io().selection(SID);
		},
		allNeighbours: () => {
			const { own } = fx.neighbourOnTop("b.js");
			fx.writeCommits(SID);
			fx.writeCommits("other", own);
			return io().selection(SID);
		},
		unread: () => {
			fx.neighbourOnTop("b.js");
			const commits = path.dirname(fx.commitLedgerPath(SID));
			fs.rmSync(commits, { recursive: true });
			fs.writeFileSync(commits, "");
			return io().selection(SID);
		},
		unreadable: () => judgeIO(fx.outside()).selection(SID),
		timedOut: () => slowGit().selection(SID),
	},
	storeFault: {
		readable: () => {
			fx.attestedHead();
			return io().storeFault();
		},
		absent: () => io().storeFault(),
		unreadable: () => {
			fs.mkdirSync(storePath(f.project), { recursive: true });
			return io().storeFault();
		},
	},
	attestation: {
		attested: () => io().attestation(fx.attestedHead(), ["a.js"]),
		attestedEdit: () => {
			const sha = fx.ownEdit();
			const tree = fx.git("rev-parse", `${fx.git("stash", "create")}^{tree}`);
			fx.writeStore({
				...fx.narrowedOn(sha, ["c.js"], "RUN-C"),
				treeAtEnd: tree,
			});
			const tip = io().selection(SID).selection?.tip as string;
			return io().attestation(tip, ["c.js"]);
		},
		pytestOwed: () => {
			const sha = fx.commitTouching("a.js", "b.py");
			fx.writeStore(fx.narrowedOn(sha, ["a.js", "b.py"], "RUN-A"));
			return io().attestation(sha, null);
		},
		unattested: () => {
			fx.attestedHead();
			return io().attestation(fx.commitTouching("b.js"), null);
		},
		unjudged: () => {
			const sha = fx.attestedHead();
			fx.git("update-ref", "-d", "refs/remotes/origin/main");
			return io().attestation(sha, null);
		},
		timedOut: () => {
			const sha = fx.attestedHead();
			return slowGit().attestation(sha, null);
		},
	},
	malformed: {
		none: () => {
			fx.attestedHead();
			return io().malformed();
		},
		some: () => {
			fs.writeFileSync(storePath(f.project), `{"torn\n`);
			return io().malformed();
		},
	},
};

const CASES = Object.entries(SITUATIONS).flatMap(([port, answers]) =>
	Object.keys(answers).map((answer) => [port, answer] as const),
);

describe("the fake answers as the adapter does", () => {
	it("names a situation for every answer it serves", () => {
		expect(
			Object.fromEntries(
				Object.entries(SITUATIONS).map(([p, a]) => [p, Object.keys(a)]),
			),
		).toEqual(
			Object.fromEntries(
				Object.entries(ANSWERS).map(([p, a]) => [p, Object.keys(a)]),
			),
		);
	});

	it.each(CASES)(
		"the %s port's %s answer matches the adapter's",
		(port, answer) => {
			const shape = SHAPES[port] as (v: unknown, rootDir: string) => unknown;
			const real = (SITUATIONS[port] as Record<string, () => unknown>)[
				answer
			]?.();
			const rootDir = fx.git("rev-parse", "--absolute-git-dir");
			expect(shape(real, rootDir)).toEqual(
				shape((ANSWERS[port] as Record<string, unknown>)[answer], ROOT_GIT_DIR),
			);
		},
	);
});
