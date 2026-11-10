// @vitest-environment node
/*
 * The contract lib/resume-io-fake.ts keeps with lib/resume-io.js (#4386,
 * §G7): each answer the fake serves, its failures included, and each fault it
 * throws, is the shape and verdict the real adapter gives in the situation the
 * answer names. Only the situation's own values — paths, ids, the text a
 * message carries — differ. The real side runs over real fs, git and the real
 * session-arbiter.js in a temp HOME, with `claude` stubbed at WFC_CLAUDE_BIN by
 * the port fakes its own contracts hold (auth-status, bg-resume, agents-stop),
 * so no case spends or touches a live seat.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	buildAgentsBranch,
	buildJobRow,
	buildStopBranch,
} from "./agents-stop-fake";
import { buildRmBranch } from "./bg-launch-fake";
import { parseResumed } from "./bg-resume.js";
import {
	buildRekeyedResponse,
	FAKE_COPY,
	type ResumeKind,
} from "./bg-resume-fake";
import { buildBgBranch, writeClaudeStub } from "./claude-stub";
import { ledgerPath } from "./dispatch-ledger.js";
import { writeHeadlessRun } from "./headless-runs-testkit";
import { jobDirPath, jobStatePath } from "./job-paths.js";
import { markersDir, PASS_MARKER_PREFIXES } from "./marker-root.js";
import { transcriptPath } from "./project-slug.js";
import { buildCheckoutEnv } from "./refill-repos.js";
import { buildResumeIo } from "./resume-io.js";
import {
	ALLOWANCE_USD,
	ANSWERS,
	COPY_SESSION,
	FAULTS,
	fakeResumeIo,
	JOB,
	KEY_VAR,
	SESSION,
} from "./resume-io-fake";
import { runInProcess } from "./run-in-process.js";
import { breakCanaryPath, buildLockoutRepo } from "./settings-lockout-testkit";

type ResumeIo = import("./refill-resume.js").ResumeIo;
type ChildRun = ReturnType<ResumeIo["runClaude"]>;

let dir: string;
let root: string;
let seat: string;
let target: string;
let bin: string;
const lines: string[] = [];

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "resume-io-"));
	root = path.join(dir, "repo");
	seat = path.join(dir, "seat");
	target = path.join(dir, "target");
	bin = path.join(dir, "claude");
	fs.mkdirSync(root);
	fs.mkdirSync(seat);
	fs.mkdirSync(target);
	vi.stubEnv("HOME", dir);
	vi.stubEnv("CLAUDE_CONFIG_DIR", seat);
	vi.stubEnv("CLAUDE_PROJECT_DIR", root);
	vi.stubEnv("CLAUDE_CODE_SESSION_ID", "");
	vi.stubEnv("WFC_CLAUDE_BIN", bin);
	vi.stubEnv("WFC_SECRETS_FILE", path.join(dir, "secrets.env"));
	vi.stubEnv("WFC_REFILL_DIR", path.join(dir, "refill"));
	vi.stubEnv("ANTHROPIC_API_KEY", undefined);
	lines.length = 0;
	writeClaudeStub(bin, []);
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

const io = () => buildResumeIo((line) => lines.push(line));
const seatEnv = (over: NodeJS.ProcessEnv = {}) => ({
	...process.env,
	CLAUDE_CONFIG_DIR: seat,
	...over,
});

const refill = () => path.join(dir, "refill");

/** A headless resume of SESSION on KEY_VAR, the seat file declaring the
 * seat's dir both a plan seat and that key's overflow seat. The stub's
 * `claude -p` exits at once. */
function resumeHeadless() {
	fs.mkdirSync(path.join(dir, ".claude"), { recursive: true });
	fs.writeFileSync(
		path.join(dir, ".claude", "refill-seats"),
		`${seat}\n${seat} api key=${KEY_VAR} grant=200 cycle-day=20\n`,
	);
	return io().launchHeadless({
		keyVar: KEY_VAR,
		cwd: root,
		prompt: "carry on",
		resume: SESSION,
	});
}

