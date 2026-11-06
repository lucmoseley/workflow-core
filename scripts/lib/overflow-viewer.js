/*
 * overflow-viewer.js — the founder's terminal view of the overflow seats'
 * headless runs (#4583), laid out as `claude agents` lays out plan sessions:
 * a row per session in three sections, a session's thread followed live, and
 * a reply line. A plan's included API credits cover `claude -p` alone, never a
 * `--bg` job (#4578), so these runs never reach the agents view.
 *
 * A SESSION is every run in lib/headless-runs.js's store sharing a session id:
 * a resume, the founder's reply or the loop's, is a new run of the same
 * session. Its latest run gives its state:
 *   working         that run's pid alive with its recorded start time;
 *   awaiting input  ended, its last assistant text ending on `needs input:`;
 *   completed       any other ended run.
 *
 * Node built-ins only: raw-mode stdin read by lib/refill-panel-input.js, ANSI
 * out on the alternate screen, handed back on every exit a process can catch.
 */

const { readLiveAgents, readStoredRuns } = require("./headless-runs.js");
const { readJsonl } = require("./jsonl.js");
const { ESC, createInputReader } = require("./refill-panel-input.js");
const {
	DEFAULT_COLUMNS,
	DEFAULT_ROWS,
	ESCAPE_WAIT_MS,
	holdTerminal,
} = require("./terminal-hold.js");

/** @typedef {import("./headless-runs.js").RunRecord} RunRecord */
/** @typedef {import("./refill-panel-input.js").Key} Key */
/** @typedef {"awaiting"|"working"|"completed"} SessionState */
/**
 * @typedef {object} Session
 * @property {string} sessionId
 * @property {string} name its first run's prompt
 * @property {SessionState} state
 * @property {string} last its last assistant text
 * @property {RunRecord[]} runs oldest first
 * @property {RunRecord} latest
 *
 * @typedef {{kind: string, text: string}} RunEvent
 */

/* A completed session whose latest run started longer ago than this is not
 * shown; one awaiting input always is. Untraced. */
const ENDED_WINDOW_MS = 48 * 60 * 60 * 1000;
/* Untraced: a run's messages a few seconds late read fine on a terminal. */
const POLL_MS = 3000;
/* A session's name where a status line quotes it, leaving the line room for
 * what happened. Untraced, a first guess. */
const NAME_IN_STATUS = 40;
/* Bracketed paste on, so a pasted reply's newlines never send it. */
const SCREEN_ON = `${ESC}[?1049h${ESC}[?25l${ESC}[?2004h`;
const SCREEN_OFF = `${ESC}[?2004l${ESC}[?25h${ESC}[?1049l`;
const CLEAR = `${ESC}[2J`;
const BOLD = `${ESC}[1m`;
const INVERSE = `${ESC}[7m`;
const RESET = `${ESC}[0m`;

/** @type {SessionState[]} */
const SECTIONS = ["awaiting", "working", "completed"];
/** @type {Record<SessionState, string>} */
const SECTION_TITLES = {
	awaiting: "AWAITING INPUT",
	working: "WORKING",
	completed: "COMPLETED",
};
/** @type {Record<SessionState, string>} */
const STATE_WORDS = {
	awaiting: "awaiting input",
	working: "working",
	completed: "completed",
};
/* The state column fits its longest word. */
const STATE_WIDTH = Math.max(
	...Object.values(STATE_WORDS).map((w) => w.length),
);
/* A row's mark and its space, then two spaces before each later column. */
const ROW_GUTTERS = 6;
const HINTS = {
	list: "↑↓ select · Enter open · Space reply · x stop · q quit",
	thread: "← back · ↑↓ scroll · End follow · Space reply · x stop · q quit",
	draft: "Enter send · Esc cancel",
};

/** @param {string} s @param {number} n */
const clip = (s, n) => {
	const one = s.replace(/\s+/g, " ").trim();
	return one.length > n ? `${one.slice(0, Math.max(0, n - 1))}…` : one;
};

/** @param {string} s @param {number} n */
const pad = (s, n) => clip(s, n).padEnd(n);

