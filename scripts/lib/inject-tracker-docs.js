/*
 * inject-tracker-docs.js — the core of the hook that hands the issue-tracker
 * rules to the session about to run a tracker command (#5151). The hook entry,
 * scripts/inject-tracker-docs.js, wires the ports and writes what this returns.
 *
 * Each of its two events reads the command its own way:
 *   UserPromptSubmit — the command typed in a live session
 *   SessionStart     — a background job launched with the command as its
 *                      opening prompt, so no prompt is ever "submitted"; the
 *                      text is read from the job record's `intent` instead —
 *                      a race against the daemon writing it, which CLIs before
 *                      2.1.241 mostly lose, so UserPromptSubmit is what carries
 *                      them (mantahostels#1142; scripts/measure-sessionstart-intent/).
 *
 * LIMITS — this fires on the named slash commands only. An ad-hoc "open an
 * issue for X" typed in prose gets nothing, and cannot: that path has no
 * distinguishing shape.
 *
 * Never blocks: an unreadable payload or no command matched returns nothing.
 *
 * READ IN PLACE, NOT THROUGH PORTS (§T7): its Ports carry gh, the tier core's
 * spawn, the clock and the fail-open log. The filesystem stays real, as #2733's
 * boundary table rules it gets no fake, so this reads and writes it itself:
 * the job record's `intent`, the de-dup markers, the host's settings, config and rule texts, and the standards. It also
 * reads the env vars that say where those files are, since a port would only
 * pass one path string along and a test sets each one with vi.stubEnv:
 * CLAUDE_JOB_DIR, TMPDIR, and the roots hostRoot(), configDir() and coreRoot()
 * resolve. CLAUDE_CODE_SESSION_ID is read too, as the session id where the
 * payload carries none.
 *
 * THE NO-MATCH PATH REQUIRES NOTHING BEYOND THE TEXT MODULE. It runs on every
 * prompt, and the latency gate (#2733, bench.py --paired) reads it; the config, rule and review libraries load only once
 * a command has matched.
 */

const fs = require("node:fs");
const path = require("node:path");
const text = require("./tracker-inject-text.js");
const { trimEndRun, trimStartRun } = require("./trim-run.js");
const { escapeRe } = require("./regex-group.js");

/* What ends a `takes:` reference, and what leads one. */
const TOKEN_SEPARATORS = " \t\n\v\f\r,&+";

/**
 * @typedef {object} Ports
 * @property {(q: {issue: string, repo: string, cwd: string}) => string} takesLabel
 *   the issue's first `takes:` label, or "" where it has none or the read fails
 * @property {(q: {payload: string, cwd: string}) => string} reviewTier
 *   the inject-review-tier core's additionalContext for a Skill payload, or ""
 * @property {() => number} now epoch seconds
 * @property {(what: string, detail?: string) => void} log a fail-open record
 */

/**
 * Every payload field this hook reads. NULs and trailing newlines are dropped;
 * the unit separator from every field but the prompt. A payload that is not a
 * JSON object reads as all empty.
 * @param {string} stdin
 */
function parseFields(stdin) {
	/** @type {unknown} */
	let p = null;
	try {
		p = JSON.parse(stdin);
	} catch {
		/* unreadable: every field empty */
	}
	const obj =
		p !== null && typeof p === "object" && !Array.isArray(p)
			? /** @type {Record<string, unknown>} */ (p)
			: {};
	/** @param {string} k */
	const field = (k) => {
		const v = obj[k];
		return trimEndRun(asText(v).replaceAll("\u0000", ""), "\n");
	};
	/** @param {string} k */
	const bare = (k) => field(k).replaceAll("\u001f", "");
	return {
		agentId: bare("agent_id"),
		event: bare("hook_event_name"),
		source: bare("source"),
		session: bare("session_id"),
		cwd: bare("cwd"),
		prompt: field("prompt"),
	};
}

/**
 * A JSON value as text: null, false and absent are "", a string is itself,
 * anything else its JSON.
 * @param {unknown} v
 */
function asText(v) {
	if (v === undefined || v === null || v === false) return "";
	return typeof v === "string" ? v : JSON.stringify(v);
}

/**
 * A background job's opening prompt, recorded on the job as `intent`: where
 * the command is when SessionStart carries no prompt.
 * @param {string | undefined} jobDir
 */
function readJobIntent(jobDir) {
	if (!jobDir) return "";
	const file = path.join(jobDir, "state.json");
	if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile()) return "";
	try {
		const v = JSON.parse(fs.readFileSync(file, "utf8"));
		const intent = v?.intent ?? v?.detail ?? "";
		return trimEndRun(asText(intent), "\n");
	} catch {
		return "";
	}
}

