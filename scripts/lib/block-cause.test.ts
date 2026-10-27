// @vitest-environment node
/*
 * The block-cause classifier (#2699, rules from #2358 F9), one case per rule.
 * Each fixture is a real record's shape: the permission prompt from #2699's
 * live reading (job bd329336, 2.1.309), the model-text question from its
 * scratch job 926a9e02, the transcript rows from #2358's census, and the
 * dialog park from #3252's probe 85411fa1 and 2.1.311's dialog table.
 *
 * The resumed-idle fixtures are Implement 2636's and Implement 2634's
 * transcript tails (#2659) and a harness API retry's.
 *
 * Loosen one and the loop stops a session on a guess, or leaves a
 * permission prompt holding its slot all night, or resumes a session the
 * harness is still retrying.
 */
import { describe, expect, it } from "vitest";
import { blockCause, resumedIdleSince } from "./block-cause.js";

const row = (over: Record<string, unknown> = {}) => ({
	pid: 2_339_100,
	id: "bd329336",
	kind: "background",
	sessionId: "bd329336-98e9-4bb4-a9b8-05f9be3ce018",
	status: "idle",
	state: "blocked",
	...over,
});

const job = (over: Record<string, unknown> = {}) => ({
	state: "blocked",
	detail: "settings.json edit rejected: validator disallows `foo` key",
	tempo: "blocked",
	inFlight: { tasks: 0, queued: 0, kinds: [], drainableMonitors: 0 },
	needs: "Tell me which key to use instead of foo",
	cliVersion: "2.1.309",
	...over,
});

const toolUse = (name: string) => ({
	type: "assistant",
	isSidechain: false,
	message: { content: [{ type: "tool_use", id: "toolu_1", name }] },
});
const toolResult = {
	type: "user",
	isSidechain: false,
	message: { content: [{ type: "tool_result", tool_use_id: "toolu_1" }] },
};
const apiErrorRow = (error: string, text: string) => ({
	type: "assistant",
	isSidechain: false,
	isApiErrorMessage: true,
	error,
	message: { content: [{ type: "text", text }] },
});

const tail = [toolUse("Read"), toolResult];

const cause = (r: unknown, j: unknown, t: unknown = tail) =>
	blockCause({ row: r, job: j, tail: t });

describe("a permission prompt", () => {
	it("reads off the listing's waitingFor (rule 1)", () => {
		for (const waitingFor of [
			"permission prompt",
			"sandbox request",
			"worker request",
		])
			expect(cause(row({ status: "waiting", waitingFor }), job())).toEqual({
				cause: "PERMISSION",
			});
	});

	it("reads off the job record's approve needs, as 2.1.309 writes it (rule 2)", () => {
		const live = job({
			state: "working",
			detail: "Reading .claude/settings.json",
			needs:
				"approve Update: /home/lucmo/workflow-core/.claude/tmp/permcheck-3011bcba/.claude/settings.json",
		});
		expect(cause(row(), live)).toEqual({ cause: "PERMISSION" });
	});

	it("never reads a model's approve-shaped ask as a prompt", () => {
		expect(
			cause(row(), job({ needs: "approve Deploy: the release?" })),
		).toEqual({ cause: "QUESTION" });
	});

	it("reads off a transcript tool_use with no result and no task in flight (rule 3)", () => {
		expect(cause(row(), job(), [...tail, toolUse("Edit")])).toEqual({
			cause: "PERMISSION",
		});
		const busy = job({
			inFlight: { tasks: 1, queued: 0, kinds: [], drainableMonitors: 0 },
		});
		expect(cause(row(), busy, [...tail, toolUse("Edit")])).toEqual({
			cause: "QUESTION",
		});
	});

	it("wins over a stale question's needs", () => {
		const stale = job({ block: { questions: [{ question: "Which?" }] } });
		expect(
			cause(row({ status: "waiting", waitingFor: "permission prompt" }), stale),
		).toEqual({ cause: "PERMISSION" });
	});
});

