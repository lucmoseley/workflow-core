const { buildLoopComment } = require("./loop-comment.js");
const fs = require("node:fs");
const path = require("node:path");
const { isTerminalAgent, listedAgents } = require("./agent-liveness");
const { stopOn } = require("./claude-stop.js");
const { jobStatePath, shortJobId } = require("./job-paths.js");
const { orFallback } = require("./caught.js");
const {
	configDir,
	die,
	entry,
	modelOf,
	readJobs,
	readTranscriptRecords,
	snapshotJob,
} = require("./rescue-jobs.js");
const {
	INTENT_ISSUES,
	PROBE_EXIT,
	buildVerdictText,
	readTranscriptOf,
	sampleHolder,
} = require("./rescue-probe.js");
const { scriptPath } = require("./script-path.js");

/** @typedef {import("./rescue-jobs.js").ParsedArgs} ParsedArgs */
/** @typedef {import("./rescue-jobs.js").RescuePorts} RescuePorts */
/** @typedef {import("./rescue-jobs.js").Job} Job */
/** @typedef {import("./tracker-ops.js").BufferedIo} BufferedIo */
/** @typedef {import("./agent-liveness").AgentRecord} AgentRecord */
/** @typedef {import("./agent-liveness").Listing} Listing */
/** @typedef {import("./agent-liveness").RunOracle} RunOracle */
/** @typedef {import("./gh.js").GhRun} GhRun */
/** @typedef {import("./rescue-probe.js").GhostJob} GhostJob */

// guess, #621
const STOP_CONFIRM_CEILING_S = 60;

const HAND_OFF_USAGE =
	"usage: rescue-sessions.js hand-off --from <config-dir> --job <short id> [--session <id>] --issue <n> [--issue <n>]…";

const VERDICT_REFUSAL = {
	UNKNOWN: () =>
		"Nothing stopped — doubt never stops a session. Re-run takeover; if it stays UNKNOWN, ask the founder, naming the unreadable input above.",
	ASKING: () =>
		'Nothing stopped — it is waiting on an answer. Answer its question, or put it to the founder; if they rule it stuck, re-run with --despite ASKING --reason "<their ruling>".',
	SLOW: () =>
		'Nothing stopped — it is still working. Wait and re-run takeover later, or put the verdict to the founder; if they rule it stuck, re-run with --despite SLOW --reason "<their ruling>".',
	DONE: (/** @type {string} */ ticket) =>
		`Nothing stopped or adopted — its work finished. Release its claim or close ${ticket} instead.`,
};

/**
 * @param {RescuePorts} ports
 * @param {string} sessionId
 * @param {number} ceilingS
 * @param {{requireGone?: boolean, hostPid?: number | null}} [opts]
 * @returns {Promise<{how: string} | {how: null, why: string | null}>}
 */
async function confirmStopped(
	ports,
	sessionId,
	ceilingS,
	{ requireGone = false, hostPid = null } = {},
) {
	const hostRuns = () =>
		hostPid !== null &&
		fs.existsSync(path.join(ports.procRoot, String(hostPid)));
	const deadline = ports.now() + ceilingS * 1000;
	const poll = Math.min(1000, (ceilingS * 1000) / 5);
	for (;;) {
		const listing = listedAgents({ run: ports.oracle });
		const how = stopConfirmation(listing, sessionId, requireGone, hostRuns);
		if (how) return { how };
		if (ports.now() >= deadline) return { how: null, why: listing.why ?? null };
		await ports.sleep(poll);
	}
}

/**
 * @param {string} short
 * @param {number} ceilingS
 * @param {string | null} why
 */
const unconfirmedWhy = (short, ceilingS, why) =>
	why
		? `the listing would not read ${ceilingS}s after the stop: ${why}`
		: `the oracle still lists ${short} as live ${ceilingS}s after the stop`;

/**
 * @param {Listing} listing
 * @param {string} sessionId
 * @param {boolean} requireGone
 * @param {() => boolean} hostRuns
 */