/* [[:space:]] in the C locale, which `\s` is wider than. */
const SPACE = "[ \\t\\n\\v\\f\\r]";

/**
 * The first tracker command the prompt names, its plugin namespace and the
 * text after it. THE PLUGIN NAMESPACE IS OPTIONAL (#201): in an adopter the
 * command arrives as `/workflow-core:wayfinder`, and a miss drops the ENTIRE
 * payload silently. Any word is accepted as the prefix, as the plugin's name
 * is set by whoever ships it. name-issue-session.sh carries a copy of this
 * regex. RESIDUAL: a plugin naming itself with a `.` or an `@` matches nothing.
 * @param {string} prompt
 * @returns {{matched: string, ns: string, arg: string} | null}
 */
function matchCommand(prompt) {
	for (const cmd of text.COMMANDS) {
		const m = new RegExp(
			`(^|${SPACE})/([A-Za-z0-9_-]+:)?${escapeRe(cmd)}(${SPACE}|$)`,
		).exec(prompt);
		if (m)
			return {
				matched: cmd,
				ns: m[2] ?? "",
				arg: prompt.slice(m.index + m[0].length),
			};
	}
	return null;
}

/**
 * The issue a takes-reading command names first, split from the rest as
 * name-issue-session.sh splits them — keep the two in step: a URL's own repo
 * and number, or a bare or `#`-prefixed number.
 * @param {string} arg
 * @returns {{issue: string, repo: string}}
 */
