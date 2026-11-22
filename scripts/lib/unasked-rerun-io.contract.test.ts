// @vitest-environment node

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Classing } from "./already-red.js";
import {
	FAIL_STORE,
	fullAttestationOf,
	markerFrom,
	storePath,
} from "./test-pass-marker.js";
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

function slowGit() {
	const stub = path.join(f.dir, "slow-git");
	fs.writeFileSync(stub, "#!/bin/sh\nexec sleep 5\n", { mode: 0o755 });
	vi.stubEnv("WFC_GIT", stub);
	return judgeIO(f.project, { timeoutMs: 200 });
}

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

const classingShape = (marker: object) => {
	const { alreadyRed } = marker as { alreadyRed?: Classing };
	return alreadyRed
		? {
				allAlreadyRed: alreadyRed.allAlreadyRed,
				files: alreadyRed.files.map((c) => ({
					file: typeof c.file,
					red: c.red === null ? null : typeof c.red.sha,
				})),
			}
		: null;
};

const SHAPES: Record<string, (v: unknown, rootDir: string) => unknown> = {
	latched: (v) => v,
	latch: (v) => (v as { code?: string } | null)?.code ?? null,
	logRefusal: (v) => (v as { code?: string } | null)?.code ?? null,
	gitDir: (v, rootDir) => {
		const { dir, timedOut } = v as Dir;
		if (dir === null) return { dir, timedOut };
		return { dir: dir === rootDir ? "root" : "elsewhere", timedOut };
	},
	treeGitDir: (v) => {
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
		const { verdict, timedOut, redFault } = v as Attested;
		return {
			timedOut,
			redFault: typeof redFault,
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
									alreadyRed: classingShape(marker),
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
	treeGitDir: {
		resolved: () => io().treeGitDir(),
		unresolved: () => judgeIO(fx.outside()).treeGitDir(),
		timedOut: () => slowGit().treeGitDir(),
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
		timedOut: () => {
			const fresh = path.join(f.project, "fresh");
			fs.mkdirSync(fresh);
			const before = process.cwd();
			vi.stubEnv("CLAUDE_PROJECT_DIR", undefined);
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
		attestedRed: () => {
			const sha = fx.commitTouching("a.js");
			fx.writeReds(fx.redAtBase("RUN-0"), fx.redOn(sha, ["a.js"], "RUN-R"));
			return io().attestation(sha, ["a.js"]);
		},
		attestedTwoReds: () => {
			const sha = fx.commitTouching("a.js", "b.js");
			fx.writeReds(
				fx.redAtBase("RUN-0"),
				fx.redOn(sha, ["a.js"], "RUN-R"),
				fx.redOn(sha, ["b.js"], "RUN-S"),
			);
			return io().attestation(sha, ["a.js", "b.js"]);
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
		unattestedRedFault: () => {
			const sha = fx.commitTouching("a.js");
			fs.mkdirSync(fx.markers(), { recursive: true });
			fs.writeFileSync(storePath(f.project, FAIL_STORE), `{"torn\n`);
			return io().attestation(sha, ["a.js"]);
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

describe("which red runs stand beside the certificates (#3633)", () => {
	const deciders = (sha: string, within: string[] | null) => {
		const { verdict } = io().attestation(sha, within);
		const vitest = verdict.judged
			? verdict.suites.find((s) => s.suite === "vitest")
			: null;
		return vitest?.attested ? vitest.members.map((m) => m.marker.at) : null;
	};

	it("admits no red whose failure no record shows red on the base", () => {
		const sha = fx.commitTouching("a.js");
		fx.writeReds(fx.redOn(sha, ["a.js"], "RUN-R"));
		expect(deciders(sha, ["a.js"])).toBeNull();
	});

	it("admits no red that recorded no base", () => {
		const sha = fx.commitTouching("a.js");
		fx.writeReds(
			fx.redAtBase("RUN-0"),
			fx.redOn(sha, ["a.js"], "RUN-R", false),
		);
		expect(deciders(sha, ["a.js"])).toBeNull();
	});

	it("admits no red whose only record on its base is a red at the session's own commit (#3678)", () => {
		const sha = fx.commitTouching("a.js");
		const own = fx.redOn(sha, ["a.js"], "RUN-0", false);
		const red = fx.redOn(sha, ["a.js"], "RUN-R", false);
		fx.writeReds(own, { ...red, base: fx.git("rev-parse", "origin/main") });
		expect(deciders(sha, ["a.js"])).toBeNull();
		fx.writeReds(own, { ...red, base: sha });
		expect(deciders(sha, ["a.js"])).toEqual(["RUN-R"]);
	});

	it("admits no pytest red", () => {
		const sha = fx.commitTouching("a.js");
		fx.writeReds(fx.redAtBase("RUN-0"), {
			...fx.redOn(sha, ["a.js"], "RUN-R"),
			suite: "pytest",
		});
		expect(deciders(sha, ["a.js"])).toBeNull();
	});

	it("admits no red whose tree the tip no longer holds", () => {
		const sha = fx.commitTouching("a.js");
		fx.writeReds(fx.redAtBase("RUN-0"), fx.redOn(sha, ["a.js"], "RUN-R"));
		fs.writeFileSync(path.join(f.project, "a.js"), "moved on\n");
		fx.git("commit", "-q", "-am", "moved on");
		expect(deciders(fx.git("rev-parse", "HEAD"), ["a.js"])).toBeNull();
	});

	it("lets a newer certificate decide a path over a red", () => {
		const sha = fx.commitTouching("a.js");
		fx.writeReds(fx.redAtBase("RUN-0"), fx.redOn(sha, ["a.js"], "RUN-R"));
		fx.writeStore(fx.narrowedOn(sha, ["a.js"], "RUN-Z"));
		expect(deciders(sha, ["a.js"])).toEqual(["RUN-Z"]);
	});

	it("combines a red with a certificate over a selection neither covers alone", () => {
		const sha = fx.commitTouching("a.js", "b.js");
		fx.writeReds(fx.redAtBase("RUN-0"), fx.redOn(sha, ["a.js"], "RUN-R"));
		fx.writeStore(fx.narrowedOn(sha, ["b.js"], "RUN-A"));
		expect(deciders(sha, null)?.sort()).toEqual(["RUN-A", "RUN-R"]);
	});

	it("never reads the red store where certificates attest alone", () => {
		const sha = fx.attestedHead();
		fs.writeFileSync(storePath(f.project, FAIL_STORE), `{"torn\n`);
		expect(deciders(sha, ["a.js"])).toEqual(["RUN-A"]);
		expect(io().attestation(sha, ["a.js"]).redFault).toBeNull();
	});

	const earlier = "2000-01-01T00:00:00.000Z";
	const fullRed = (sha: string, base: string | null) =>
		markerFrom({ head: sha, files: {} }, { head: sha, files: {} }, null, {
			scope: {
				modulesRun: 9,
				modulesTotal: 9,
				tests: 3,
				skipped: 0,
				nameFilter: null,
				fileFilters: [],
				failures: [{ file: "a.test.ts", tests: ["t"] }],
				errors: 0,
			},
			treeAtEnd: fx.git("rev-parse", `${sha}^{tree}`),
			sessionId: null,
			attestation: fullAttestationOf({ base }),
		});

	it("admits a full red run whose every failure was already red on its launch's base", () => {
		const sha = fx.commitTouching("a.js");
		const red = fullRed(sha, fx.git("rev-parse", "origin/main"));
		fx.writeReds(fx.redAtBase(earlier), red);
		expect(deciders(sha, ["a.js"])).toEqual([red.at]);
	});

	it("admits no full red run whose launch resolved no base", () => {
		const sha = fx.commitTouching("a.js");
		fx.writeReds(fx.redAtBase(earlier), fullRed(sha, null));
		expect(deciders(sha, ["a.js"])).toBeNull();
	});

	it("admits no red carrying an error no failing test names", () => {
		const sha = fx.commitTouching("a.js");
		const red = fx.redOn(sha, ["a.js"], "RUN-R");
		fx.writeReds(fx.redAtBase("RUN-0"), {
			...red,
			scope: { ...red.scope, errors: 1 },
		});
		expect(deciders(sha, ["a.js"])).toBeNull();
	});

	it("names a newer certificate over an older red of wider reach", () => {
		const sha = fx.commitTouching("a.js", "b.js");
		fx.writeReds(
			fx.redAtBase("RUN-0"),
			fx.redOn(sha, ["a.js", "b.js"], "RUN-R"),
		);
		fx.writeStore(fx.narrowedOn(sha, ["a.js"], "RUN-Z"));
		expect(deciders(sha, ["a.js"])).toEqual(["RUN-Z"]);
	});

	it("answers a classing that throws as a fault, certificates alone judging", () => {
		const sha = fx.commitTouching("a.js");
		const red = fx.redOn(sha, ["a.js"], "RUN-R");
		fx.writeReds({
			...red,
			scope: { ...red.scope, failures: [{ file: 7, tests: ["t"] }] },
		});
		const { verdict, redFault } = io().attestation(sha, ["a.js"]);
		expect(verdict.judged && verdict.suites[0]?.attested).toBe(false);
		expect(redFault).toMatch(/^already-red runs could not be judged \(/);
	});

	it("answers a git read that times out while classing as timed out", () => {
		const sha = fx.commitTouching("a.js");
		fx.writeReds(fx.redAtBase("RUN-0"), fx.redOn(sha, ["a.js"], "RUN-R"));
		const stub = path.join(f.dir, "tree-slow-git");
		fs.writeFileSync(
			stub,
			`#!/bin/sh\ncase "$*" in *"^{tree}"*) exec sleep 5;; esac\nexec git "$@"\n`,
			{ mode: 0o755 },
		);
		vi.stubEnv("WFC_GIT", stub);
		// #3633 guess
		expect(
			judgeIO(f.project, { timeoutMs: 1000 }).attestation(sha, ["a.js"])
				.timedOut,
		).toBe(true);
	});
});