function stopConfirmation(listing, sessionId, requireGone, hostRuns) {
	if (!listing.agents) return null;
	const row = listing.agents.find((a) => a.sessionId === sessionId);
	if (!row && !(requireGone && hostRuns()))
		return requireGone ? "unlisted, its host exited" : "no longer listed";
	if (row && !requireGone && isTerminalAgent(row)) return `listed ${row.state}`;
	return null;
}

/** @param {string} sessionId */
function readFileClaimLines(sessionId) {
	const store = require("./arbiter-store");
	const { worktreeLabel } = require("./session-worktrees.js");
	const held = store.readLocksHeldBy(sessionId);
	if (held === null) return ["  (the file-claim store would not read)"];
	if (held.length === 0) return ["  (none)"];
	return held.map((lock) => {
		const p = lock.tree
			? `${lock.path} (in ${worktreeLabel(require("./arbiter-core").repoRoot(), lock.tree)})`
			: lock.path;
		const d = store.subjectDirtyWhereHeld(lock);
		if (d === null) return `  ${p} — unknown`;
		return `  ${p} — ${d ? "dirty" : "clean"}`;
	});
}

/**
 * @typedef {{dir: string, jobId: string, sessionId: string, ceiling: number,
 *   short: string, kept: string, row: AgentRecord | undefined}} StopTarget
 */

/**
 * @param {BufferedIo} io
 * @param {ParsedArgs} args
 * @param {RescuePorts} ports
 */
async function takeOver(io, args, ports) {
	const tracker = require("./tracker-ops.js");
	const { me, ceiling } = takeoverOptions(args, io, ports.env);
	const { despite, reason } = args;
	const repo = io.trackerOrFail();

	const v = await sampleHolder(io, args, "take over", ports);
	const { who, after } = v;
	io.out(buildVerdictText(v));
	if (v.verdict === "GHOST")
		return stopGhost(io, { who, ghost: v.ghost }, ceiling, ports);
	if (after.holder?.row.kind === "headless")
		io.fail(
			`${who.sessionId} is a headless overflow run, which takeover does not handle. Stop it with node ${scriptPath("lib/headless-sessions.js")} stop ${after.holder.row.id}. Nothing written.`,
			2,
		);
	const n = who.issue;
	if (n === null)
		io.fail(
			`${who.sessionId} holds no ticket claim — name the ticket with --issue. Nothing written.`,
			2,
		);
	const overruled = v.verdict === despite;
	if (
		v.verdict !== "FROZEN" &&
		v.verdict !== "LIMITED" &&
		v.verdict !== "ENDED" &&
		!overruled
	)
		io.fail(
			`not taking over: ${v.verdict}. ${VERDICT_REFUSAL[v.verdict](`#${n}`)}`,
			PROBE_EXIT[v.verdict],
		);
	const issue = readOpenIssue(io, repo, n, ports.gh);

	const dir =
		after.holder?.dir ??
		v.dirs.find((d) => readTranscriptOf(d, who.sessionId) === after.transcript);
	if (!dir || !after.transcript)
		io.fail(
			"no plan holds the session's transcript, so there is nothing to resume from — ask the founder. Nothing written.",
			2,
		);
	const short = shortJobId(who.sessionId);
	const row = after.holder?.row;

	const out = rescueDir(n, short);
	const { job } = snapshotJob(
		io,
		dir,
		out,
		readTakeoverJob(dir, who.sessionId, after.transcript, row),
	);
	fs.writeFileSync(
		path.join(out, "index.json"),
		`${JSON.stringify([job], null, 2)}\n`,
	);
	io.out(`snapshot: ${out}\n`);
	const kept = `No claim taken; the snapshot is still on disk at ${out}.`;

	/** @type {StopTarget} */
	const target = {
		dir,
		jobId: jobIdOf(row, who.sessionId),
		sessionId: who.sessionId,
		ceiling,
		short,
		kept,
		row,
	};
	const claimsStuck = await stopHolder(io, v, target, ports);

	adoptClaim(io, { n, me }, target, ports.oracle);

	let failed = false;
	const assignError = tracker.assignSelf(repo, n, ports.gh);
	if (assignError) {
		failed = true;
		io.warn(
			`assigning #${n} failed (${assignError}) — gh issue edit ${n} --add-assignee @me`,
		);
	}
	const comment = buildTakeoverComment({
		me,
		sessionId: who.sessionId,
		name: job.name,
		dir,
		verdict: v.verdict,
		why: v.why,
		evidence: v.evidence,
		overruled,
		reason,
		out,
		claimsStuck,
	});
	if (!postComment(io, ports.gh, { repo, n, out }, comment)) failed = true;

	const resume = buildResumptionText(job, {
		n,
		title: issue.title,
		out,
		short,
		sessionId: who.sessionId,
		claimsStuck,
	});
	fs.writeFileSync(path.join(out, "RESUMPTION.md"), `${resume}\n`);
	io.out(`\n${resume}\n`);
	return failed ? 1 : 0;
}

