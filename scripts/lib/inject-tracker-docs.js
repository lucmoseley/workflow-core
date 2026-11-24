const fs = require("node:fs");
const path = require("node:path");
const { ignoreFailure, orFallback } = require("./caught.js");
const { readText } = require("./file-read.js");
const text = require("./tracker-inject-text.js");
const { trimEndRun, trimStartRun } = require("./trim-run.js");
const { escapeRe } = require("./regex-group.js");
const { readJobDir } = require("./job-paths.js");

const TOKEN_SEPARATORS = " \t\n\v\f\r,&+";

/**
 * @typedef {object} Ports
 * @property {(q: {issue: string, repo: string, cwd: string}) => string} takesLabel
 * @property {(q: {payload: string, cwd: string}) => string} reviewTier
 * @property {() => number} now
 * @property {(what: string, detail?: string) => void} log
 * @property {NodeJS.ProcessEnv} env
 */

/** @param {string} stdin */
function parseFields(stdin) {
	/** @type {unknown} */
	const p = orFallback(() => JSON.parse(stdin), null);
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

/** @param {unknown} v */
function asText(v) {
	if (v === undefined || v === null || v === false) return "";
	return typeof v === "string" ? v : JSON.stringify(v);
}

/** @param {string | null} jobDir */
function readJobIntent(jobDir) {
	if (jobDir === null) return "";
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

const SPACE = "[ \\t\\n\\v\\f\\r]";

/**
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

// guess, lucmoseley/mantahostels#1083: wide of the start/prompt pair's gap, narrow of a re-typed command
const DEDUPE_WINDOW_S = 60;

// guess, workflow-core#5151
const SWEEP_AGE_S = 24 * 60 * 60;

/**
 * @param {string} session
 * @param {string} matched
 * @param {string | undefined} tmpRoot
 * @returns {{dir: string, file: string} | null}
 */
function markerFor(session, matched, tmpRoot) {
	if (!session) return null;
	const dir = path.join(
		tmpRoot || "/tmp",
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
 * @param {{dir: string, file: string}} marker
 * @param {string} takesIssue
 * @param {number} now
 * @returns {"duplicate" | "clear" | "off"}
 */
function settleMarker(marker, takesIssue, now) {
	const st = fs.statSync(marker.file, { throwIfNoEntry: false });
	if (!st?.isFile()) return "clear";
	const stamp = Math.floor(st.mtimeMs / 1000);
	if (stamp <= now && now - stamp < DEDUPE_WINDOW_S) {
		const held = readText(marker.file);
		if (held.state === "read" && held.data === takesIssue) return "duplicate";
	}
	try {
		fs.rmSync(marker.file, { force: true });
		return "clear";
	} catch {
		return "off";
	}
}

/**
 * @param {{dir: string, file: string}} marker
 * @param {string} takesIssue
 * @param {number} now
 */
function reserve(marker, takesIssue, now) {
	try {
		fs.writeFileSync(marker.file, takesIssue, { flag: "wx" });
	} catch {
		return false;
	}
	ignoreFailure(() => {
		fs.utimesSync(marker.file, now, now);
		for (const name of fs.readdirSync(marker.dir)) {
			const f = path.join(marker.dir, name);
			const st = fs.statSync(f, { throwIfNoEntry: false });
			if (st?.isFile() && now - st.mtimeMs / 1000 > SWEEP_AGE_S)
				fs.rmSync(f, { force: true });
		}
	});
	return true;
}

/**
 * @param {string} root
 * @param {string} configDir
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

/** @param {NodeJS.ProcessEnv} env */
function pricedOptionsFor(env) {
	const { hostRoot } = require("./host-root.js");
	const { configDirFrom } = require("./config-dir.js");
	const { readOutputStylePath } = require("./workflow-core-config.js");
	const root = hostRoot(undefined, { env });
	if (coreVoiceLoaded(root, configDirFrom(env.CLAUDE_CONFIG_DIR)))
		return text.PRICED_OPTIONS_POINTER;
	return text.pricedOptionsWhole(
		readOutputStylePath({ root, env, say: () => undefined }),
	);
}

/**
 * @param {Ports} ports
 * @param {string} session
 * @param {string} ns
 * @param {string} cwd
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
 * @param {Ports} ports
 * @param {string} session
 * @param {string} pricedOptions
 */
function codeReviewRules(ports, session, pricedOptions) {
	const { hostRoot } = require("./host-root.js");
	const { coreRoot } = require("./script-path.js");
	const rs = require("./review-standards.js");
	const { reviewSuffix } = require("./review-suffix.js");
	const { reviewAgentType } = require("./review-agent-type.js");
	const { fragmentLookup } = require("./rule-text.js");
	const host = hostRoot(undefined, { env: ports.env });
	const core = coreRoot(ports.env);
	const glossary = rs.standardsGlossary(host);
	const read = fragmentLookup(host, ports.env);
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

/** @param {Ports} ports */
function logMissingBase(ports) {
	const { coreRoot } = require("./script-path.js");
	const missing = require("./review-standards.js").missingBase(
		coreRoot(ports.env),
	);
	if (missing) ports.log(missing.what, missing.detail);
}

/**
 * @param {{source: string, session: string, matched: string, takesIssue: string, now: number, tmpRoot: string | undefined}} firing
 * @returns {ReturnType<typeof markerFor> | "duplicate"}
 */
function openMarker({ source, session, matched, takesIssue, now, tmpRoot }) {
	if (["compact", "clear", "resume"].includes(source)) return null;
	const marker = markerFor(session, matched, tmpRoot);
	if (!marker) return null;
	const state = settleMarker(marker, takesIssue, now);
	if (state === "duplicate") return "duplicate";
	return state === "off" ? null : marker;
}

/**
 * @param {string} stdin
 * @param {Ports} ports
 */
function injectTrackerDocs(stdin, ports) {
	const f = parseFields(stdin);
	if (f.agentId) return "";
	const prompt = f.prompt || readJobIntent(readJobDir(ports.env));
	if (!prompt) return "";
	const hit = matchCommand(prompt);
	if (!hit) return "";
	const { matched, ns } = hit;
	const { issue: takesIssue, repo: takesRepo } = text.TAKES_READ.includes(
		matched,
	)
		? takesReference(hit.arg)
		: { issue: "", repo: "" };

	const session = f.session || ports.env.CLAUDE_CODE_SESSION_ID || "";
	const now = ports.now();
	const opened = openMarker({
		source: f.source,
		session,
		matched,
		takesIssue,
		now,
		tmpRoot: ports.env.TMPDIR,
	});
	if (opened === "duplicate") return "";
	let marker = opened;

	const take = () => {
		const ok = marker === null || reserve(marker, takesIssue, now);
		marker = null;
		return ok;
	};
	/** @param {string} context */
	const emit = (context) => {
		const { resolveScriptPaths } = require("./script-path.js");
		const c = resolveScriptPaths(context, ports.env);
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

	const pricedOptions = pricedOptionsFor(ports.env);

	if (matched === "code-review") {
		logMissingBase(ports);
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
			claimIssue: require("./build-arbiter-command.js").buildArbiterCommandIn(
				ports.env,
			)`claim-issue <n>`,
		}),
	);
}

module.exports = { injectTrackerDocs };