function takesReference(arg) {
	const rest = trimStartRun(arg, TOKEN_SEPARATORS);
	const end = rest.search(/[ \t\n\v\f\r,&+]/);
	const token = (end === -1 ? rest : rest.slice(0, end)).replace(/[.,;:]$/, "");
	const url =
		/^https?:\/\/github\.com\/([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)\/issues\/([0-9]+)([/?#].*)?$/s.exec(
			token,
		);
	if (url) return { repo: url[1] ?? "", issue: url[2] ?? "" };
	const bare = /^#?([0-9]+)$/.exec(token);
	return { repo: "", issue: bare?.[1] ?? "" };
}

/* The pair the de-duplication drops: SessionStart reads the command off the
 * job record's `intent`, then the same text arrives as a submitted prompt
 * (https://github.com/lucmoseley/workflow-core-tracker/blob/0a69e0d4be03/docs/research/tracker-injection-frequency.md, mantahostels#1083).
 *
 * The key is the SESSION and the COMMAND, not the prompt: the payload is a
 * function of which command matched and of the first issue's `takes:` label.
 * The marker holds that issue's number, and a firing naming another issue is
 * no duplicate (#1164).
 *
 * Every failure path INJECTS: under-injecting silently drops the tracker
 * rules, which mantahostels#645, mantahostels#646, mantahostels#702 and
 * mantahostels#706 exist to prevent.
 *
 * Residuals. (1) Two session ids differing only in a character the sanitiser
 * strips share one marker. Unobserved: the ids are uuids. (2) Only the window
 * discriminates within a source, so a session that really does re-invoke the
 * same command inside 60 s gets no second copy. 60 is a guess: wide of the pair's observed gap, narrow of a re-typed command. */
const DEDUPE_WINDOW_S = 60;

/* Markers would otherwise accumulate for the life of the host. Any threshold
 * above the window is correct. */
const SWEEP_AGE_S = 24 * 60 * 60;

/**
 * Scratch state, but not this hook's alone (mantahostels#2769):
 * concision-backstop.sh reads the `.implement` marker at Stop to decide
 * whether a session's code-review floor is 20 changed lines or none, so this
 * name, its sanitiser, the compact/clear/resume exclusion and the 24-hour
 * sweep all decide whether a review is demanded. Only
 * concision-backstop-floor.test.ts's "reads the marker inject-tracker-docs.js
 * actually writes" pins the path.
 *
 * Keyed per session outside the repo. The session id reaches the filesystem
 * as a path segment, so anything not a plain identifier is stripped. The
 * directory is suffixed with the uid: a fixed path under a shared /tmp is one
 * another account can have created first, and the sweep runs inside it.
 * @param {string} session @param {string} matched
 * @returns {{dir: string, file: string} | null}
 */
function markerFor(session, matched) {
	if (!session) return null;
	const dir = path.join(
		process.env.TMPDIR || "/tmp",
		`wfc-tracker-inject-${process.getuid?.() ?? 0}`,
	);
	try {
		fs.mkdirSync(dir, { recursive: true });
	} catch {
		return null;
	}
	return {
		dir,
		file: path.join(
			dir,
			`${session.replace(/[^A-Za-z0-9_-]/g, "_")}.${matched}`,
		),
	};
}

/**
 * Whether a live marker says this firing is the second half of the pair. A
 * marker dated AHEAD of now is no duplicate, which an unsigned reading of the window would
 * treat as recent forever. A stale or unreadable one is removed, and where it
 * cannot be, the de-duplication is off for this firing: left in place it
 * would win the reservation and the session would get nothing.
 * @param {{dir: string, file: string}} marker @param {string} takesIssue @param {number} now
 * @returns {"duplicate" | "clear" | "off"}
 */
function settleMarker(marker, takesIssue, now) {
	const st = fs.statSync(marker.file, { throwIfNoEntry: false });
	if (!st?.isFile()) return "clear";
	const stamp = Math.floor(st.mtimeMs / 1000);
	if (stamp <= now && now - stamp < DEDUPE_WINDOW_S) {
		let held = null;
		try {
			held = fs.readFileSync(marker.file, "utf8");
		} catch {
			/* unreadable: no match */
		}
		if (held === takesIssue) return "duplicate";
	}
	try {
		fs.rmSync(marker.file, { force: true });
		return "clear";
	} catch {
		return "off";
	}
}

/**
 * Take the marker. The pair can land inside one hook process's own runtime
 * (mantahostels#1117), so the early check is an exit only: creating the marker
 * exclusively is what makes exactly one firing the winner, and the loser
 * returns having printed nothing.
 * @param {{dir: string, file: string}} marker @param {string} takesIssue @param {number} now
 */
function reserve(marker, takesIssue, now) {
	try {
		fs.writeFileSync(marker.file, takesIssue, { flag: "wx" });
	} catch {
		return false;
	}
	try {
		/* Stamped by the port's clock, which the window is read against. */
		fs.utimesSync(marker.file, now, now);
		for (const name of fs.readdirSync(marker.dir)) {
			const f = path.join(marker.dir, name);
			const st = fs.statSync(f, { throwIfNoEntry: false });
			if (st?.isFile() && now - st.mtimeMs / 1000 > SWEEP_AGE_S)
				fs.rmSync(f, { force: true });
		}
	} catch {
		/* a sweep that fails costs only disk */
	}
	return true;
}

/**
 * Whether the session's output style is Core voice (#2039): the first
 * `outputStyle` in the harness's precedence, project-local, project, then
 * user settings; managed settings are not read.
 * @param {string} root @param {string} configDir
 */
function coreVoiceLoaded(root, configDir) {
	const { CORE_STYLE } = require("./output-styles.js");
	for (const f of [
		path.join(root, ".claude", "settings.local.json"),
		path.join(root, ".claude", "settings.json"),
		path.join(configDir, "settings.json"),
	]) {
		let style;
		try {
			style = JSON.parse(fs.readFileSync(f, "utf8"))?.outputStyle;
		} catch {
			continue;
		}
		if (typeof style === "string")
			return style === CORE_STYLE || style === `workflow-core:${CORE_STYLE}`;
	}
	return false;
}

/** The priced-options text this host gets: Core voice's pointer, or the whole
 * shape naming the host's declared output style (#448). */
function pricedOptionsFor() {
	const { hostRoot } = require("./host-root.js");
	const { configDir } = require("./config-dir.js");
	const { readOutputStylePath } = require("./workflow-core-config.js");
	const root = hostRoot();
	if (coreVoiceLoaded(root, configDir())) return text.PRICED_OPTIONS_POINTER;
	return text.pricedOptionsWhole(
		readOutputStylePath({ root, say: () => undefined }),
	);
}

/**
 * The review tier a declared sensitive path owes (#1697): the dispatcher's
 * inject-review-tier core fires on the Skill tool alone, so a typed
 * /code-review is run through it here, on the payload that call would carry.
 * A bare typed name goes namespaced: the tier core passes over a bare
 * `code-review` where the host has no local skill (#1165), but a typed
 * command is never refused (#1746). The cwd rides too: the tier core reads a
 * worktree the session works in from it (#2386).
 * @param {Ports} ports @param {string} session @param {string} ns @param {string} cwd
 */
function readTier(ports, session, ns, cwd) {
	const payload = JSON.stringify({
		hook_event_name: "PreToolUse",
		tool_name: "Skill",
		tool_input: { skill: `${ns || "workflow-core:"}code-review` },
		session_id: session,
		cwd,
	});
	return ports.reviewTier({ payload, cwd });
}

/**
 * /code-review's rules.
 * @param {Ports} ports @param {string} session @param {string} pricedOptions
 */
function codeReviewRules(ports, session, pricedOptions) {
	const { hostRoot } = require("./host-root.js");
	const { coreRoot } = require("./script-path.js");
	const rs = require("./review-standards.js");
	const { reviewSuffix } = require("./review-suffix.js");
	const { reviewAgentType } = require("./review-agent-type.js");
	const { fragmentLookup } = require("./rule-text.js");
	const host = hostRoot();
	const core = coreRoot();
	const glossary = rs.standardsGlossary(host);
	const read = fragmentLookup(host);
	return text.codeReviewRules(
		{
			standardsState: rs.standardsState(core, host),
			standardsBase: rs.standardsShown(rs.standardsBase(core), host),
			glossary: glossary === null ? null : rs.standardsShown(glossary, host),
			reviewType: reviewAgentType(host),
			sidSuffix: session ? reviewSuffix(session) : "",
			fragment: (id) => {
				const body = read(id);
				if (body === "" && id === "review-dispatch-shape")
					ports.log(
						"rule:review-dispatch-shape unreadable — /code-review named its path instead",
					);
				return body;
			},
		},
		pricedOptions,
	);
}

/** A missing standards base is logged, and only a missing one (#965).
 * @param {Ports} ports */
function logMissingBase(ports) {
	const { coreRoot } = require("./script-path.js");
	const missing = require("./review-standards.js").missingBase(coreRoot());
	if (missing) ports.log(missing.what, missing.detail);
}

/**
 * The de-dup marker this firing may take: its path, null where none is kept,
 * or "duplicate" where the session already holds the payload. A SessionStart
 * that is not a startup is a session whose context was cleared or summarised
 * away, so it does NOT still hold the payload.
 * @param {{source: string, session: string, matched: string, takesIssue: string, now: number}} firing
 * @returns {ReturnType<typeof markerFor> | "duplicate"}
 */
function openMarker({ source, session, matched, takesIssue, now }) {
	if (["compact", "clear", "resume"].includes(source)) return null;
	const marker = markerFor(session, matched);
	if (!marker) return null;
	const state = settleMarker(marker, takesIssue, now);
	if (state === "duplicate") return "duplicate";
	return state === "off" ? null : marker;
}

/**
 * What the hook prints for one payload: the hook output carrying the
 * context, or "" where it injects nothing.
 * @param {string} stdin @param {Ports} ports
 */
function injectTrackerDocs(stdin, ports) {
	const f = parseFields(stdin);
	// A subagent's payload names its parent's session, whose command is not
	// the subagent's (#1785).
	if (f.agentId) return "";
	const prompt = f.prompt || readJobIntent(process.env.CLAUDE_JOB_DIR);
	if (!prompt) return "";
	const hit = matchCommand(prompt);
	if (!hit) return "";
	const { matched, ns } = hit;
	const { issue: takesIssue, repo: takesRepo } = text.TAKES_READ.includes(
		matched,
	)
		? takesReference(hit.arg)
		: { issue: "", repo: "" };

	const session = f.session || process.env.CLAUDE_CODE_SESSION_ID || "";
	const now = ports.now();
	const opened = openMarker({
		source: f.source,
		session,
		matched,
		takesIssue,
		now,
	});
	if (opened === "duplicate") return "";
	let marker = opened;

	/** The marker is taken once, after the text exists. */
	const take = () => {
		const ok = marker === null || reserve(marker, takesIssue, now);
		marker = null;
		return ok;
	};
	/** @param {string} context */
	const emit = (context) => {
		const { resolveScriptPaths } = require("./script-path.js");
		const c = resolveScriptPaths(context);
		const out =
			f.event === "UserPromptSubmit" || f.event === "SessionStart"
				? JSON.stringify(
						require("./hook-envelope.js").envelope(f.event, {
							additionalContext: c,
						}),
					)
				: c;
		return take() ? `${out}\n` : "";
	};

	let otherTakes = "";
	if (takesIssue)
		otherTakes = ports
			.takesLabel({ issue: takesIssue, repo: takesRepo, cwd: f.cwd })
			.replace(/^takes:/, "");
	if (otherTakes === matched) otherTakes = "";

	const pricedOptions = pricedOptionsFor();

	if (matched === "code-review") {
		logMissingBase(ports);
		/* Reserved before the tier read, which latches its rules as told, so a
		 * losing duplicate never runs it. */
		if (!take()) return "";
		const rules = codeReviewRules(ports, session, pricedOptions);
		const { HOOK_PERSIST_CHARS } = require("./hook-limits.js");
		return emit(
			text.codeReviewContext(
				rules,
				readTier(ports, session, ns, f.cwd),
				HOOK_PERSIST_CHARS,
			),
		);
	}

	return emit(
		text.trackerContext({
			matched,
			takesIssue,
			otherTakes,
			pricedOptions,
			claimIssue: require("./build-arbiter-command.js")
				.buildArbiterCommand`claim-issue <n>`,
		}),
	);
}

module.exports = { injectTrackerDocs };