describe("a question the harness poses (rule 4)", () => {
	it("reads input needed, an AskUserQuestion block or a plan approval", () => {
		expect(
			cause(row({ status: "waiting", waitingFor: "input needed" }), job()),
		).toEqual({ cause: "QUESTION" });
		expect(
			cause(row(), job({ block: { questions: [{ question: "Which?" }] } })),
		).toEqual({ cause: "QUESTION" });
		expect(
			cause(row(), job({ state: "working", needs: "approve plan" })),
		).toEqual({ cause: "QUESTION" });
	});
});

describe("a seat or plan limit (rule 5)", () => {
	it("reads off the detail, the needs or the transcript's rate_limit row", () => {
		expect(
			cause(row(), job({ detail: "You've reached your Fable limit" })),
		).toEqual({ cause: "LIMIT" });
		expect(
			cause(row(), job({ needs: "usage limit reached — check plan" })),
		).toEqual({ cause: "LIMIT" });
		expect(
			cause(row(), job({ detail: null, needs: null }), [
				apiErrorRow(
					"rate_limit",
					"You've hit your session limit · resets 7:40pm (Asia/Singapore)",
				),
			]),
		).toEqual({ cause: "LIMIT" });
	});
});

describe("an API error", () => {
	it("reads auth off the detail, the needs or the error (rule 6)", () => {
		const auth = { cause: "API_ERROR", sub: "auth" };
		expect(cause(row(), job({ detail: "Login expired · Run /login" }))).toEqual(
			auth,
		);
		expect(cause(row(), job({ needs: "login required — run /login" }))).toEqual(
			auth,
		);
		expect(
			cause(row(), job({ detail: null, needs: null }), [
				apiErrorRow("authentication_failed", "Please run /login"),
			]),
		).toEqual(auth);
	});

	it("reads transient off an API Error detail or a server_error row (rule 7)", () => {
		const transient = { cause: "API_ERROR", sub: "transient" };
		expect(cause(row(), job({ detail: "API Error: 529 Overloaded" }))).toEqual(
			transient,
		);
		expect(cause(row(), job({ needs: "API unavailable — retry" }))).toEqual(
			transient,
		);
		expect(
			cause(row(), job({ detail: null, needs: null }), [
				apiErrorRow("server_error", "API Error: 500 Internal server error"),
			]),
		).toEqual(transient);
	});

	it("reads invalid_request off its needs or error (rule 7)", () => {
		const invalid = { cause: "API_ERROR", sub: "invalid_request" };
		expect(
			cause(row(), job({ needs: "request too large — /compact or trim" })),
		).toEqual(invalid);
		expect(
			cause(row(), job({ detail: null, needs: null }), [
				apiErrorRow(
					"invalid_request",
					"API Error: this message was flagged by the safeguards",
				),
			]),
		).toEqual(invalid);
	});
});

describe("another dialog (rule 8)", () => {
	it("reads dialog open", () => {
		expect(
			cause(
				row({ status: "waiting", waitingFor: "dialog open" }),
				job({ tempo: "idle" }),
			),
		).toEqual({ cause: "OTHER_DIALOG" });
	});

	it("reads a parked row off the job record's dialog needs (#3252)", () => {
		const parked = row({ status: undefined, pid: undefined });
		for (const needs of [
			"acknowledge the classifier billing notice (Enter continues in auto mode)",
			"choose: run ultraplan in the cloud",
			"choose: make auto mode the default permission mode",
			"choose: retry on fallback model or edit prompt",
			"review: managed settings change",
		])
			expect(cause(parked, job({ needs, cliVersion: "2.1.311" }))).toEqual({
				cause: "OTHER_DIALOG",
			});
	});

	it("reads a startup-dialog park UNKNOWN before its first turn and OTHER_DIALOG after (#3252)", () => {
		/* `claude --bg "/config"` on 2.1.311, its process killed while the
		 * dialog was open: the listing row after, and the job record the
		 * startup watchdog wrote. No turn ran, so no transcript was written;
		 * a resumed session's record keeps its cliVersion and has one. */
		const parked = {
			id: "85411fa1",
			cwd: "/home/lucmo/workflow-core",
			kind: "background",
			startedAt: 1_793_106_348_817,
			sessionId: "85411fa1-9e11-49f3-b91d-043f8abf5490",
			name: "Probe 3252 config dialog",
			state: "blocked",
		};
		const wedged = {
			state: "working",
			detail: "stuck on a startup dialog",
			tempo: "blocked",
			needs: "open this session to continue setup",
		};
		expect(cause(parked, wedged, null)).toEqual({
			cause: "UNKNOWN",
			why: "no transcript",
		});
		expect(cause(parked, wedged, [])).toEqual({
			cause: "UNKNOWN",
			why: "cliVersion undefined is below 2.1.293",
		});
		expect(
			cause(parked, job({ ...wedged, cliVersion: "2.1.311" }), tail),
		).toEqual({ cause: "OTHER_DIALOG" });
	});
});

