// @vitest-environment node
/*
 * lib/repo-holds.js's functions, called in-process against a real checkout in
 * the test's temp directory: git real there, `gh` through WFC_GH's route stub,
 * and a probe hold's filing through the real file-issue.js that lib/file-through.js
 * spawns. The tick's wiring of these, one case per adapter it crosses, is
 * refill-loop-run-holds.test.ts's; the CLI's is repo-hold.test.ts's (#4314).
 * The probe is lib/guard-probe.js's, run for real on its git half; its guard
 * entry's answer is injected here, guard-probe.test.ts running the hook line.
 *
 * Broken, a repo hold (#3857) or probe hold (#3860) that never lifts stops every
 * launch into a served checkout, and one that never raises launches sessions into
 * a broken `.git`.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RefusedCall } from "./block-cause.js";
import { CORE_FAULT_TEXT } from "./core-fault.js";
import { readGhAnswer } from "./gh-fake";
import { page, printed, stubGhRoutes } from "./gh-stub";
import { writeFaultyGit } from "./git-fault-fake";
import {
	ISSUE,
	LOGGED_OUT,
	MIN,
	NOW,
	probedCheckout,
} from "./repo-hold-fixture";
import {
	attachProbeParks,
	buildHoldLines,
	dropLiftedJobs,
	holdLockedOut,
	holdsDir,
	liftHold,
	raiseHold,
	readHolds,
	readLiftedHolds,
	readTickHolds,
	tendHolds,
	writeNotice,
} from "./repo-holds.js";
import { runInProcess } from "./run-in-process.js";

const PROBE_TITLE = "Refill loop probe: shared .git failing in repo";

let dir: string;
let repo: string;
const at = (name: string) => path.join(dir, name);

const writeConfig = (root: string) => {
	fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
	fs.writeFileSync(
		path.join(root, ".claude", "workflow-core.json"),
		JSON.stringify({ tracker: "o/r" }),
	);
};

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "repo-holds-"));
	repo = at("repo");
	probedCheckout.instantiate(repo);
	writeConfig(repo);
	vi.stubEnv("WFC_REFILL_DIR", dir);
	vi.stubEnv("WFC_MODULES", "");
});

afterEach(() => {
	vi.unstubAllEnvs();
	fs.rmSync(dir, { recursive: true, force: true });
});

const ghLog = () => at("gh-log");
const readGhCalls = () =>
	fs.existsSync(ghLog())
		? fs.readFileSync(ghLog(), "utf8").split("\n").filter(Boolean)
		: [];
const readFiled = () =>
	readGhCalls().filter((l) => l.startsWith("issue create"));

const readBodies = () =>
	fs.existsSync(at("bodies")) ? fs.readFileSync(at("bodies"), "utf8") : "";

/**
 * Point WFC_GH at a route stub for the calls that follow. `open` is what the
 * search for an open probe issue finds; `isFiling` false refuses file-issue.js's
 * label read, so the filing fails; `isClosing` false leaves the close unrouted;
 * `states` answers `issue view <n>`'s state read for each issue it names. Any
 * other call answers logged out.
 */
const serve = ({
	open = [] as { number: number; title: string }[],
	isFiling = true,
	isClosing = true,
	states = {} as Record<number, string>,
} = {}) => {
	const routes = fs.mkdtempSync(path.join(dir, "gh-routes-"));
	const { gh } = stubGhRoutes(
		routes,
		{
			"issue list *": printed(JSON.stringify(open)),
			"repos/o/r/labels": isFiling
				? page("labelsPage", [
						{ name: "takes:triage" },
						{ name: "origin:incident" },
					])
				: readGhAnswer(LOGGED_OUT),
			"issue create *": printed(`https://github.com/o/r/issues/${ISSUE}\n`),
			...(isClosing ? { [`issue close ${ISSUE} *`]: printed("") } : {}),
			...Object.fromEntries(
				Object.entries(states).map(([n, state]) => [
					`issue view ${n} *`,
					printed(`${state}\n`),
				]),
			),
			"*": readGhAnswer(LOGGED_OUT),
		},
		{ log: ghLog(), bodies: at("bodies") },
	);
	vi.stubEnv("WFC_GH", gh);
};