/**
 * @param {ParsedArgs} args
 * @param {BufferedIo} io
 * @param {NodeJS.ProcessEnv} env
 */
function takeoverOptions(args, io, env) {
	const me = env.CLAUDE_CODE_SESSION_ID;
	if (!me)
		io.fail(
			"CLAUDE_CODE_SESSION_ID is unset — a takeover adopts the ticket for this session, and there is none. Run it from inside a Claude session. Nothing written.",
			2,
		);
	const ceiling =
		args["confirm-within"] === undefined
			? STOP_CONFIRM_CEILING_S
			: Number(args["confirm-within"]);
	if (!(Number.isFinite(ceiling) && ceiling > 0))
		io.fail("--confirm-within takes a positive number of seconds", 2);
	checkDespite(args, io);
	return { me, ceiling };
}

/**
 * @param {ParsedArgs} args
 * @param {BufferedIo} io
 */
function checkDespite(args, io) {
	const { despite, reason } = args;
	if (despite === undefined) {
		if (reason !== undefined)
			io.fail("--reason goes with --despite SLOW|ASKING. Nothing written.", 2);
	} else if (despite !== "SLOW" && despite !== "ASKING")
		io.fail(
			`--despite takes SLOW or ASKING, not ${despite}. ${despite === "UNKNOWN" || despite === "DONE" ? VERDICT_REFUSAL[despite](args.issue ? `#${args.issue}` : "its ticket") : "Nothing written."}`,
			2,
		);
	else if (!(typeof reason === "string" && reason.trim()))
		io.fail(
			`--despite needs --reason "<the founder's ruling that it is stuck>". Nothing written.`,
			2,
		);
}

/**
 * @param {BufferedIo} io
 * @param {string} repo
 * @param {number} n
 * @param {GhRun} gh
 */
function readOpenIssue(io, repo, n, gh) {
	const tracker = require("./tracker-ops.js");
	const { parseErrLine } = require("./gh.js");
	let issue;
	try {
		issue = tracker.readIssue(repo, n, gh);
	} catch (e) {
		io.fail(
			`could not read #${n} from ${repo} (${parseErrLine(e)}). Nothing written — re-run.`,
			1,
		);
	}
	if (issue.state !== "open")
		io.fail(
			`#${n} is ${issue.state} — nothing to adopt. Ask the founder whether it should be reopened. Nothing written.`,
			2,
		);
	return issue;
}

/**
 * @param {string} dir
 * @param {string} sessionId
 * @param {string} transcript
 * @param {AgentRecord | undefined} row
 * @returns {Job}
 */
function readTakeoverJob(dir, sessionId, transcript, row) {
	const short = shortJobId(sessionId);
	/** @type {Job} */
	const job = readJobs(dir).jobs.find((j) => j.short === short) ?? {
		...readUnrecordedCwd(transcript, row),
		short,
		state: row?.state ?? "unlisted",
		detail: "",
		intent: "",
		name: row?.name ?? "",
		sessionId,
		transcript,
		model: "",
		updatedAt: fs.statSync(transcript).mtime.toISOString(),
	};
	if (!job.transcript || !fs.existsSync(job.transcript))
		job.transcript = transcript;
	return job;
}

/**
 * @param {string} transcript
 * @param {AgentRecord | undefined} row
 * @returns {{cwd: string, cwdGuessed?: true}}
 */
function readUnrecordedCwd(transcript, row) {
	const { hostRoot } = require("./host-root.js");
	const cwd = row?.cwd || readTranscriptCwd(transcript);
	if (cwd) return { cwd };
	return { cwd: hostRoot(), cwdGuessed: true };
}