/** The stub's `--bg` launch answering `kind`, run through the adapter. */
function launchAs(kind: ResumeKind | null) {
	const r = kind ? buildRekeyedResponse(kind, JOB, FAKE_COPY) : null;
	const out = path.join(dir, "bg-out");
	const err = path.join(dir, "bg-err");
	fs.writeFileSync(out, r ? r.stdout : "no job named\n");
	fs.writeFileSync(err, r ? r.stderr : "");
	writeClaudeStub(bin, [buildBgBranch({ out, err })]);
	return io().runClaude(["--bg", "--resume", SESSION, "carry on"], {
		cwd: root,
		env: seatEnv(),
	});
}

/** Job `jobId`'s state.json on the seat, as `record`. */
function writeJobRecord(jobId: string, record: unknown) {
	fs.mkdirSync(jobDirPath(seat, jobId), { recursive: true });
	fs.writeFileSync(jobStatePath(seat, jobId), JSON.stringify(record));
}

const writeTranscript = (onSeat: string) => {
	const file = transcriptPath(onSeat, root, SESSION);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, "");
	return file;
};

/** SESSION's name read from a transcript whose latest title is `name`. */
const namedSession = (name: string) => {
	const file = writeTranscript(seat);
	const title = (customTitle: string) =>
		`${JSON.stringify({ type: "custom-title", customTitle, sessionId: SESSION })}\n`;
	fs.writeFileSync(file, title("first") + title(name));
	return io().sessionName(file);
};

/** A pass marker of SESSION's, and a listing showing SESSION in `state`. */
function holdPassMarker(state: string) {
	fs.writeFileSync(
		path.join(markersDir(root), `${PASS_MARKER_PREFIXES[0]}${SESSION}`),
		"x\n",
	);
	writeClaudeStub(bin, [
		buildAgentsBranch([
			buildJobRow(JOB, state, { sessionId: SESSION }),
			buildJobRow("copy", "working"),
		]),
	]);
	return io().movePassMarkers(root, SESSION, COPY_SESSION);
}

const recordFirstLaunch = () =>
	io().recordLaunch({
		issues: [7],
		model: "opus",
		prompt: "/implement 7",
		root,
		jobId: JOB,
		overflow: {
			keyVar: KEY_VAR,
			allowanceUsd: ALLOWANCE_USD,
			sessionId: SESSION,
		},
	});

const childShape = (v: unknown) => {
	const r = v as ChildRun;
	return {
		keys: Object.keys(r).sort(),
		status: r.status,
		failed: r.failed,
		error: r.error ?? null,
		out: r.out === `${r.stdout}${r.stderr}`.trim(),
	};
};

/** A failure message's type and the errno it names. */
const errnoOf = (v: unknown) =>
	v === null
		? null
		: { type: typeof v, errno: /: (E[A-Z]+)\b/.exec(String(v))?.[1] };

/** What `act` threw, as its type and errno, or that it threw nothing. */
function thrownBy(act: () => unknown) {
	try {
		act();
		return "threw nothing";
	} catch (e) {
		return { error: e instanceof Error, ...errnoOf((e as Error).message) };
	}
}

function thrownMessage(act: () => unknown) {
	try {
		act();
		return "threw nothing";
	} catch (e) {
		return (e as Error).message;
	}
}

/* Named for the test selector (§X10): moveIssueClaim runs it. */
const ARBITER = path.resolve(__dirname, "../session-arbiter.js");