/** One tick's holds over `served`, each settled and probed, at `now`, through
 * lib/guard-probe.js unless `probe` stands in for it. */
const tick = (
	now = NOW,
	served = [repo],
	probe?: Parameters<typeof tendHolds>[3]["probe"],
) => {
	const lines: string[] = [];
	const broken = tendHolds(served, served, now, {
		log: (l) => lines.push(l),
		probe,
	});
	return { broken, text: lines.join("\n") };
};

const status = (now = NOW, roots = [repo]) =>
	buildHoldLines(roots, now).join("\n");

const dotGit = (name: string) => path.join(repo, ".git", name);
const breakHead = () => fs.writeFileSync(dotGit("HEAD"), "junk\n");
const repairHead = () =>
	fs.writeFileSync(dotGit("HEAD"), "ref: refs/heads/main\n");
const store = () => holdsDir(repo);
const failOnLog = (line: string) => {
	throw new Error(line);
};

describe("a repo hold's clear check (#3857)", () => {
	const raise = (clearCheck: { command: string } | { issueClosed: number }) =>
		raiseHold(repo, {
			kind: "park",
			act: "repair main",
			issue: 12,
			clearCheck,
			session: null,
			now: NOW,
		});

	it("lifts at once where its check passes, with one line for its clear and no raise", () => {
		serve();
		raise({ command: "true" });

		const { text } = tick();

		expect(text.match(/repo hold cleared/g)).toHaveLength(1);
		expect(text).not.toContain("repo hold raised");
		expect(status()).toContain("none open");
	});

	it("stays while its issue is open and lifts once it is closed", () => {
		raise({ issueClosed: 12 });
		serve({ states: { 12: "OPEN" } });
		tick();
		expect(status()).toContain("repair main");

		serve({ states: { 12: "CLOSED" } });
		const { text } = tick();

		expect(text).toContain("passed issue #12 closed");
		expect(status()).toContain("none open");
	});

	it("stays, logged, where its issue will not read", () => {
		raise({ issueClosed: 13 });
		serve({ states: { 12: "CLOSED" } });

		const { text } = tick();

		expect(text).toContain("could not read #13:");
		expect(status()).toContain("repair main");
	});

	it("logs an unreadable store and reads it as no hold open", () => {
		serve();
		fs.writeFileSync(at("repo-holds"), "a file, not a directory\n");

		const { broken, text } = tick();

		expect(text).toContain("repo holds unread, read as not open this tick");
		expect(broken).toEqual([]);
		expect(readTickHolds([repo], broken).holds).toEqual([]);
	});

	it("keeps, logged, a hold whose clear check cannot start", () => {
		serve();
		const { id } = raise({ command: "true" });
		const file = path.join(store(), `${id}.json`);
		const record = JSON.parse(fs.readFileSync(file, "utf8"));
		record.clearCheck.command = "tr\0ue";
		fs.writeFileSync(file, JSON.stringify(record));

		const { broken, text } = tick();

		expect(text).toContain(`repo hold ${id}: clear check did not finish`);
		expect(broken).toEqual([]);
		expect(status()).toContain("repair main");
	});

	it.skipIf(process.getuid?.() === 0)(
		"leaves a hold whose lift throws to its own tick",
		() => {
			serve();
			const { id } = raise({ command: "true" });
			fs.chmodSync(store(), 0o555);
			try {
				const { broken, text } = tick();

				expect(text).toContain(`repo hold ${id}: not settled`);
				expect(broken).toEqual([]);
			} finally {
				fs.chmodSync(store(), 0o755);
			}
			expect(status()).toContain("repair main");
		},
	);

	it("reads a record whose id would leave the store as no hold", () => {
		serve();
		fs.writeFileSync(at("victim"), "kept\n");
		const { id } = raise({ command: "true" });
		const file = path.join(store(), `${id}.json`);
		const record = JSON.parse(fs.readFileSync(file, "utf8"));
		fs.writeFileSync(file, JSON.stringify({ ...record, id: "../../victim" }));

		const { text } = tick();

		expect(text).toContain("not a hold");
		expect(fs.existsSync(at("victim"))).toBe(true);
	});
});