/**
 * @param {string} transcript
 * @returns {string | null}
 */
function readTranscriptCwd(transcript) {
	const { gitTopLevel } = require("./host-root.js");
	const { projectSlug } = require("./project-slug.js");
	const { readLinkedWorktrees } = require("./worktree-paths.js");
	const last = readTranscriptRecords(transcript).findLast(
		(r) => typeof r?.cwd === "string" && r.cwd && fs.existsSync(r.cwd),
	)?.cwd;
	const top = last ? orFallback(() => gitTopLevel(last), null) : null;
	if (top !== null) return top;
	const slug = path.basename(path.dirname(transcript));
	const core = require("./arbiter-core");
	return (
		readLinkedWorktrees(core.repoRoot())?.find(
			(dir) => projectSlug(dir) === slug,
		) ?? null
	);
}

/**
 * @param {BufferedIo} io
 * @param {{who: {sessionId: string, issue: number | null}, ghost: GhostJob}} found
 * @param {number} ceiling
 * @param {RescuePorts} ports
 * @returns {Promise<number>}
 */
async function stopGhost(
	io,
	{ who, ghost: { dir, rec, row } },
	ceiling,
	ports,
) {
	const short = shortJobId(who.sessionId);
	const kept = path.join(
		rescueDir(who.issue ?? "ghost", short),
		`${short}.state.json`,
	);
	fs.writeFileSync(kept, `${JSON.stringify(rec, null, 2)}\n`);
	io.out(`kept: ${kept}\n`);
	await stopLiveHolder(
		io,
		{
			dir,
			jobId: jobIdOf(row, who.sessionId),
			sessionId: who.sessionId,
			ceiling,
			short,
			kept: `Its job record is kept at ${kept}.`,
			row,
		},
		ports,
	);
	io.out(
		`\nNothing ran, so nothing is adopted. ${buildRedispatchText(rec, kept, ports.now())}\n`,
	);
	return 0;
}

/**
 * @param {any} rec
 * @param {string} kept
 * @param {number} now
 */
function buildRedispatchText(rec, kept, now) {
	const { shellQuote } = require("./sh-quote.js");
	const {
		DEFAULT_WINDOW_HOURS,
		commandOf,
		entryHolds,
		issuesIn,
		readRecentEntries,
	} = require("./dispatch-ledger");
	const flags = Array.isArray(rec.respawnFlags) ? rec.respawnFlags : [];
	const model = modelOf(flags);
	const intent = typeof rec.intent === "string" ? rec.intent : "";
	if (!intent || !model)
		return `Its record names ${intent ? "no model" : "no intent"} — re-dispatch it by hand from ${kept}.`;
	const issues = issuesIn(intent.match(INTENT_ISSUES)?.[0] ?? "");
	const held = readRecentEntries(
		undefined,
		DEFAULT_WINDOW_HOURS,
		now,
	).entries.some(
		(e) =>
			e.issues.some((n) => issues.includes(n)) &&
			entryHolds(e, commandOf(intent)),
	);
	const opts = [
		...(held ? ["--force"] : []),
		...(flags.includes("--advisor") ? [] : ["--no-advisor"]),
	];
	const command = [
		scriptPath("dispatch-sessions.js"),
		...opts,
		model,
		shellQuote(intent),
	];
	return `Re-dispatch it:\n  ${command.join(" ")}${held ? "\n--force because the dispatch ledger still holds its own launch; it skips the allowance gate too, so read the allowance first (rescue-sessions skill)." : ""}`;
}

/**
 * @param {number | string} label
 * @param {string} short
 */
function rescueDir(label, short) {
	const core = require("./arbiter-core");
	const out = path.join(
		core.repoRoot(),
		".claude",
		"tmp",
		"rescue",
		`${label}-${short}`,
	);
	fs.mkdirSync(out, { recursive: true });
	return out;
}

/**
 * @param {AgentRecord | undefined} row
 * @param {string} sessionId
 */
const jobIdOf = (row, sessionId) => shortJobId(row?.id || sessionId);