/** An answer less its situation's values, keyed by port. */
const SHAPES: Record<string, (v: unknown) => unknown> = {
	launchHeadless: (v) => {
		const r = v as ReturnType<ResumeIo["launchHeadless"]>;
		return "why" in r
			? { why: typeof r.why }
			: {
					keys: Object.keys(r.record).sort(),
					sessionId: r.record.sessionId === SESSION,
				};
	},
	readRunAsJob: (v) => {
		const r = v as ReturnType<ResumeIo["readRunAsJob"]>;
		return (
			r && { keys: Object.keys(r).sort(), state: r.state, cwd: typeof r.cwd }
		);
	},
	findHeadlessRun: (v) => {
		const r = v as ReturnType<ResumeIo["findHeadlessRun"]>;
		return r && { jobId: typeof r.jobId, sessionId: r.sessionId === SESSION };
	},
	authRefusal: (v) => (v === null ? null : typeof v),
	settingsLockout: (v) =>
		v === null
			? null
			: (v as string).includes("would refuse or stall every tool call"),
	runClaude: (v) => ({
		...childShape(v),
		resumed: parseResumed(v as ChildRun)?.copy ?? null,
	}),
	readJobRecord: (v) => {
		const r = v as { state: string; sessionId: unknown } | null;
		return r && { state: r.state, sessionId: typeof r.sessionId };
	},
	findResumed: (v) => v,
	copyTranscript: errnoOf,
	hasJobRecord: (v) => v,
	carryJobFiles: (v) => {
		const r = v as ReturnType<ResumeIo["carryJobFiles"]>;
		return "why" in r
			? {
					errno: r.why.match(
						/^carrying \S+ out of its job directory failed: ([A-Z]+):/,
					)?.[1],
				}
			: r.carried.map((c) => ({
					from: path.basename(c.from),
					to: c.to.split(`${path.sep}.claude${path.sep}`)[1],
				}));
	},
	writeJobName: errnoOf,
	stop: (v) => {
		const r = v as ReturnType<ResumeIo["stop"]>;
		return {
			keys: Object.keys(r).sort(),
			ok: r.ok,
			said: typeof r.said,
			...(r.ok
				? {}
				: {
						why: typeof r.why,
						noJob: r.noJob,
						timedOut: r.timedOut,
					}),
		};
	},
	overflowLookup: (v) => {
		const lookup = v as ReturnType<ResumeIo["overflowLookup"]>;
		return [{ jobId: FAKE_COPY }, { sessionId: SESSION }].map((q) => {
			const l = lookup(q);
			return (
				l && {
					keys: Object.keys(l).sort(),
					allowanceUsd: typeof l.allowanceUsd,
					sessionId: l.sessionId === SESSION,
				}
			);
		});
	},
	recordLaunch: (v) => v,
	copySpendUsd: (v) => v,
	sessionSpendUsd: (v) => v,
	sessionName: (v) => {
		const r = v as ReturnType<ResumeIo["sessionName"]>;
		return "why" in r ? { why: typeof r.why } : r;
	},
	moveIssueClaim: (v) => ({
		...childShape(v),
		moved: (v as ChildRun).out.startsWith("Moved"),
	}),
	movePassMarkers: (v) =>
		v === null ? null : (v as string).replace(/^\S+ /, ""),
	moveParkedBy: (v) => v,
};