/* `any` in these: a stream-json row is the CLI's undocumented shape, read by
 * optional fields alone. */
/**
 * @param {Record<string, any>} input
 * @returns {string}
 */
const toolSummary = (input) =>
	String(
		input.command ??
			input.description ??
			input.file_path ??
			input.pattern ??
			"",
	);

/**
 * The readable events of one stream-json line.
 * @param {Record<string, any>} o
 * @returns {RunEvent[]}
 */
function lineEvents(o) {
	if (o.type === "result")
		return [
			{
				kind: "end",
				text: `${o.subtype}${o.is_error ? " (error)" : ""}`,
			},
		];
	if (o.type !== "assistant") return [];
	return (o.message?.content ?? []).flatMap(
		(/** @type {Record<string, any>} */ c) => {
			if (c.type === "text" && c.text.trim())
				return [{ kind: "says", text: c.text.trim() }];
			if (c.type === "tool_use")
				return [{ kind: c.name, text: toolSummary(c.input ?? {}) }];
			return [];
		},
	);
}

/**
 * A run's readable events: text, tool calls, its end.
 * @param {string} log
 * @returns {RunEvent[]}
 */
function readEvents(log) {
	return (readJsonl(log)?.rows ?? []).flatMap((o) => lineEvents(o));
}

/** @param {RunEvent[]} evs */
const lastSaid = (evs) => evs.findLast((e) => e.kind === "says")?.text ?? "";

/** @param {string} said */
const isAskingFounder = (said) =>
	/^needs input:/i.test(said.trim().split("\n").at(-1)?.trim() ?? "");

/**
 * The sessions to show, by section, then newest first.
 * @param {RunRecord[]} runs
 * @param {Set<string>} live the live runs' job ids
 * @param {(log: string) => RunEvent[]} eventsOf
 * @param {number} now ms
 * @returns {Session[]}
 */
function buildSessions(runs, live, eventsOf, now) {
	/** @type {Map<string, {runs: RunRecord[], first: RunRecord, latest: RunRecord}>} */
	const bySession = new Map();
	for (const r of [...runs].sort((x, y) => x.launchedAt - y.launchedAt)) {
		const group = bySession.get(r.sessionId);
		if (group) {
			group.runs.push(r);
			group.latest = r;
		} else bySession.set(r.sessionId, { runs: [r], first: r, latest: r });
	}
	/** @type {Session[]} */
	const sessions = [];
	for (const [sessionId, { runs: own, first, latest }] of bySession) {
		const working = live.has(latest.jobId);
		const said = lastSaid(eventsOf(latest.log));
		const asking = !working && isAskingFounder(said);
		if (!working && !asking && now - latest.launchedAt > ENDED_WINDOW_MS)
			continue;
		/* A resume that has said nothing yet shows what the session said last. */
		const last =
			said || lastSaid(own.slice(0, -1).flatMap((r) => eventsOf(r.log)));
		/** @type {SessionState} */
		let state = "completed";
		if (working) state = "working";
		else if (asking) state = "awaiting";
		sessions.push({
			sessionId,
			name: first.prompt || first.jobId,
			state,
			last,
			runs: own,
			latest,
		});
	}
	return sessions.sort(
		(a, b) =>
			SECTIONS.indexOf(a.state) - SECTIONS.indexOf(b.state) ||
			b.latest.launchedAt - a.latest.launchedAt,
	);
}

/**
 * The store's sessions now.
 * @returns {Session[]}
 * @throws where the store or a record cannot be read
 */
function readSessions() {
	const live = new Set(readLiveAgents().map((a) => a.id));
	return buildSessions(readStoredRuns(), live, readEvents, Date.now());
}

/**
 * A session's thread: each run's prompt, then what it did.
 * @param {Session} session
 * @returns {RunEvent[]}
 */
function readThread(session) {
	return session.runs.flatMap((r) => [
		{ kind: "prompt", text: r.prompt || "(no prompt recorded)" },
		...readEvents(r.log),
	]);
}

/**
 * The list's lines: each section's title, then its rows.
 * @param {Session[]} sessions
 * @param {string|null} selected session id
 * @param {number} columns
 * @param {boolean} styled
 * @returns {{lines: string[], selectedLine: number}}
 */