/**
 * @param {BufferedIo} io
 * @param {{verdict: string, why: string}} v
 * @param {StopTarget} s
 * @param {RescuePorts} ports
 * @returns {Promise<boolean>}
 */
async function stopHolder(io, v, s, ports) {
	if (v.verdict === "ENDED" && s.row)
		return stopEndedHolder(io, s, s.row, ports);
	if (v.verdict === "ENDED") {
		io.out(`no stop: ${v.why}\n`);
		return false;
	}
	await stopLiveHolder(io, s, ports);
	return false;
}

/**
 * @param {BufferedIo} io
 * @param {StopTarget} s
 * @param {AgentRecord} row
 * @param {RescuePorts} ports
 * @returns {Promise<boolean>}
 */
async function stopEndedHolder(io, s, row, ports) {
	const stopped = stopOn(s.dir, s.jobId, undefined, { spawn: ports.claude });
	if (!stopped.ok) {
		io.warn(
			`not stopped: ${stopped.why}. Its file claims stay held while its host runs, each warning a neighbour that writes it of a conflict; once the host ends they are stale, and the next write to each takes it`,
		);
		return true;
	}
	const confirmed = await confirmStopped(ports, s.sessionId, s.ceiling, {
		requireGone: true,
		hostPid: row.pid ?? null,
	});
	if (confirmed.how) {
		io.out(`stopped: ${s.short} on ${s.dir}, ${confirmed.how}\n`);
		return false;
	}
	const why =
		"why" in confirmed && confirmed.why
			? `stop sent, but ${unconfirmedWhy(s.short, s.ceiling, confirmed.why)}`
			: `stop sent, but not confirmed gone ${s.ceiling}s after it`;
	io.warn(
		`${why}. Its file claims stay held while its host runs, each warning a neighbour that writes it of a conflict; once the host ends they are stale, and the next write to each takes it`,
	);
	return true;
}

/**
 * @param {BufferedIo} io
 * @param {StopTarget} s
 * @param {RescuePorts} ports
 */
async function stopLiveHolder(io, s, ports) {
	const stopped = stopOn(s.dir, s.jobId, undefined, { spawn: ports.claude });
	if (!stopped.ok)
		io.fail(
			`claude stop failed on ${s.dir}: ${stopped.why}. ${s.kept} Re-run takeover, or ask the founder to stop it.`,
			1,
		);
	io.out(`stopped: ${s.short} on ${s.dir} (${stopped.said})\n`);
	const confirmed = await confirmStopped(ports, s.sessionId, s.ceiling);
	if (!confirmed.how)
		io.fail(
			`${unconfirmedWhy(s.short, s.ceiling, "why" in confirmed ? confirmed.why : null)}. ${s.kept} Re-run takeover once it reads stopped.`,
			1,
		);
	io.out(`confirmed: ${confirmed.how}\n`);
}

/**
 * @param {BufferedIo} io
 * @param {{n: number, me: string}} claim
 * @param {StopTarget} s
 * @param {RunOracle | undefined} oracle
 */
function adoptClaim(io, { n, me }, { sessionId, kept }, oracle) {
	const tracker = require("./tracker-ops.js");
	const r = tracker.claimIfFree(n, me, { run: oracle });
	if (r.status === "held") {
		const other = String(r.holder.sessionId);
		const name = r.names?.get(other);
		const again = other === sessionId;
		io.fail(
			`#${n} is held by live session ${other}${name ? ` (${name})` : ""}, claimed ${r.holder.claimedAt}. ${again ? "The stopped session still reads live — re-run takeover." : "A third session took it meanwhile — leave it to them."} ${kept}`,
			1,
		);
	}
	if (r.status === "busy")
		io.fail(
			`another claim on #${n} held the arbiter's lock past its wait. ${kept} Re-run takeover.`,
			1,
		);
	if (r.status === "unreadable")
		io.fail(`${r.why}. ${kept} Re-run takeover.`, 1);
	if (r.status !== "claimed" && r.status !== "reclaimed")
		io.fail(`the arbiter would not record #${n} (${r.status}). ${kept}`, 1);
	io.out(`claimed: #${n} for ${me}\n`);
}