describe("the probe hold (#3860)", () => {
	it("clears a hold raised by an unreadable main the tick after a session runs the repair script, with no hand lift (#3867)", () => {
		serve();
		const mainRef = dotGit("refs/heads/main");
		const tip = fs.readFileSync(mainRef, "utf8");
		fs.writeFileSync(mainRef, "");

		const broken = tick();

		expect(broken.text).toContain("repo hold raised: probe in");
		expect(broken.broken).toEqual([repo]);

		const repaired = runInProcess(
			path.join(__dirname, "..", "repair-main.js"),
			[],
			{
				cwd: repo,
				env: {
					...process.env,
					CLAUDE_PROJECT_DIR: repo,
					CLAUDE_CODE_SESSION_ID: "repairing-session",
				},
			},
		);
		expect(repaired.status, repaired.stderr).toBe(0);
		expect(fs.readFileSync(mainRef, "utf8")).toBe(tip);

		const cleared = tick(NOW + MIN);

		expect(cleared.text).toContain("repo hold cleared: probe in");
		expect(cleared.text).not.toContain("repo hold lifted");
		expect(cleared.broken).toEqual([]);
		expect(status(NOW + MIN)).toContain("holds:     none open");
	});

	describe("an outage (#3899)", () => {
		const OutageLine = "a hold rises at 15m";
		const setOriginUrl = (url: string) => {
			const config = dotGit("config");
			fs.writeFileSync(
				config,
				fs.readFileSync(config, "utf8").replace(/url = .*/, `url = ${url}`),
			);
		};
		const breakOrigin = () => setOriginUrl(at("gone"));
		const repairOrigin = () => setOriginUrl(path.join(repo, ".origin.git"));
		const outageFile = () => path.join(store(), "probe.outage");

		it("stops launches on each failing tick, raising no hold and filing no issue", () => {
			serve();
			breakOrigin();

			for (const now of [NOW, NOW + MIN]) {
				const { broken, text } = tick(now);

				expect(text).toContain(`probe failed in ${repo}: fetch origin:`);
				expect(text).toContain(OutageLine);
				expect(text).not.toContain("repo hold raised");
				expect(broken).toEqual([repo]);
			}
			expect(readFiled()).toHaveLength(0);
			expect(status(NOW + MIN)).toContain("holds:     none open");
		});

		it("reads a git that never answers the same way", () => {
			serve();
			vi.stubEnv("WFC_GIT", at("no-such-git"));

			const { broken, text } = tick();

			expect(text).toContain(`probe failed in ${repo}: fetch origin:`);
			expect(text).toContain(OutageLine);
			expect(text).not.toContain("repo hold raised");
			expect(broken).toEqual([repo]);
			expect(readFiled()).toHaveLength(0);
		});

		it("launches again the tick the fetch passes, with nothing filed", () => {
			serve();
			breakOrigin();
			tick();
			repairOrigin();

			const { broken, text } = tick(NOW + MIN);

			expect(text).not.toContain("probe failed");
			expect(broken).toEqual([]);
			expect(readFiled()).toHaveLength(0);
		});

		it("raises the hold and files its issue once it has lasted the window", () => {
			serve();
			breakOrigin();
			tick(NOW);
			tick(NOW + 10 * MIN);

			const { text } = tick(NOW + 15 * MIN);

			expect(text).toContain("repo hold raised: probe in");
			expect(readFiled()).toHaveLength(1);
			expect(status(NOW + 15 * MIN)).toContain("stops launches: yes");
		});

		it("begins anew after a fetch that passes", () => {
			serve();
			breakOrigin();
			tick(NOW);
			tick(NOW + 10 * MIN);
			repairOrigin();
			tick(NOW + 11 * MIN);
			breakOrigin();

			const { text } = tick(NOW + 16 * MIN);

			expect(text).toContain(OutageLine);
			expect(text).not.toContain("repo hold raised");
			expect(readFiled()).toHaveLength(0);
		});

		it("begins anew where no tick has seen the last one for the window", () => {
			serve();
			breakOrigin();
			tick(NOW);

			const { text } = tick(NOW + 16 * MIN);

			expect(text).toContain(OutageLine);
			expect(text).not.toContain("repo hold raised");
			expect(readFiled()).toHaveLength(0);
		});

		it("begins anew, logged, on a torn record", () => {
			serve();
			breakOrigin();
			tick(NOW);
			tick(NOW + 10 * MIN);
			fs.writeFileSync(outageFile(), "{ torn");

			const { text } = tick(NOW + 16 * MIN);

			expect(text).toContain("outage record torn, begun anew:");
			expect(text).toContain(OutageLine);
			expect(readFiled()).toHaveLength(0);
		});

		it("raises at once where a ref fails too", () => {
			serve();
			breakOrigin();
			fs.writeFileSync(dotGit("refs/heads/main"), "");

			const { text } = tick();

			expect(text).toContain("repo hold raised: probe in");
			expect(readFiled()).toHaveLength(1);
		});

		it("keeps a hold already open, then clears it the tick the fetch passes", () => {
			serve();
			const main = fs.readFileSync(dotGit("refs/heads/main"));
			breakOrigin();
			fs.writeFileSync(dotGit("refs/heads/main"), "");
			tick(NOW);
			fs.writeFileSync(dotGit("refs/heads/main"), main);

			tick(NOW + MIN);
			expect(status(NOW + MIN)).toContain("stops launches: yes");

			repairOrigin();
			const { text } = tick(NOW + 2 * MIN);
			expect(text).toContain("repo hold cleared: probe in");
		});
	});

	it.each<[string, () => void, string]>([
		[
			"resolve main: names no commit",
			() => fs.writeFileSync(dotGit("refs/heads/main"), ""),
			"",
		],
	])(
		"logs a failing probe's %s text and raises the hold",
		(text, breakIt, modules) => {
			serve();
			vi.stubEnv("WFC_MODULES", modules);
			breakIt();

			const ticked = tick();

			expect(ticked.text).toContain(`probe failed in ${repo}: `);
			expect(ticked.text).toContain(text);
			expect(ticked.broken).toEqual([repo]);
			expect(status()).toContain("stops launches: yes");
		},
	);

	it("holds only the failing one of two served checkouts", () => {
		serve();
		const other = at("other");
		probedCheckout.instantiate(other);
		writeConfig(other);
		breakHead();

		const { broken, text } = tick(NOW, [repo, other]);

		expect(text).toContain(`probe failed in ${repo}`);
		expect(text).not.toContain(`probe failed in ${other}`);
		expect(broken).toEqual([repo]);
		expect(
			readTickHolds([repo, other], broken).holds.map((h) => h.root),
		).not.toContain(other);
	});

	it("stands with no issue where the filing fails, logged, and files on a later tick", () => {
		serve({ isFiling: false });
		breakHead();

		const refused = tick();

		expect(refused.text).toContain(
			"issue not filed, the next tick retries: file-issue: could not read o/r's label list",
		);
		expect(readFiled()).toHaveLength(0);
		expect(status()).toMatch(/no issue filed yet.*stops launches: yes/);
		expect(refused.broken).toEqual([repo]);

		serve();
		const filed = tick(NOW + MIN);

		expect(filed.text).toContain(`repo hold probe in ${repo}: filed #${ISSUE}`);
		expect(readFiled()).toHaveLength(1);
		expect(status(NOW + MIN)).toContain(`issue #${ISSUE}`);
	});

	it("files nothing where it cannot tell whether an issue is already open", () => {
		const routes = at("gh-routes-out");
		fs.mkdirSync(routes);
		vi.stubEnv(
			"WFC_GH",
			stubGhRoutes(routes, { "*": readGhAnswer(LOGGED_OUT) }, { log: ghLog() })
				.gh,
		);
		breakHead();

		const { text } = tick();

		expect(text).toContain("could not look for an open one");
		expect(readFiled()).toHaveLength(0);
		expect(status()).toContain("no issue filed yet");
	});

	it("clears, logged, where its issue will not close", () => {
		serve();
		breakHead();
		tick();
		repairHead();
		serve({ isClosing: false });

		const { broken, text } = tick(NOW + MIN);

		expect(text).toContain("repo hold cleared: probe in");
		expect(text).toContain(`could not close #${ISSUE}:`);
		expect(broken).toEqual([]);
	});

	it("stops launches where the store takes no record, filing nothing", () => {
		serve();
		fs.writeFileSync(at("repo-holds"), "a file, not a directory\n");
		breakHead();

		const { broken, text } = tick();

		expect(text).toContain("repo holds unread, read as not open this tick");
		expect(text).toContain(`repo hold probe in ${repo}: not kept:`);
		expect(broken).toEqual([repo]);
		expect(readTickHolds([repo], broken).holds).toEqual([
			{ root: repo, kind: "probe", issue: null, raisedAt: null },
		]);
		expect(readFiled()).toHaveLength(0);
	});

	it("writes over a torn record of its hold, taking up its open issue", () => {
		serve();
		breakHead();
		tick();
		fs.writeFileSync(path.join(store(), "probe.json"), "{ torn");

		serve({ open: [{ number: ISSUE, title: PROBE_TITLE }] });
		const { text } = tick(NOW + MIN);

		expect(text).toContain(
			`repo hold probe in ${repo}: took up open #${ISSUE}`,
		);
		expect(status(NOW + MIN)).not.toContain("unread:");
		expect(status(NOW + MIN)).toContain("stops launches: yes");
		expect(status(NOW + MIN)).toContain(`issue #${ISSUE}`);
		expect(readFiled()).toHaveLength(1);
		expect(fs.readdirSync(store())).toEqual(["probe.json"]);
	});

	it("closes its issue on a hand lift, and a still-broken .git raises it anew", () => {
		serve();
		breakHead();
		tick();

		const lifted = liftHold(repo, "probe");

		expect(lifted).toContain("repo hold lifted by hand: probe in");
		expect(lifted).not.toContain("could not close");
		expect(
			readGhCalls().filter((l) => l.startsWith(`issue close ${ISSUE} `)),
		).toHaveLength(1);
		expect(status()).toContain("none open");

		tick(NOW + MIN);

		expect(status(NOW + MIN)).toContain("stops launches: yes");
		expect(readFiled()).toHaveLength(2);
	});

	it("reads a hold raised on a linked worktree with a broken .git once it is repaired (#4402)", () => {
		serve();
		const worktree = at("worktree");
		execFileSync("git", ["worktree", "add", "-q", worktree], { cwd: repo });
		const admin = path.join(repo, ".git", "worktrees", "worktree");
		const head = fs.readFileSync(path.join(admin, "HEAD"), "utf8");
		fs.writeFileSync(path.join(admin, "HEAD"), "junk\n");

		const raised = tick(NOW, [worktree]);
		expect(raised.text).toContain("repo hold raised: probe in");

		fs.writeFileSync(path.join(admin, "HEAD"), head);

		expect(readHolds(worktree).holds.map((h) => h.id)).toEqual(["probe"]);
	});

	it("reads a hold raised on a linked worktree whose .git file is garbage once it is repaired (#4718)", () => {
		serve();
		const worktree = at("worktree");
		execFileSync("git", ["worktree", "add", "-q", worktree], { cwd: repo });
		const gitFile = path.join(worktree, ".git");
		const text = fs.readFileSync(gitFile, "utf8");
		fs.writeFileSync(gitFile, "garbage\n");

		const raised = tick(NOW, [worktree]);
		expect(raised.text).toContain("repo hold raised: probe in");
		const broken = holdsDir(worktree);
		/* A session parked on it, as an attach leaves it (#3858). */
		fs.writeFileSync(path.join(broken, "probe.attached.job-a"), "");

		fs.writeFileSync(gitFile, text);

		const { holds } = readHolds(worktree);
		expect(holds.map((h) => [h.id, h.sessions])).toEqual([
			["probe", ["job-a"]],
		]);
		expect(fs.existsSync(broken)).toBe(false);
	});

	it("leaves a broken keying's hold where the repaired store holds its id, until that one lifts (#4718)", () => {
		serve();
		const worktree = at("worktree");
		execFileSync("git", ["worktree", "add", "-q", worktree], { cwd: repo });
		const gitFile = path.join(worktree, ".git");
		const text = fs.readFileSync(gitFile, "utf8");
		const raiseProbe = (root: string, act: string, now: number) =>
			raiseHold(root, {
				id: "probe",
				kind: "probe",
				act,
				issue: ISSUE,
				clearCheck: { probe: true },
				session: null,
				now,
			});
		raiseProbe(worktree, "before the break", NOW);
		fs.writeFileSync(gitFile, "garbage\n");
		raiseProbe(worktree, "while broken", NOW + MIN);
		const broken = holdsDir(worktree);
		fs.writeFileSync(path.join(broken, "probe.attached.job-a"), "");
		fs.writeFileSync(gitFile, text);

		expect(readHolds(worktree).holds.map((h) => [h.act, h.sessions])).toEqual([
			["before the break", ["job-a"]],
		]);
		expect(fs.readdirSync(broken)).toEqual(["probe.json"]);

		liftHold(worktree, "probe");

		expect(readHolds(worktree).holds.map((h) => h.act)).toEqual([
			"while broken",
		]);
		expect(fs.existsSync(broken)).toBe(false);
	});

	it("reports a broken keying's store it cannot adopt, and the tick runs on (#4718)", () => {
		serve();
		const worktree = at("worktree");
		execFileSync("git", ["worktree", "add", "-q", worktree], { cwd: repo });
		const gitFile = path.join(worktree, ".git");
		const text = fs.readFileSync(gitFile, "utf8");
		fs.writeFileSync(gitFile, "garbage\n");
		tick(NOW, [worktree]);
		const broken = holdsDir(worktree);
		fs.writeFileSync(gitFile, text);
		fs.chmodSync(broken, 0o000);
		try {
			const { text: logged } = tick(NOW + MIN, [worktree, repo]);

			expect(logged).toContain(`${broken}: `);
			expect(readHolds(worktree).unread).toEqual([
				expect.stringContaining("so repair the directory"),
			]);
		} finally {
			fs.chmodSync(broken, 0o755);
		}
		expect(readHolds(worktree).holds.map((h) => h.id)).toEqual(["probe"]);
	});

	describe("a guard entry that will not load (#4226), the probe's answer injected", () => {
		let failure: { text: string; isOutage: boolean } | null;
		let replayFailure: (command: unknown) => string | null;
		const probe = {
			readProbeFailure: () => failure,
			readReplayFailure: (_root: string, call: RefusedCall) =>
				replayFailure((call.tool_input as { command?: unknown })?.command),
		};
		const probeTick = (now = NOW) => tick(now, [repo], probe);
		const Loading = {
			text: "guard entry: Lexer is not defined",
			isOutage: false,
		};

		beforeEach(() => {
			failure = null;
			replayFailure = () => null;
		});

		it("raises on its first tick, with no outage window, and clears the tick the entry loads again, closing its issue once", () => {
			serve();
			failure = Loading;
			const raised = probeTick();
			expect(raised.broken).toEqual([repo]);
			expect(raised.text).toContain(
				`probe failed in ${repo}: guard entry: Lexer is not defined`,
			);
			expect(raised.text).not.toContain("a hold rises at");
			expect(raised.text).toContain("repo hold raised: probe in");
			expect(readFiled()).toHaveLength(1);
			expect(readBodies()).toContain("guard entry: Lexer is not defined");
			failure = null;

			const { broken, text } = probeTick(NOW + MIN);

			expect(text).toContain("repo hold cleared: probe in");
			expect(text).not.toContain("could not close");
			expect(
				readGhCalls().filter((l) => l.startsWith(`issue close ${ISSUE} `)),
			).toHaveLength(1);
			expect(broken).toEqual([]);
			expect(status(NOW + MIN)).toContain("holds:     none open");
		});

		describe("a locked-out session's hold (#4228)", () => {
			const Fault = `guard-x ${CORE_FAULT_TEXT}, and it fails closed: boom`;
			/* A kept `locked` call still fails, as a core the guard could not run
			 * refuses it; a `merits` call passes, refused only on its merits. */
			const StillLocked = `refused a replayed Bash: ${Fault}`;
			beforeEach(() => {
				replayFailure = (command) =>
					command === "locked" ? StillLocked : null;
			});
			const lockOut = (job: string, command: string) => {
				const lines: string[] = [];
				const held = holdLockedOut(
					repo,
					{
						job,
						refusal: Fault,
						call: { tool_name: "Bash", tool_input: { command } },
					},
					NOW,
					(l) => lines.push(l),
				);
				return { held, text: lines.join("\n") };
			};

			it("raises the probe hold with the refusal as its step, files its issue, and attaches each session to it", () => {
				serve();

				const first = lockOut("job7", "locked");
				const second = lockOut("job8", "locked");

				expect(first.text).toContain(
					`repo hold raised: probe in ${repo}: repair the guard code the hook line runs, as its refusal says: guard lockout: ${Fault}`,
				);
				expect(first.held).toMatchObject({
					hold: { id: "probe", issue: ISSUE },
				});
				expect(second.text).toMatch(/session job8; 2 attached$/);
				expect(readFiled()).toHaveLength(1);
				expect(readHolds(repo).holds[0]?.sessions).toEqual(["job7", "job8"]);
			});

			it("keeps the hold while a kept call still fails, though the probe passes", () => {
				serve();
				lockOut("job7", "locked");

				const { text } = probeTick(NOW + MIN);

				expect(text).toContain(
					`repo hold probe: a kept call still fails: ${StillLocked}`,
				);
				expect(text).not.toContain("repo hold cleared");
				expect(readHolds(repo).holds).toHaveLength(1);
			});

			it("keeps the hold on its kept call before its issue files, the session not yet attached", () => {
				serve({ isFiling: false });
				const first = lockOut("job7", "locked");
				expect(first.held).toEqual({
					why: "its probe hold has no issue filed yet",
				});

				const { text } = probeTick(NOW + MIN);

				expect(text).toContain("a kept call still fails");
				expect(readHolds(repo).holds).toHaveLength(1);
			});

			it("raises a fresh hold for a session locked out again after the lift", () => {
				serve();
				lockOut("job7", "merits");
				expect(probeTick(NOW + MIN).text).toContain("repo hold cleared");

				const again = lockOut("job7", "locked");

				expect(again.text).toContain("repo hold raised: probe in");
				expect(again.held).toMatchObject({ hold: { id: "probe" } });
				expect(readHolds(repo).holds[0]?.raisedAt).toBe(NOW);
			});

			it("lifts the hold where the kept call passes", () => {
				serve();
				lockOut("job7", "merits");

				const { text } = probeTick(NOW + MIN);

				expect(text).toContain("repo hold cleared: probe in");
			});
		});
	});

	describe("attachProbeParks (#4226)", () => {
		const launch = (jobId: string, since: number) => ({
			root: repo,
			issues: [7],
			prompt: "/implement 7",
			seat: at("seat"),
			jobId,
			sessionId: `s-${jobId}`,
			launchedAt: NOW - 10 * MIN,
			finishedAt: null,
			block: { since },
		});

		it("attaches each session there that has blocked since the hold rose, once", () => {
			serve();
			breakHead();
			const { broken } = tick();
			const launches = [launch("job7", NOW), launch("job6", NOW - MIN)];
			const lines: string[] = [];

			for (const _ of [1, 2])
				attachProbeParks(
					broken,
					launches as Parameters<typeof attachProbeParks>[1],
					(l) => lines.push(l),
				);

			expect(lines).toHaveLength(1);
			expect(lines[0]).toMatch(
				/^repo hold attached: probe in .*; session job7; 1 attached$/,
			);
			expect(readHolds(repo).holds[0]?.sessions).toEqual(["job7"]);
		});
	});
});

