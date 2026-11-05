// @vitest-environment node
/*
 * The contract lib/resume-io-fake.ts keeps with lib/resume-io.js (#4386,
 * §G7): each answer the fake serves, its failures included, and each fault it
 * throws, is the shape and verdict the real adapter gives in the situation the
 * answer names. Only the situation's
 * own values — paths, ids, the text a message carries — differ. The real side
 * runs over real fs, git and the real session-arbiter.js in a temp HOME, with
 * `claude` stubbed at WFC_CLAUDE_BIN by the port fakes its own contracts hold
 * (auth-status, bg-resume, agents-stop), so no case spends or touches a live
 * seat. Let the fake drift and refill-resume.test.ts's cases pass on answers
 * production never gives.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	buildAgentsBranch,
	buildJobRow,
	buildStopBranch,
} from "./agents-stop-fake";
import { parseResumed } from "./bg-resume.js";
import {
	buildRekeyedResponse,
	FAKE_COPY,
	type ResumeKind,
} from "./bg-resume-fake";
import { writeClaudeStub } from "./claude-stub";
import { ledgerPath } from "./dispatch-ledger.js";
import { jobDirPath, jobStatePath } from "./job-paths.js";
import { markersDir, PASS_MARKER_PREFIXES } from "./marker-root.js";
import { transcriptPath } from "./project-slug.js";
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
import { shellQuote } from "./sh-quote.js";

type ResumeIo = import("./refill-resume.js").ResumeIo;
type ChildRun = ReturnType<ResumeIo["runClaude"]>;

const savedEnv = { ...process.env };
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
	Object.assign(process.env, {
		HOME: dir,
		CLAUDE_CONFIG_DIR: seat,
		CLAUDE_PROJECT_DIR: root,
		CLAUDE_CODE_SESSION_ID: "",
		WFC_CLAUDE_BIN: bin,
		WFC_SECRETS_FILE: path.join(dir, "secrets.env"),
	});
	delete process.env.ANTHROPIC_API_KEY;
	lines.length = 0;
	writeClaudeStub(bin, []);
});

afterEach(() => {
	process.env = { ...savedEnv };
	fs.rmSync(dir, { recursive: true, force: true });
});

const io = () => buildResumeIo((line) => lines.push(line));
const seatEnv = (over: NodeJS.ProcessEnv = {}) => ({
	...process.env,
	CLAUDE_CONFIG_DIR: seat,
	...over,
});

/** The stub's `--bg` launch answering `kind`, run through the adapter. */
function launchAs(kind: ResumeKind | null) {
	const r = kind ? buildRekeyedResponse(kind, JOB, FAKE_COPY) : null;
	const out = path.join(dir, "bg-out");
	const err = path.join(dir, "bg-err");
	fs.writeFileSync(out, r ? r.stdout : "no job named\n");
	fs.writeFileSync(err, r ? r.stderr : "");
	writeClaudeStub(bin, [
		`if [ "$1" = "--bg" ]; then cat ${shellQuote(out)}; cat ${shellQuote(err)} >&2; exit 0; fi`,
	]);
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

/* The arbiter runArbiter crosses for real, named so a change to it selects
 * this file (§X10). */
const ARBITER = path.resolve(__dirname, "../session-arbiter.js");

/** An answer less its situation's values, keyed by port. */
const SHAPES: Record<string, (v: unknown) => unknown> = {
	keySettings: (v) => {
		const r = v as { settings: string } | { why: string };
		return "why" in r
			? { why: typeof r.why }
			: { settings: Object.keys(JSON.parse(r.settings)) };
	},
	authRefusal: (v) => (v === null ? null : typeof v),
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
	runArbiter: (v) => ({
		...childShape(v),
		released: (v as ChildRun).out.startsWith("Released"),
	}),
	movePassMarkers: (v) =>
		v === null ? null : (v as string).replace(/^\S+ /, ""),
	moveParkedBy: (v) => v,
};

const SITUATIONS: Record<string, Record<string, () => unknown>> = {
	keySettings: {
		settings: () => {
			fs.writeFileSync(
				process.env.WFC_SECRETS_FILE as string,
				`${KEY_VAR}=sk-test\n`,
				{
					mode: 0o600,
				},
			);
			return io().keySettings(KEY_VAR);
		},
		unreadable: () => io().keySettings(KEY_VAR),
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
	hasJobRecord: {
		none: () => io().hasJobRecord(seat, JOB),
		present: () => {
			writeJobRecord(JOB, {});
			return io().hasJobRecord(seat, JOB);
		},
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
	runArbiter: {
		released: () => {
			expect(fs.existsSync(ARBITER)).toBe(true);
			const real = io();
			expect(
				real.runArbiter(root, "claim-issue", 7, SESSION).failed,
			).toBeNull();
			return real.runArbiter(root, "release-issue", 7, SESSION);
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

/* What the real adapter throws in each situation a fault names. */
const FAULT_SITUATIONS: Record<string, Record<string, () => unknown>> = {
	overflowLookup: {
		unreadable: () => {
			fs.mkdirSync(ledgerPath(root), { recursive: true });
			return io().overflowLookup(root);
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