function buildListLines(sessions, selected, columns, styled) {
	/* Untraced: 30% of the width, at least a job id and at most a status
	 * line's quote of it. */
	const nameWidth = Math.max(
		12,
		Math.min(NAME_IN_STATUS, Math.floor(columns * 0.3)),
	);
	const lastWidth = Math.max(
		0,
		columns - nameWidth - STATE_WIDTH - ROW_GUTTERS,
	);
	/** @type {string[]} */
	const lines = [];
	let selectedLine = -1;
	for (const section of SECTIONS) {
		const own = sessions.filter((s) => s.state === section);
		const title = clip(`${SECTION_TITLES[section]} · ${own.length}`, columns);
		lines.push(styled ? `${BOLD}${title}${RESET}` : title);
		for (const s of own) {
			const mark = s.sessionId === selected ? ">" : " ";
			const row =
				`${mark} ${pad(s.name, nameWidth)}  ${pad(STATE_WORDS[s.state], STATE_WIDTH)}  ${clip(s.last, lastWidth)}`.slice(
					0,
					columns,
				);
			if (s.sessionId === selected) selectedLine = lines.length;
			lines.push(
				styled && s.sessionId === selected ? `${INVERSE}${row}${RESET}` : row,
			);
		}
		lines.push("");
	}
	return { lines, selectedLine };
}

/**
 * @param {string} text
 * @param {number} width
 * @returns {string[]}
 */
function wrap(text, width) {
	const w = Math.max(1, width);
	return text.split("\n").flatMap((para) => {
		const one = para.replace(/\s+$/, "");
		if (one === "") return [""];
		/** @type {string[]} */
		const out = [];
		for (let i = 0; i < one.length; i += w) out.push(one.slice(i, i + w));
		return out;
	});
}

/**
 * A thread's lines, oldest first.
 * @param {RunEvent[]} events
 * @param {number} columns
 * @returns {string[]}
 */
function buildThreadLines(events, columns) {
	return events.flatMap((e) => {
		if (e.kind === "prompt") return ["", ...wrap(`▶ ${e.text}`, columns), ""];
		if (e.kind === "says") return [...wrap(e.text, columns), ""];
		if (e.kind === "end") return [clip(`── ended ${e.text}`, columns)];
		return [`  ${clip(`[${e.kind}] ${e.text}`, columns - 2)}`];
	});
}

/**
 * The view's state and what each key does to it. `reply` and `stop` act on a
 * session's latest run; `onChange` draws, and is called before either acts,
 * as each can take seconds.
 * @param {{readSessions: () => Session[],
 *   readThread: (s: Session) => RunEvent[],
 *   reply: (run: RunRecord, text: string) => {jobId: string}|{why: string},
 *   stop: (run: RunRecord) => {ok: true, said: string}|{ok: false, why: string},
 *   quit: () => void, onChange: () => void}} io
 */