describe("a lifted hold's record (#3863)", () => {
	const raiseOn = (session: string, issue: number) =>
		raiseHold(repo, {
			kind: "park",
			act: "repair main",
			issue,
			clearCheck: { command: "false" },
			session,
			now: NOW,
		});

	it("drops a settled session from a record kept for its clear notice, so no later tick judges it again", () => {
		const hold = raiseOn("gonejob", ISSUE);
		writeNotice(path.join(store(), `${hold.id}.notice`), {
			raise: { at: NOW, tries: 1, outcome: "dispatched" },
			clear: null,
			isUnsetLogged: false,
		});
		serve();
		liftHold(repo, hold.id);
		const [lifted] = readLiftedHolds([repo], failOnLog);
		expect(lifted).toMatchObject({
			jobs: ["gonejob"],
			isClearNoticeOwed: true,
		});

		dropLiftedJobs(
			lifted as Parameters<typeof dropLiftedJobs>[0],
			["gonejob"],
			failOnLog,
		);

		expect(readLiftedHolds([repo], failOnLog)).toMatchObject([
			{ jobs: [], isClearNoticeOwed: true },
		]);
	});

	it("goes once a hand lift's sessions are all taken up and no clear is owed", () => {
		const hold = raiseOn("job8", 12);
		fs.writeFileSync(path.join(store(), `${hold.id}.attached.job9`), "");
		serve();
		liftHold(repo, hold.id);
		const [lifted] = readLiftedHolds([repo], failOnLog);
		expect(lifted?.jobs.sort()).toEqual(["job8", "job9"]);

		dropLiftedJobs(
			lifted as Parameters<typeof dropLiftedJobs>[0],
			["job8", "job9"],
			failOnLog,
		);

		expect(fs.readdirSync(path.join(store(), "lifted"))).toEqual([]);
	});
});

