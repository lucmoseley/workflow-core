/*
 * pending-tasks.js — what this session launched that has not come back yet.
 *
 * ITS CONSUMERS CHECK WHETHER A `waiting:` IS TRUE, bar one:
 * `guard-session-ceiling.js` NAMES what is still out at a context notice, so
 * a session there waits for it before ending (workflow-core#1179).
 * `guard-priced-options.js` refuses a background job that ends a turn on
 * `waiting:` with nothing actually pending (mantahostels#2487); `guard-uncommitted-work.js`
 * stands its own block down for a `waiting:` that IS backed by a launch, and
 * only for that one (mantahostels#2567). `waiting:` claims "something running will wake this
 * session"; a false one stalls the session with nothing coming to wake it.
 *
 * THE TWO READ THE ASYMMETRY BELOW IN OPPOSITE DIRECTIONS. Failing open toward
 * BUSY costs the first a missed refusal; it costs the second a standing
 * exemption, one unrecognised settlement exempting every later turn in that
 * session. mantahostels#2567 accepted that.
 *
 * WHAT MAKES THE CLAIM CHECKABLE IS THE TRANSCRIPT, not the process table. A
 * `run_in_background` Bash call and an `Agent` call each land in the session's
 * JSONL as a `tool_use` record. No other signal holds (mantahostels#2487): a
 * `ps` read cannot attribute a
 * process to a session, `scripts/bg-run.sh`'s beat files see only the commands
 * wrapped in it, and the harness's own job state is not exposed to a hook. A
 * foreground Bash call the harness moved to the background at its `timeout` is
 * a launch too, known only from its `tool_result` (workflow-core#1012), and so is a `Skill`
 * call that forked into the background, whose notification names the Skill
 * call's own id (workflow-core#1166).
 *
 * A LAUNCH IS SETTLED FOUR WAYS, and the notification is only the first. A
 * `<task-notification>` block naming its `<tool-use-id>` is the ordinary one.
 * The next two are what a first cut missed, and they are the MAJORITY: a
 * launch a PreToolUse hook refused, whose `tool_result` carries `is_error`, and
 * a FOREGROUND `Agent` call, whose `tool_result` is the agent's own report and
 * which no notification ever follows. Either left counted as live would keep
 * this function permanently busy for the rest of the session, and the consumer
 * would never refuse again. The fourth is a successful `TaskStop` naming the
 * launch's background handle, after which the harness writes no notification
 * (workflow-core#2754; shape from transcript 03a6b5a2, L1967-1968): left live, the ceiling hook kept naming watchers already stopped.
 *
 * THE ASYMMETRY IS NOT UNIFORM, deliberately. A Bash launch is settled by a
 * notification, an error or a `TaskStop`; only the last reads its result, so a
 * harness that reworded the announcement can turn one into a false refusal
 * only where a TaskStop also named it. The `Agent` limb reads it outright, and
 * carries that risk; so do the timeout, forked-Skill and `TaskStop` limbs —
 * hence two signals on each, the text and a structured `toolUseResult` field
 * beside it, either one enough. The census the Bash and `Agent` limbs rest on is on
 * mantahostels#2487; the forked-Skill spelling rests on one transcript (workflow-core#1166).
 *
 * IT ASYMMETRICALLY FAILS OPEN, deliberately. A launch this function fails to
 * recognise, and a settlement it fails to recognise, both leave the session
 * looking BUSY — the first because the launch count then rests on some other
 * launch, the second because an unsettled launch reads as live. The only
 * verdict it returns confidently is `pending: []` over a transcript it parsed.
 *
 * THREE THINGS IT CANNOT SEE, all of them stalls the consumer therefore misses
 * nothing on — each reads as "nothing pending", which is the refusing verdict:
 * a job backgrounded with `&` or `nohup` inside a foreground Bash call, one
 * launched from inside a script, and a `waiting:` written with nothing launched.
 * The one it reads WRONG is a Bash launch or forked Skill whose notification
 * the harness never wrote and no `TaskStop` settled: it stays pending for the rest of the session, and
 * every later `waiting:` passes.
 *
 * A `killed` notification settles the launch like any other: nothing further
 * will wake the session. It does NOT mean the work never happened — the harness
 * kills the job wrapper and the command often runs on (mantahostels#2517).
 */

const fs = require("node:fs");
const { requiredGroup } = require("./regex-group.js");

/* The tool-use id inside a `<task-notification>` block — the harness's own
 * settlement record. Matched on the tag rather than on the bare id so a launch
 * record's own `"id":"toolu_…"` field is never read as its own settlement.
 * Anywhere in the line: the block arrives inside a `queue-operation` record on
 * some turns and inside a user message on others, and both spell the tag. */
const SETTLED_ID = /<tool-use-id>([^<]+)<\/tool-use-id>/g;

/* What a `tool_result` says when the launch really did go to the background and
 * a notification is therefore still coming. Three spellings because the harness
 * uses one for a Bash job and two for a subagent; all three are read off the
 * corpus and documented nowhere. */