describe("a question in the model's words (rule 9)", () => {
	it("reads a blocked tempo no other rule claims, as job 926a9e02 ended", () => {
		expect(cause(row(), job())).toEqual({ cause: "QUESTION" });
	});
});

describe("anything it cannot read is UNKNOWN (rules 0 and 10)", () => {
	const unknown = (r: unknown, j: unknown, t: unknown = tail) =>
		cause(r, j, t).cause;

	it("reads UNKNOWN where a record would not read", () => {
		expect(unknown(null, job())).toBe("UNKNOWN");
		expect(unknown(row(), null)).toBe("UNKNOWN");
		expect(unknown(row(), job(), null)).toBe("UNKNOWN");
		expect(unknown(row(), job(), ["not a row"])).toBe("UNKNOWN");
	});

	it("reads a 2.1.310 parked row, which carries state and no status", () => {
		/* Implement 3029's row and job, off the refill loop's log of
		 * 2026-10-25T23:40:10Z (#3200). */
		const parked = {
			id: "ddc2263e",
			cwd: "/home/lucmo/workflow-core",
			kind: "background",
			startedAt: 1_792_965_553_016,
			sessionId: "ddc2263e-6b9d-4b5d-a664-e43043a0f2f1",
			state: "blocked",
		};
		const asked = job({
			detail:
				"whether to reset the shared `main` onto `landing` — waits on you: #3031",
			needs:
				"whether to reset the shared `main` onto `landing` — waits on you: #3031",
			cliVersion: "2.1.310",
		});
		expect(cause(parked, asked, [])).toEqual({ cause: "QUESTION" });
		expect(
			cause(parked, job({ cliVersion: "2.1.310" }), [...tail, toolUse("Edit")]),
		).toEqual({
			cause: "PERMISSION",
		});
	});

	it("reads UNKNOWN on a row with neither status nor state, or no state (#3200)", () => {
		const { status: _, state: __, ...bare } = row();
		expect(cause(bare, job())).toEqual({
			cause: "UNKNOWN",
			why: "row carries neither status nor state",
		});
		expect(cause({ ...bare, status: "idle" }, job())).toEqual({
			cause: "UNKNOWN",
			why: "row state is not a string",
		});
	});

	it("reads UNKNOWN on a field of an unexpected type", () => {
		expect(unknown(row({ status: 1 }), job())).toBe("UNKNOWN");
		expect(unknown(row({ state: 1 }), job())).toBe("UNKNOWN");
		expect(unknown(row({ waitingFor: ["x"] }), job())).toBe("UNKNOWN");
		expect(unknown(row(), job({ tempo: undefined }))).toBe("UNKNOWN");
		expect(unknown(row(), job({ needs: { text: "x" } }))).toBe("UNKNOWN");
		expect(unknown(row(), job({ block: "questions" }))).toBe("UNKNOWN");
		expect(unknown(row(), job({ inFlight: { tasks: "0" } }))).toBe("UNKNOWN");
	});

	it("reads UNKNOWN on a CLI older than 2.1.293, or none", () => {
		expect(unknown(row(), job({ cliVersion: "2.1.292" }))).toBe("UNKNOWN");
		expect(unknown(row(), job({ cliVersion: undefined }))).toBe("UNKNOWN");
		expect(cause(row(), job({ cliVersion: "2.1.293" })).cause).toBe("QUESTION");
		expect(cause(row(), job({ cliVersion: "2.2.0" })).cause).toBe("QUESTION");
	});

	it("reads UNKNOWN where no rule matches, and says why", () => {
		expect(cause(row(), job({ tempo: "idle" }))).toEqual({
			cause: "UNKNOWN",
			why: "no rule matched",
		});
	});
});