function createViewer(io) {
	/** @type {Session[]} */
	let sessions = [];
	/** @type {string|null} */
	let selected = null;
	let selectedIndex = 0;
	/** @type {"list"|"thread"} */
	let mode = "list";
	/** @type {RunEvent[]} */
	let thread = [];
	/* Thread lines held below the screen; 0 follows the end. */
	let scrollUp = 0;
	/** @type {string|null} */
	let draft = null;
	let confirming = false;
	let notice = "";

	const current = () =>
		sessions.find((one) => one.sessionId === selected) ?? null;

	const refresh = () => {
		try {
			sessions = io.readSessions();
		} catch (err) {
			/* #4583: a store read failing mid-write must not close the view; the
			 * last list stays up, the fault named, until a poll reads again. */
			notice = `overflow sessions unreadable: ${err instanceof Error ? err.message : err}`;
		}
		if (!current()) {
			selectedIndex = Math.min(selectedIndex, sessions.length - 1);
			selected = sessions[Math.max(0, selectedIndex)]?.sessionId ?? null;
		}
		selectedIndex = Math.max(
			0,
			sessions.findIndex((one) => one.sessionId === selected),
		);
		const s = current();
		if (mode === "thread") {
			if (s) thread = io.readThread(s);
			else mode = "list";
		}
	};

	/** @param {number} by */
	const move = (by) => {
		if (sessions.length === 0) return;
		selectedIndex = Math.min(
			sessions.length - 1,
			Math.max(0, selectedIndex + by),
		);
		selected = sessions[selectedIndex]?.sessionId ?? null;
	};

	const openReply = () => {
		const s = current();
		if (!s) return;
		if (s.state === "working")
			notice = `${clip(s.name, NAME_IN_STATUS)}: still working, reply once it ends`;
		else draft = "";
	};

	const send = () => {
		const text = draft ?? "";
		const s = current();
		if (!text.trim()) return;
		draft = null;
		if (!s || s.state === "working") {
			notice = "not sent: the session is working again";
			return;
		}
		notice = `sending to ${clip(s.name, NAME_IN_STATUS)}…`;
		io.onChange();
		const out = io.reply(s.latest, text);
		notice =
			"why" in out
				? `not sent: ${out.why}`
				: `sent: ${clip(s.name, NAME_IN_STATUS)} resumed as job ${out.jobId}`;
		refresh();
	};

	const askStop = () => {
		const s = current();
		if (!s) return;
		if (s.state === "working") confirming = true;
		else notice = `${clip(s.name, NAME_IN_STATUS)} is not running`;
	};

	/** @param {Key} key */
	const pressConfirm = (key) => {
		confirming = false;
		const s = current();
		if (!s || !("text" in key) || key.text !== "y") {
			notice = "kept running";
			return;
		}
		notice = `stopping ${clip(s.name, NAME_IN_STATUS)}…`;
		io.onChange();
		const out = io.stop(s.latest);
		notice = out.ok ? out.said : `not stopped: ${out.why}`;
		refresh();
	};

	/** @param {Key} key */
	const pressDraft = (key) => {
		if ("text" in key) draft = `${draft ?? ""}${key.text}`;
		else if (key.name === "backspace") draft = (draft ?? "").slice(0, -1);
		else if (key.name === "escape") draft = null;
		else if (key.name === "enter") send();
	};

	/** @param {{text: string, pasted?: boolean}} key */
	const pressCommand = ({ text, pasted }) => {
		if (pasted) return;
		if (text === " ") openReply();
		else if (text === "x") askStop();
		else if (text === "q") io.quit();
	};

	/** @param {string} name */
	const pressList = (name) => {
		const s = current();
		if (name === "up") move(-1);
		else if (name === "down") move(1);
		else if (name === "enter" && s) {
			mode = "thread";
			scrollUp = 0;
			thread = io.readThread(s);
		}
	};

	/** @param {string} name */
	const pressThread = (name) => {
		if (name === "left" || name === "escape") mode = "list";
		else if (name === "up") scrollUp += 1;
		else if (name === "down") scrollUp = Math.max(0, scrollUp - 1);
		else if (name === "end") scrollUp = 0;
		else if (name === "home") scrollUp = Number.MAX_SAFE_INTEGER;
	};

	/** @param {Key} key */
	const route = (key) => {
		if (confirming) pressConfirm(key);
		else if (draft !== null) pressDraft(key);
		else if ("text" in key) pressCommand(key);
		else if (mode === "list") pressList(key.name);
		else pressThread(key.name);
	};

	/** @param {Key} key */
	const pressKey = (key) => {
		/* A run of typed characters arrives as one key; each acts alone, as
		 * Space opens the line the rest is typed into. */
		const keys =
			"text" in key ? [...key.text].map((ch) => ({ ...key, text: ch })) : [key];
		for (const one of keys) {
			notice = "";
			route(one);
		}
		io.onChange();
	};

	/**
	 * @param {number} columns
	 * @param {number} rows
	 * @returns {string[]}
	 */
	const buildLines = (columns, rows) => {
		const s = current();
		const name = clip(s?.name ?? "", NAME_IN_STATUS);
		let status = notice;
		if (confirming)
			status = `Stop ${name}? y stop it · any other key keeps it running`;
		else if (draft !== null) status = `reply to ${name}> ${draft}█`;
		const hint = draft === null ? HINTS[mode] : HINTS.draft;
		const bodyRows = Math.max(1, rows - 4);
		/** @type {string[]} */
		let body;
		let title;
		if (mode === "thread" && s) {
			title = `${s.name} · ${STATE_WORDS[s.state]}`;
			const all = buildThreadLines(thread, columns);
			scrollUp = Math.min(scrollUp, Math.max(0, all.length - bodyRows));
			body = all.slice(
				Math.max(0, all.length - bodyRows - scrollUp),
				all.length - scrollUp,
			);
		} else {
			title = `Overflow sessions · ${sessions.length}`;
			const { lines, selectedLine } = buildListLines(
				sessions,
				selected,
				columns,
				true,
			);
			const top = Math.max(0, selectedLine - bodyRows + 1);
			body = lines.slice(top, top + bodyRows);
		}
		while (body.length < bodyRows) body.push("");
		return [
			`${BOLD}${clip(title, columns)}${RESET}`,
			"",
			...body,
			clip(status, columns),
			clip(hint, columns),
		];
	};

	return {
		refresh,
		pressKey,
		buildLines,
	};
}