const ANNOUNCES_HANDLE =
	/running in background with ID|Async agent launched successfully|agent is working in the background/i;

/* A foreground Bash call that overran its `timeout`. Its notification names
 * the original tool-use id, as a `run_in_background` one does (workflow-core#1012). Anchored
 * to the opening words, and read only on a Bash call's result: unanchored, a
 * `grep` or `Read` that quoted the phrase minted a launch no notification ever
 * settles, passing every later `waiting:`. */
const MOVED_TO_BACKGROUND =
	/^Command did not complete within its \d+s timeout and was moved to the background/;

/* A `Skill` call that forked into the background (workflow-core#1166). Anchored and read
 * only on a Skill call's result, for the reason the overrun pattern is. */
const FORKED_SKILL =
	/^Skill "[^"]*" launched \(forked execution, running in the background\)/;

/* The handle a launch's result announces — a Bash job's background id, an
 * overrun's, or an async subagent's agentId — which is what `TaskStop` takes as its `task_id`.
 * The structured `backgroundTaskId` and `agentId` fields carry the same. */
const HANDLE =
	/(?:running in background with ID: |moved to the background \(ID: |agentId: )(\w+)/;

/* A `TaskStop` that stopped what it named (workflow-core#2754). Read only on a TaskStop
 * call's result, beside its structured `task_id`. */
const STOPPED = /Successfully stopped task: (\w+)/;

/**
 * @typedef {{ id: string, kind: string, name: string }} Launch
 * @typedef {{ records: number, launches: Launch[], pending: Launch[] }} Pending
 */

/**
 * What the transcript calls a tool call: its `description`, else a Bash call's
 * command or a Skill call's skill, on one line. "" where it gives none.
 * @param {{input?: {description?: unknown, command?: unknown, skill?: unknown}}} part
 */
function callName(part) {
	const i = part.input ?? {};
	const raw = [i.description, i.command, i.skill].find(
		(v) => typeof v === "string" && v.trim(),
	);
	return typeof raw === "string" ? raw.replace(/\s+/g, " ").trim() : "";
}

/**
 * @typedef {any} TranscriptRecord One parsed transcript line. `any` because
 * JSON.parse types nothing and each field is read and guarded where it is used.
 * @typedef {any} ContentBlock One block of a record's `message.content`,
 * `any` for the same reason: its shape varies by `type`, checked before use.
 */

/**
 * What one pass over the transcript has gathered so far.
 * @typedef {{
 *   launches: Map<string, Launch>,
 *   settled: Set<string>,
 *   results: Map<string, {error: boolean, announced: boolean}>,
 *   handles: Map<string, string>,
 *   stopped: Set<string>,
 *   taskStopCalls: Set<string>,
 *   bashCallNames: Map<string, string>,
 *   skillCallNames: Map<string, string>,
 * }} Census
 */

/**
 * Every launch in one transcript, and which of them are still out.
 *
 * @param {string} file the session's transcript path
 * @returns {Pending} `records` is how many JSONL lines parsed to an object —
 *   0 means the transcript said nothing and the caller has no verdict, not an
 *   empty one.
 * @throws whatever reading the file throws; the caller fails open on it.
 */
function readPendingTasks(file) {
	/** @type {Census} */
	const census = {
		launches: new Map(),
		settled: new Set(),
		results: new Map(),
		/* The background handle each result announced, by tool-use id, and the
		 * handles a `TaskStop` stopped. */
		handles: new Map(),
		stopped: new Set(),
		taskStopCalls: new Set(),
		/* Each call's name, by id, for a launch only its result reveals. */
		bashCallNames: new Map(),
		skillCallNames: new Map(),
	};
	let records = 0;

	for (const line of fs.readFileSync(file, "utf8").split("\n")) {
		if (!line.trim()) continue;
		/* The settlement scan runs over the raw line, before the parse: the
		 * notification is a string field wherever it lands, so the tag survives
		 * JSON escaping intact and the record's own shape does not matter. */
		SETTLED_ID.lastIndex = 0;
		for (let m = SETTLED_ID.exec(line); m; m = SETTLED_ID.exec(line))
			census.settled.add(requiredGroup(m, 1, SETTLED_ID));

		/** @type {TranscriptRecord} */
		let rec;
		try {
			rec = JSON.parse(line);
		} catch {
			continue;
		}
		/* A line parsing to `null`, a scalar or an array is no record (workflow-core#1531). */
		if (typeof rec !== "object" || rec === null || Array.isArray(rec)) continue;
		records += 1;
		readRecord(census, rec);
	}

	const all = [...census.launches.values()];
	return {
		records,
		launches: all,
		pending: all.filter((l) => isStillOut(census, l)),
	};
}

/**
 * @param {Census} census
 * @param {TranscriptRecord} rec
 */
function readRecord(census, rec) {
	/* A subagent writing into its parent's file would have its own launches
	 * read as the parent's. Defensive: no local transcript carries
	 * `isSidechain`, so nothing exercises this branch (mantahostels#2487). */
	if (rec.isSidechain) return;
	const content = rec.message?.content;
	if (!Array.isArray(content)) return;
	for (const part of content) {
		if (part?.type === "tool_result" && part.tool_use_id) {
			readResult(census, part, rec.toolUseResult);
			continue;
		}
		if (part?.type !== "tool_use" || !part.id) continue;
		readCall(census, part);
	}
}

/**
 * Records a `tool_result`, and the launch it reveals where a Bash call overran
 * its timeout or a Skill call forked.
 * @param {Census} census accumulator: the result, and any launch it reveals, are recorded in it
 * @param {ContentBlock} part
 * @param {any} toolUseResult the record's structured result field: `any` for the reason TranscriptRecord is
 */
function readResult(census, part, toolUseResult) {
	const id = part.tool_use_id;
	const body =
		typeof part.content === "string"
			? part.content
			: JSON.stringify(part.content ?? "");
	census.results.set(id, {
		error: part.is_error === true,
		announced: ANNOUNCES_HANDLE.test(body),
	});
	const text =
		typeof part.content === "string"
			? part.content
			: (part.content?.[0]?.text ?? "");
	readHandle(census, id, text, toolUseResult);
	if (census.taskStopCalls.has(id) && part.is_error !== true)
		readStop(census, text, toolUseResult);
	const moved =
		MOVED_TO_BACKGROUND.test(text) || toolUseResult?.backgroundTaskId;
	if (moved && census.bashCallNames.has(id) && !census.launches.has(id))
		census.launches.set(id, {
			id,
			kind: "background command",
			name: census.bashCallNames.get(id) ?? "",
		});
	const forked =
		FORKED_SKILL.test(text) ||
		(toolUseResult?.status === "forked" && toolUseResult?.background === true);
	if (forked && census.skillCallNames.has(id))
		census.launches.set(id, {
			id,
			kind: "forked skill",
			name: census.skillCallNames.get(id) ?? "",
		});
}

/**
 * Records the background handle a result announces (workflow-core#2754).
 * @param {Census} census accumulator: the handle is recorded in it
 * @param {string} id the result's tool-use id
 * @param {string} text the result's text
 * @param {any} toolUseResult as readResult takes it
 */
function readHandle(census, id, text, toolUseResult) {
	const handle =
		toolUseResult?.backgroundTaskId ??
		toolUseResult?.agentId ??
		HANDLE.exec(text)?.[1];
	if (typeof handle === "string") census.handles.set(id, handle);
}

/**
 * Records the handle a non-error `TaskStop` result stopped (workflow-core#2754). The
 * structured `task_id` alone is enough, and so is the text alone: a record
 * holding several results carries no `toolUseResult`, and 632 of 1,991
 * corpus stops sit in one (workflow-core#2754). Either alone means a non-error result
 * carrying `task_id` for a stop that failed would settle falsely — no such
 * result is in the corpus, where every failure is `is_error`.
 * @param {Census} census accumulator: the stopped handle is recorded in it
 * @param {string} text the result's text
 * @param {any} toolUseResult as readResult takes it
 */
function readStop(census, text, toolUseResult) {
	const stopped = toolUseResult?.task_id ?? STOPPED.exec(text)?.[1];
	if (typeof stopped === "string") census.stopped.add(stopped);
}

/**
 * Records a `tool_use`: its name, and a launch where it is one.
 * @param {Census} census accumulator: a Bash or Skill call's name, and any launch,
 *   are recorded in it
 * @param {ContentBlock} part
 */
function readCall(census, part) {
	const name = callName(part);
	if (part.name === "Bash") census.bashCallNames.set(part.id, name);
	if (part.name === "Skill") census.skillCallNames.set(part.id, name);
	if (part.name === "TaskStop") census.taskStopCalls.add(part.id);
	if (part.name === "Agent")
		census.launches.set(part.id, { id: part.id, kind: "subagent", name });
	else if (part.name === "Bash" && part.input?.run_in_background)
		census.launches.set(part.id, {
			id: part.id,
			kind: "background command",
			name,
		});
}

/**
 * Is this launch still out? Settled by its notification, by a `TaskStop` that
 * stopped its handle, by a `tool_result` saying the launch was refused, or —
 * for a subagent only — by a result that announces no background handle,
 * which is a foreground agent's own report.
 * @param {Census} census
 * @param {Launch} l
 * @returns {boolean}
 */
function isStillOut(census, l) {
	if (census.settled.has(l.id)) return false;
	const handle = census.handles.get(l.id);
	if (handle !== undefined && census.stopped.has(handle)) return false;
	const res = census.results.get(l.id);
	/* No result at all is unmeasured, so it keeps the busy reading rather than
	 * earning a refusal. */
	if (!res) return true;
	if (res.error) return false;
	if (l.kind === "subagent") return res.announced;
	return true;
}

module.exports = { readPendingTasks };