const SITUATIONS: Record<string, Record<string, () => unknown>> = {
	launchHeadless: {
		launched: () => {
			fs.writeFileSync(
				process.env.WFC_SECRETS_FILE as string,
				`${KEY_VAR}=sk-test\n`,
				{ mode: 0o600 },
			);
			return resumeHeadless();
		},
		unreadable: () => resumeHeadless(),
	},
	readRunAsJob: {
		none: () => io().readRunAsJob("0e0e0e0e"),
		working: () => {
			writeHeadlessRun(refill(), "0e0e0e0e", SESSION, {
				log: path.join(dir, "out.jsonl"),
			});
			return io().readRunAsJob("0e0e0e0e");
		},
	},
	findHeadlessRun: {
		none: () => io().findHeadlessRun(SESSION, 0),
		found: () => {
			writeHeadlessRun(refill(), "0e0e0e0e", SESSION, {
				live: false,
				launchedAt: 2000,
			});
			return io().findHeadlessRun(SESSION, 1000);
		},
	},
	settingsLockout: {
		admitted: () =>
			io().settingsLockout(
				buildLockoutRepo(dir).cutWorktree("edited", (text) =>
					text.replace(/"timeout": \d+/, '"timeout": 20'),
				),
			),
		lockedOut: () =>
			io().settingsLockout(
				buildLockoutRepo(dir).cutWorktree("broken", breakCanaryPath),
			),
	},
	authRefusal: {
		admitted: () => io().authRefusal({ env: seatEnv(), cwd: root }),
		refused: () =>
			io().authRefusal({ env: seatEnv({ ANTHROPIC_API_KEY: "k" }), cwd: root }),
	},
	runClaude: {
		copy: () => launchAs("copy"),
		woke: () => launchAs("woke"),
		continued: () => launchAs("continued"),
		ownId: () => launchAs("ownId"),
		removed: () => {
			writeClaudeStub(bin, [buildRmBranch()]);
			return io().runClaude(["rm", JOB], { cwd: root, env: seatEnv() });
		},
		noJob: () => launchAs(null),
	},
	readJobRecord: {
		copyWorking: () => {
			writeJobRecord(FAKE_COPY, { state: "working", sessionId: COPY_SESSION });
			return io().readJobRecord(seat, FAKE_COPY);
		},
		working: () => {
			writeJobRecord(JOB, { state: "working", sessionId: SESSION });
			return io().readJobRecord(seat, JOB);
		},
		saved: () => {
			writeJobRecord(JOB, {
				state: "working",
				sessionId: SESSION,
				respawnFlags: ["--model", "opus"],
			});
			return io().readJobRecord(seat, JOB);
		},
		stopped: () => {
			writeJobRecord(JOB, { state: "stopped", sessionId: SESSION });
			return io().readJobRecord(seat, JOB);
		},
		otherSession: () => {
			writeJobRecord(JOB, { state: "working", sessionId: "s-other" });
			return io().readJobRecord(seat, JOB);
		},
		unread: () => io().readJobRecord(seat, JOB),
	},
	findResumed: {
		none: () => {
			writeTranscript(seat);
			fs.mkdirSync(path.join(seat, "jobs"));
			return io().findResumed(seat, { sessionId: SESSION, cwd: root }, 0, []);
		},
	},
	copyTranscript: {
		copied: () => {
			writeTranscript(seat);
			return io().copyTranscript({
				from: seat,
				to: target,
				sessionId: SESSION,
				cwd: root,
			});
		},
		uncopied: () => {
			writeTranscript(seat);
			fs.mkdirSync(transcriptPath(target, root, SESSION), { recursive: true });
			return io().copyTranscript({
				from: seat,
				to: target,
				sessionId: SESSION,
				cwd: root,
			});
		},
	},
	carryJobFiles: {
		none: () => io().carryJobFiles(seat, JOB, root),
		carried: () => {
			const pasted = (name: string) => {
				const file = path.join(jobDirPath(seat, JOB), "tmp", name);
				fs.mkdirSync(path.dirname(file), { recursive: true });
				fs.writeFileSync(file, "png");
				return file;
			};
			const first = pasted("pasted-1.png");
			const later = pasted("pasted-2.png");
			writeJobRecord(JOB, {
				sessionId: SESSION,
				cwd: root,
				intent: `look at ${first}`,
			});
			const turn = { type: "user", message: { content: `and ${later}` } };
			fs.writeFileSync(writeTranscript(seat), `${JSON.stringify(turn)}\n`);
			return io().carryJobFiles(seat, JOB, root);
		},
		uncopyable: () => {
			const shots = path.join(jobDirPath(seat, JOB), "tmp", "shots");
			fs.mkdirSync(shots, { recursive: true });
			writeJobRecord(JOB, { sessionId: SESSION, intent: `look at ${shots}` });
			return io().carryJobFiles(seat, JOB, root);
		},
	},
	hasJobRecord: {
		none: () => io().hasJobRecord(seat, JOB),
		present: () => {
			writeJobRecord(JOB, {});
			return io().hasJobRecord(seat, JOB);
		},
	},
	writeJobName: {
		written: () => {
			writeJobRecord(JOB, { state: "working", sessionId: SESSION });
			return io().writeJobName(seat, JOB, "Implement 7: a title");
		},
		unwritable: () => io().writeJobName(seat, JOB, "Implement 7: a title"),
	},
	stop: {
		stopped: () => {
			writeClaudeStub(bin, [buildStopBranch(path.join(dir, "calls"))]);
			return io().stop(seat, JOB);
		},
		noJob: () => {
			writeClaudeStub(bin, [buildStopBranch(path.join(dir, "calls"), "noJob")]);
			return io().stop(seat, JOB);
		},
		busy: () => {
			writeClaudeStub(bin, [buildStopBranch(path.join(dir, "calls"), "busy")]);
			return io().stop(seat, JOB);
		},
	},
	overflowLookup: {
		none: () => io().overflowLookup(root),
		launched: () => {
			recordFirstLaunch();
			return io().overflowLookup(root);
		},
	},
	recordLaunch: {
		written: recordFirstLaunch,
		unwritable: () => {
			fs.mkdirSync(ledgerPath(root), { recursive: true });
			return recordFirstLaunch();
		},
	},
	copySpendUsd: {
		none: () => io().copySpendUsd(transcriptPath(seat, root, SESSION)),
	},
	sessionSpendUsd: {
		none: () => io().sessionSpendUsd(transcriptPath(seat, root, SESSION)),
	},
	sessionName: {
		unnamed: () => io().sessionName(writeTranscript(seat)),
		named: () => namedSession("Implement 7: a title"),
		unreadable: () => {
			fs.mkdirSync(transcriptPath(seat, root, SESSION), { recursive: true });
			return io().sessionName(transcriptPath(seat, root, SESSION));
		},
	},
	moveIssueClaim: {
		moved: () => {
			expect(fs.existsSync(ARBITER)).toBe(true);
			const claimed = runInProcess(ARBITER, ["claim-issue", "7"], {
				cwd: root,
				env: { ...buildCheckoutEnv(root), CLAUDE_CODE_SESSION_ID: SESSION },
			});
			expect(claimed.status).toBe(0);
			return io().moveIssueClaim(root, 7, SESSION, COPY_SESSION);
		},
	},
	movePassMarkers: {
		moved: () => {
			const left = holdPassMarker("done");
			expect(
				fs.existsSync(
					path.join(
						markersDir(root),
						`${PASS_MARKER_PREFIXES[0]}${COPY_SESSION}`,
					),
				),
			).toBe(true);
			return left;
		},
		live: () => holdPassMarker("working"),
	},
	moveParkedBy: {
		moved: () =>
			io().moveParkedBy(SESSION, [7], {
				root,
				copySessionId: COPY_SESSION,
				job: { seat, jobId: FAKE_COPY, cwd: root },
			}),
	},
};