describe("a session its host restarted that never takes a turn (#2659, #2978)", () => {
	const working = { state: "working", tempo: "idle" };
	/* The two harness restart rows (#2976 F2), as b1bcb905 and 0d30f1bf
	 * carry them. */
	const shellStopped = (timestamp: string) => ({
		type: "user",
		isSidechain: false,
		timestamp,
		origin: { kind: "task-notification" },
		queueTranscriptOnly: true,
		message: {
			role: "user",
			content:
				"<task-notification>\n<task-id>b5m5pjbd0</task-id>\n<status>stopped</status>\n<summary>Background shell command didn't finish before the previous session ended</summary>\n</task-notification>",
		},
	});
	const restarted = (timestamp: string) => ({
		type: "user",
		isSidechain: false,
		isMeta: true,
		timestamp,
		message: {
			role: "user",
			content: [
				{
					type: "text",
					text: "Continue from where you left off. Note: this session was automatically restarted after its process exited unexpectedly; the user has not sent a new message since the restart.",
				},
			],
		},
	});
	const delivery = (timestamp: string) => ({
		type: "user",
		isSidechain: false,
		isMeta: true,
		timestamp,
		origin: { kind: "plugin", name: "wfc-delivery" },
		message: {
			role: "user",
			content: [{ type: "text", text: "Delivered by the wfc-delivery mod…" }],
		},
	});
	const toolCall = (timestamp: string) => ({
		type: "assistant",
		isSidechain: false,
		timestamp,
		message: { content: [{ type: "tool_use", id: "toolu_1", name: "Bash" }] },
	});
	const batchResult = (timestamp: string) => ({
		type: "user",
		isSidechain: false,
		timestamp,
		message: {
			role: "user",
			content: [{ type: "tool_result", tool_use_id: "toolu_1" }],
		},
	});
	const notified = (timestamp: string) => ({
		type: "user",
		isSidechain: false,
		timestamp,
		origin: { kind: "task-notification" },
		message: {
			role: "user",
			content:
				"<task-notification>\n<status>completed</status>\n</task-notification>",
		},
	});
	const assistant = (timestamp: string) => ({
		type: "assistant",
		isSidechain: false,
		timestamp,
		message: { content: [{ type: "text", text: "Done." }] },
	});
	const apiRequest = (timestamp: string) => ({
		type: "api-request",
		timestamp,
		querySource: "repl_main_thread:outputStyle:custom",
	});
	const turnEnded = {
		type: "system",
		subtype: "turn_duration",
		isSidechain: false,
	};
	const attachment = (timestamp: string) => ({
		type: "attachment",
		isSidechain: false,
		timestamp,
	});
	const costState = { type: "cost-state", totalCostUSD: 1 };

	it("reads Implement 2636's tail from its stopped-shell notification's own time", () => {
		const rows = [
			apiRequest("2026-10-23T07:22:20.813Z"),
			assistant("2026-10-23T07:22:23.674Z"),
			turnEnded,
			{ type: "queue-operation", timestamp: "2026-10-23T07:29:11.693Z" },
			shellStopped("2026-10-23T07:29:15.875Z"),
			attachment("2026-10-23T07:29:15.644Z"),
			attachment("2026-10-23T07:29:17.767Z"),
			costState,
			{ type: "last-prompt" },
			costState,
		];
		expect(resumedIdleSince({ job: working, rows })).toBe(
			Date.parse("2026-10-23T07:29:15.875Z"),
		);
	});

	it("reads Implement 2634's tail from its stopped-shell notification", () => {
		const rows = [
			apiRequest("2026-10-23T07:16:16.034Z"),
			assistant("2026-10-23T07:16:19.673Z"),
			{ type: "system", subtype: "away_summary", isSidechain: false },
			costState,
			{ type: "queue-operation", timestamp: "2026-10-23T07:53:18.306Z" },
			shellStopped("2026-10-23T07:53:18.810Z"),
			{ type: "last-prompt" },
			costState,
		];
		expect(resumedIdleSince({ job: working, rows })).toBe(
			Date.parse("2026-10-23T07:53:18.810Z"),
		);
	});

	it("reads a harness API retry, an api-request every ~20 s after a restart, as no idle", () => {
		const rows = [
			assistant("2026-10-16T04:54:08.770Z"),
			restarted("2026-10-16T04:55:30.557Z"),
			apiRequest("2026-10-16T04:55:30.715Z"),
			apiRequest("2026-10-16T04:55:50.794Z"),
			apiRequest("2026-10-16T04:56:11.472Z"),
		];
		expect(resumedIdleSince({ job: working, rows })).toBeNull();
	});

	it("reads a restart mid-turn from its meta row, a later delivery row not moving it", () => {
		const rows = [
			apiRequest("2026-10-23T07:20:00.000Z"),
			toolCall("2026-10-23T07:20:03.000Z"),
			restarted("2026-10-23T07:29:28.178Z"),
			delivery("2026-10-23T07:31:00.000Z"),
		];
		expect(resumedIdleSince({ job: working, rows })).toBe(
			Date.parse("2026-10-23T07:29:28.178Z"),
		);
	});

	/* #2976 F3's classes, each trailing with no restart row: 25 Oct's 11
	 * misfires. */
	it.each([
		[
			"A, a delivery row mid tool call",
			[toolCall("2026-10-25T09:56:00Z"), delivery("2026-10-25T09:56:53Z")],
		],
		[
			"B, a delivery row after a turn end",
			[
				assistant("2026-10-25T12:20:00Z"),
				turnEnded,
				delivery("2026-10-25T12:21:04Z"),
			],
		],
		[
			"C, a delivery row before a spare's first prompt",
			[delivery("2026-10-25T12:21:04Z")],
		],
		[
			"D, one tool result of a parallel batch",
			[toolCall("2026-10-25T11:31:00Z"), batchResult("2026-10-25T11:32:10Z")],
		],
		[
			"E, a stale task notification after a turn end",
			[
				assistant("2026-10-25T13:49:40Z"),
				turnEnded,
				notified("2026-10-25T13:49:48Z"),
			],
		],
	])("reads class %s as no idle (#2976 F3)", (_, rows) => {
		expect(resumedIdleSince({ job: working, rows })).toBeNull();
	});

	it("ages a second restart with no turn between from its own row", () => {
		const rows = [
			apiRequest("2026-10-23T07:00:00Z"),
			restarted("2026-10-23T07:10:00Z"),
			shellStopped("2026-10-23T07:30:00Z"),
		];
		expect(resumedIdleSince({ job: working, rows })).toBe(
			Date.parse("2026-10-23T07:30:00Z"),
		);
	});

	it("reads a restart row a turn has followed as no idle", () => {
		for (const turn of [apiRequest, assistant])
			expect(
				resumedIdleSince({
					job: working,
					rows: [
						restarted("2026-10-23T07:00:00Z"),
						delivery("2026-10-23T07:04:00Z"),
						turn("2026-10-23T07:05:00Z"),
					],
				}),
			).toBeNull();
	});

	it("reads a stopped notification of another kind as no restart", () => {
		const other = shellStopped("2026-10-23T07:29:15.875Z");
		other.message.content =
			"<task-notification>\n<status>stopped</status>\n</task-notification>";
		expect(resumedIdleSince({ job: working, rows: [other] })).toBeNull();
	});

	it("reads a job not working as null, no resumed-idle reading", () => {
		expect(
			resumedIdleSince({
				job: { ...working, state: "blocked" },
				rows: [shellStopped("2026-10-23T07:29:15.875Z")],
			}),
		).toBeNull();
	});

	it("reads a record that will not read as unread, not as a turn taken (#2847)", () => {
		const rows = [shellStopped("2026-10-23T07:29:15.875Z")];
		for (const record of [null, "working", { ...working, state: undefined }])
			expect(resumedIdleSince({ job: record, rows })).toBe("unread");
		for (const unreadRows of [null, [], [costState]])
			expect(resumedIdleSince({ job: working, rows: unreadRows })).toBe(
				"unread",
			);
		for (const timestamp of ["not a time", undefined])
			expect(
				resumedIdleSince({
					job: working,
					rows: [{ ...shellStopped("x"), timestamp }],
				}),
			).toBe("unread");
	});
});