/**
 * @param {{me: string, sessionId: string, name: string, dir: string,
 *   verdict: string, why: string, evidence: string[], overruled: boolean,
 *   reason: ParsedArgs[string] | undefined, out: string,
 *   claimsStuck: boolean}} t
 */
function buildTakeoverComment(t) {
	const core = require("./arbiter-core");
	return [
		`**Taken over** by session ${t.me}, through \`rescue-sessions.js takeover\`.`,
		"",
		`- ${t.claimsStuck ? "Ended session, not stopped — its file claims stay held" : "Stopped session"}: ${t.sessionId}${t.name ? ` (${t.name})` : ""}`,
		`- Plan: ${t.dir}`,
		`- Verdict: ${t.verdict} — ${t.why}${t.overruled ? " — overruled with --despite" : ""}`,
		...t.evidence.map((e) => `  - ${e}`),
		...(t.overruled ? [`- Reason for overruling: ${t.reason}`] : []),
		`- Snapshot: ${path.relative(core.repoRoot(), t.out)}`,
	].join("\n");
}

/**
 * @param {BufferedIo} io
 * @param {GhRun} gh
 * @param {{repo: string, n: number, out: string}} ticket
 * @param {string} comment
 * @returns {boolean}
 */
function postComment(io, gh, { repo, n, out }, comment) {
	const { parseErrLine } = require("./gh.js");
	try {
		gh(["issue", "comment", String(n), "--repo", repo, "--body-file", "-"], {
			input: comment,
			stdio: ["pipe", "pipe", "pipe"],
		});
		io.out(`commented: #${n}\n`);
		return true;
	} catch (e) {
		fs.writeFileSync(path.join(out, "COMMENT.md"), `${comment}\n`);
		io.warn(
			`commenting on #${n} failed (${parseErrLine(e)}) — post ${path.join(out, "COMMENT.md")} by hand.`,
		);
		return false;
	}
}

const GUESSED_CWD =
	" (a guess: no record names its directory and no checkout git lists matches its transcript — find its worktree with git worktree list)";

/**
 * @param {Job} job
 * @param {{n: number, title: string, out: string, short: string,
 *   sessionId: string, claimsStuck: boolean}} t
 */
function buildResumptionText(job, t) {
	return [
		`Adopted #${t.n} ${t.title}`,
		`Intent: ${job.intent || "(no job record — read the narration's first USER line)"}`,
		`Narration: ${path.join(t.out, `${t.short}.narration.txt`)}`,
		`Worktree: ${job.cwd ? `${job.cwd}${job.cwdGuessed ? GUESSED_CWD : ""}` : "(not recorded — find its dirty files with git worktree list)"}`,
		`Death point:\n${job.deathPoint || "(none)"}`,
		`Commits landed: ${buildLandedLine(job)}`,
		`Artefacts survived: ${job.artefactsSurvived && job.artefactsSurvived.length > 0 ? job.artefactsSurvived.join(", ") : "none"}`,
		t.claimsStuck
			? "Its file claims, held while its host runs — your writes to each go ahead with a conflict warning, and once it ends your next write takes each:"
			: "Its file claims, listed and not moved — your next write takes each:",
		...readFileClaimLines(t.sessionId),
		"",
		`Read the narration yourself, then continue its intent ${buildWhereLine(job)}.`,
	].join("\n");
}

/** @param {Pick<Job, "cwd" | "cwdGuessed">} job */
function buildWhereLine({ cwd, cwdGuessed }) {
	if (!cwd) return "in this session";
	if (cwdGuessed) return "in the worktree git worktree list shows it worked in";
	const { isSessionWorktreeDir } = require("./worktree-dirs.js");
	const { shellQuote } = require("./sh-quote.js");
	const dir = shellQuote(cwd);
	const core = require("./arbiter-core");
	return isSessionWorktreeDir(core.repoRoot(), cwd)
		? `in its worktree: cd ${dir}, or relaunch there with ${scriptPath("dispatch-sessions.js")} --into ${dir} <model> <prompt>`
		: `where its edits sit: cd ${dir}`;
}

/** @param {Job} job */
function buildLandedLine(job) {
	if (job.commitsLanded === null) return "unreadable (git would not run)";
	if (job.commitsLanded && job.commitsLanded.length > 0)
		return job.commitsLanded.join("; ");
	return "none matched";
}