describe("a tick's store resolution (#4398)", () => {
	/* Through require, as lib/repo-hold-notices.js reaches it, so the tick's
	 * calls share one copy of the module and its tick scope. */
	const load = createRequire(__filename);
	const holds = load("./repo-holds.js");
	const { tendHoldNotices } = load("./repo-hold-notices.js");

	/** The `--git-common-dir` forks of every hold call a tick makes. */
	const countTickForks = (run: (calls: () => void) => void) => {
		serve();
		const other = at("other");
		probedCheckout.instantiate(other);
		writeConfig(other);
		const served = [repo, other];
		raiseHold(repo, {
			kind: "park",
			act: "repair main",
			issue: 12,
			clearCheck: { issueClosed: 12 },
			session: null,
			now: NOW,
		});
		const counter = writeFaultyGit(
			{ words: ["--git-common-dir"] },
			{ script: ":" },
			{ under: dir },
		);
		vi.stubEnv("WFC_GIT", counter.git);
		const lines: string[] = [];
		const log = (l: string) => lines.push(l);
		run(() => {
			const broken = holds.tendHolds(served, served, NOW, { log });
			holds.readTickHolds(served, broken);
			holds.attachProbeParks(broken, [], log);
			holds.readLiftedHolds(served, log);
			tendHoldNotices(served, { agents: null, isPaused: false }, NOW, log);
		});
		return counter.hits();
	};

	it("forks git for each served checkout's common dir once a tick", () => {
		expect(countTickForks((calls) => holds.withTickStores(calls))).toBe(2);
	});

	it("forks them anew on the next tick", () => {
		expect(
			countTickForks((calls) => {
				holds.withTickStores(calls);
				holds.withTickStores(calls);
			}),
		).toBe(4);
	});

	it("keeps nothing outside a tick, as the CLI's calls run", () => {
		expect(countTickForks((calls) => calls())).toBeGreaterThan(2);
	});

	it("asks git once a tick where it will not name the common dir, and again on the next, so a repair keys anew", () => {
		const counter = writeFaultyGit(
			{ words: ["--git-common-dir"] },
			{ exit: 128 },
			{ under: dir },
		);
		vi.stubEnv("WFC_GIT", counter.git);
		const twice = () => {
			holds.holdsDir(repo);
			holds.holdsDir(repo);
		};

		holds.withTickStores(twice);
		holds.withTickStores(twice);

		expect(counter.hits()).toBe(2);
	});
});