/**
 * Runs the view until the process exits, through `proc.exit`. Returns its
 * close, which stops the poll and hands the terminal back.
 * @param {{stdin: Pick<import("node:tty").ReadStream, "setRawMode"|"resume"|"setEncoding"|"on">,
 *   stdout: Pick<import("node:tty").WriteStream, "write"|"on"|"columns"|"rows">,
 *   proc: Pick<import("node:events").EventEmitter, "on"> & {exit: (code: number) => void},
 *   reply: (run: RunRecord, text: string) => {jobId: string}|{why: string},
 *   stop: (run: RunRecord) => {ok: true, said: string}|{ok: false, why: string},
 *   reportCrash: (err: unknown) => void, pollMs?: number}} io
 * @returns {() => void}
 */
function openViewer({
	stdin,
	stdout,
	proc,
	reply,
	stop,
	reportCrash,
	pollMs = POLL_MS,
}) {
	/** @type {NodeJS.Timeout[]} */
	const timers = [];
	const { restore, crash, isRestored } = holdTerminal({
		stdin,
		stdout,
		proc,
		screenOn: SCREEN_ON,
		screenOff: SCREEN_OFF,
		reportCrash,
	});
	const close = () => {
		for (const t of timers) clearTimeout(t);
		restore();
	};

	const draw = () => {
		if (isRestored()) return;
		const lines = viewer.buildLines(
			stdout.columns ?? DEFAULT_COLUMNS,
			stdout.rows ?? DEFAULT_ROWS,
		);
		stdout.write(
			`${ESC}[H${lines.map((l) => `${l}${ESC}[K`).join("\r\n")}${ESC}[J`,
		);
	};
	const viewer = createViewer({
		readSessions,
		readThread,
		reply,
		stop,
		quit: () => proc.exit(0),
		onChange: draw,
	});
	const input = createInputReader();
	/** @param {Key[]} keys */
	const pressKeys = (keys) => {
		try {
			for (const key of keys) viewer.pressKey(key);
		} catch (err) {
			crash(err);
		}
	};
	viewer.refresh();
	draw();

	/** @type {NodeJS.Timeout|undefined} */
	let escapeWait;
	stdin.on("data", (/** @type {string} */ chunk) => {
		clearTimeout(escapeWait);
		const { keys, interrupted, held } = input.read(chunk);
		if (interrupted) {
			proc.exit(0);
			return;
		}
		pressKeys(keys);
		if (held) {
			escapeWait = setTimeout(() => pressKeys(input.flush()), ESCAPE_WAIT_MS);
			timers.push(escapeWait);
		}
	});
	stdout.on("resize", () => {
		stdout.write(CLEAR);
		draw();
	});
	timers.push(
		setInterval(() => {
			try {
				viewer.refresh();
				draw();
			} catch (err) {
				crash(err);
			}
		}, pollMs),
	);
	return close;
}

module.exports = { buildListLines, openViewer, readSessions };