const FAULT_SITUATIONS: Record<string, Record<string, () => unknown>> = {
	overflowLookup: {
		unreadable: () => {
			fs.mkdirSync(ledgerPath(root), { recursive: true });
			return io().overflowLookup(root);
		},
	},
	readRunAsJob: {
		unreadable: () => {
			fs.mkdirSync(
				path.join(refill(), ".headless-runs", "0e0e0e0e", "run.json"),
				{
					recursive: true,
				},
			);
			return io().readRunAsJob("0e0e0e0e");
		},
		logUnreadable: () => {
			const log = path.join(dir, "out.jsonl");
			fs.mkdirSync(log);
			writeHeadlessRun(refill(), "0e0e0e0e", SESSION, { log });
			return io().readRunAsJob("0e0e0e0e");
		},
	},
};

const FAULT_CASES = Object.entries(FAULT_SITUATIONS).flatMap(([port, faults]) =>
	Object.keys(faults).map((fault) => [port, fault] as const),
);

const CASES = Object.entries(SITUATIONS).flatMap(([port, answers]) =>
	Object.keys(answers).map((answer) => [port, answer] as const),
);

describe("the fake answers as the adapter does", () => {
	it("names a situation for every answer it serves", () => {
		const names = (t: Record<string, object>) =>
			Object.fromEntries(
				Object.entries(t).map(([p, a]) => [p, Object.keys(a)]),
			);
		expect(names(SITUATIONS)).toEqual(names(ANSWERS));
		expect(names(FAULT_SITUATIONS)).toEqual(names(FAULTS));
	});

	it.each(CASES)(
		"the %s port's %s answer matches the adapter's",
		(port, answer) => {
			const shape = SHAPES[port] as (v: unknown) => unknown;
			const real = (SITUATIONS[port] as Record<string, () => unknown>)[
				answer
			]?.();
			const faked = (ANSWERS as Record<string, Record<string, unknown>>)[
				port
			]?.[answer];
			expect(shape(real)).toEqual(shape(faked));
		},
	);

	it("names the run's log where that is what will not read", () => {
		expect(
			thrownMessage(
				FAULT_SITUATIONS.readRunAsJob?.logUnreadable as () => unknown,
			),
		).toMatch(/^its log .*out\.jsonl: EISDIR/);
	});

	it.each(FAULT_CASES)(
		"the %s port's %s fault is thrown as the adapter throws it",
		(port, fault) => {
			const real = (FAULT_SITUATIONS[port] as Record<string, () => unknown>)[
				fault
			] as () => unknown;
			const faked = fakeResumeIo({ [port]: fault }).io[
				port as keyof ResumeIo
			] as () => unknown;
			expect(thrownBy(real)).toEqual(thrownBy(faked));
		},
	);
});