/**
 * @param {BufferedIo} io
 * @param {ParsedArgs} args
 * @param {RescuePorts} ports
 */
function handOffJob(io, args, ports) {
	const { dir, short, issues, first, launchSession } = parseHandOffArgs(
		args,
		io,
		ports.env,
	);
	const repo = io.trackerOrFail();
	const found = readJobs(dir).jobs.find((j) => j.short === short);
	if (!found && fs.existsSync(jobStatePath(dir, short)))
		io.fail(
			`job ${short}'s record on ${dir} will not read. Nothing written.`,
			2,
		);
	const out = rescueDir(first, short);
	const sessionId = found ? found.sessionId : launchSession;
	const comment = found
		? writeSnapshotBody(io, dir, out, found)
		: writeHandOffBody(io, { sessionId, ticket: "the ticket" }, out, {
				head: buildRecordlessHead(short, sessionId),
				done: "unread: its job record is gone",
				blockedOn:
					"nothing the loop could read: its job record is gone, and it may have been waiting on the founder",
			});
	let failed = false;
	for (const n of issues) {
		if (!postComment(io, ports.gh, { repo, n, out }, comment)) failed = true;
		if (found || sessionId) {
			if (!releaseHandedOff(io, n, sessionId)) failed = true;
		} else io.out(`left: any claim on #${n}, its session id being unknown\n`);
	}
	return failed ? 1 : 0;
}

/**
 * @param {ParsedArgs} args
 * @param {BufferedIo} io
 * @param {NodeJS.ProcessEnv} env
 */
function parseHandOffArgs(args, io, env) {
	const short = typeof args.job === "string" ? args.job : "";
	const issues = (Array.isArray(args.issue) ? args.issue : []).map(Number);
	const [first] = issues;
	if (!short || first === undefined || !issues.every((n) => n > 0))
		return die(io, HAND_OFF_USAGE);
	return {
		dir: configDir(args, io, env),
		short,
		issues,
		first,
		launchSession: typeof args.session === "string" ? args.session : "",
	};
}

/**
 * @param {BufferedIo} io
 * @param {number} n
 * @param {string} sessionId
 */
function releaseHandedOff(io, n, sessionId) {
	const store = require("./arbiter-store");
	const r = store.releaseIssue(n, { sessionId });
	if (r.status === "released") io.out(`released: its claim on #${n}\n`);
	else if (r.status === "none") io.out(`released: it held no claim on #${n}\n`);
	else {
		io.warn(`releasing its claim on #${n} failed (${r.status})`);
		return false;
	}
	return true;
}

/**
 * @param {string} ticket
 * @param {string|null} narrated
 */
const buildHandOffLeft = (ticket, narrated) =>
	narrated
		? `continue ${ticket} from ${narrated}, unless they end on a question to the founder that this ticket does not show answered: then post it as a round and park, building nothing past it`
		: `continue ${ticket}; the loop read no narration for it, so first ask by round anything this ticket leaves open for the founder`;

const HANDED_OFF_HEAD = `**${buildLoopComment("handed off.")}**`;
const FRESH_PICK_UP =
	"fresh session picks up from the block below, launched by the next tick free to, which an away-mode loop is not while the ticket is labelled parked.";

/**
 * @param {string} short
 * @param {string} sessionId
 */
const buildRecordlessHead = (short, sessionId) =>
	`${HANDED_OFF_HEAD} ${sessionId ? `Session ${sessionId}` : "The session"} of job ${short} ended unread: its job record is gone. ${sessionId ? "The loop released its claim; a" : "A"} ${FRESH_PICK_UP}`;

/**
 * @param {BufferedIo} io
 * @param {string} dir
 * @param {string} out
 * @param {Job} found
 */
function writeSnapshotBody(io, dir, out, found) {
	const core = require("./arbiter-core");
	const { job } = snapshotJob(io, dir, out, found);
	fs.writeFileSync(
		path.join(out, "index.json"),
		`${JSON.stringify([job], null, 2)}\n`,
	);
	io.out(`snapshot: ${out}\n`);
	return writeHandOffBody(
		io,
		{ sessionId: job.sessionId, ticket: job.intent || "the ticket" },
		out,
		{
			head: [
				`${HANDED_OFF_HEAD} Session ${job.sessionId}${job.name ? ` (${job.name})` : ""} was resumed by its host and took no turn, nor after the loop's resume (#2659). The loop stopped it and released its claim; a ${FRESH_PICK_UP}`,
				`Its files stay uncommitted where it left them. Snapshot: ${path.relative(core.repoRoot(), out)}.`,
			].join(" "),
			done: job.commitsLanded?.join("; ") || "none",
			blockedOn:
				"nothing the loop could read: its host restarted it and it never took another turn",
			narrationFile: path.join(out, `${job.short}.narration.txt`),
		},
	);
}

/**
 * @param {BufferedIo} io
 * @param {{sessionId: string, ticket: string}} session
 * @param {string} out
 * @param {{head: string, done: string, blockedOn: string, narrationFile?: string}} parts
 */
function writeHandOffBody(
	io,
	{ sessionId, ticket },
	out,
	{ head, done, blockedOn, narrationFile },
) {
	const core = require("./arbiter-core");
	const { gitOrNull } = require("./git.js");
	const { buildHandOffComment } = require("./hand-off.js");
	const { readStrandedFiles } = require("./neighbour-dirt");
	const root = handOffTree(sessionId, core.repoRoot());
	const base = gitOrNull(["rev-parse", "HEAD"], { cwd: root })?.trim();
	if (!base) io.fail(`git would not read HEAD in ${root}. Nothing posted.`, 1);
	const files = readStrandedFiles(sessionId, root);
	const diff = files.map((f) => readUncommittedDiff(io, root, f)).join("");
	const narration =
		narrationFile && fs.existsSync(narrationFile)
			? fs.readFileSync(narrationFile, "utf8")
			: "";
	const hasNarration = narration.trim() !== "";
	const body = buildHandOffComment({
		head,
		narration,
		base,
		done,
		left: buildHandOffLeft(
			ticket,
			hasNarration ? "the narration's newest lines above" : null,
		),
		blockedOn,
		files,
		diff,
	});
	if (body !== null) return body;
	const diffFile = path.join(out, "uncommitted.diff");
	fs.writeFileSync(diffFile, diff);
	return `${head}\n\nIts uncommitted diff runs past GitHub's comment limit, so no hand-off block is posted: the diff is at ${path.relative(core.repoRoot(), diffFile)}, and the files are ${files.map((f) => `\`${f}\``).join(", ")}. Left: ${buildHandOffLeft(ticket, hasNarration ? "the newest lines of the snapshot's narration" : null)}.`;
}

/**
 * @param {string} sessionId
 * @param {string} host
 */
function handOffTree(sessionId, host) {
	const entries = require("./arbiter-store").readWriteEntriesBy(sessionId);
	return entries?.at(-1)?.tree ?? host;
}

/**
 * @param {BufferedIo} io
 * @param {string} root
 * @param {string} file
 */
function readUncommittedDiff(io, root, file) {
	const { spawnGitSync } = require("./git.js");
	const opts = { cwd: root, encoding: /** @type {const} */ ("utf8") };
	const diff =
		spawnGitSync(["diff", "HEAD", "--", file], opts).stdout ||
		spawnGitSync(["diff", "--no-index", "--", "/dev/null", file], opts).stdout;
	if (!diff)
		io.fail(`git would not diff ${file} in ${root}. Nothing posted.`, 1);
	return diff;
}

/**
 * @param {ParsedArgs} args
 * @param {RescuePorts} ports
 */
async function takeover(args, ports) {
	const { bufferedIo, collectIo } = require("./tracker-ops.js");
	const io = bufferedIo("rescue-sessions takeover");
	try {
		return await collectIo(io, () => takeOver(io, args, ports));
	} catch (e) {
		io.err(`rescue-sessions takeover: failed: ${caughtStack(e)}\n`);
		return io.result(1);
	}
}

/** @param {unknown} e */
const caughtStack = (e) => (e instanceof Error ? (e.stack ?? e) : e);

module.exports = {
	HAND_OFF_USAGE,
	handOff: entry(handOffJob, "rescue-sessions hand-off"),
	takeover,
};
