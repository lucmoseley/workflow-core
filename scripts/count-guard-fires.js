#!/usr/bin/env node
/*
 * count-guard-fires.js — how many times has each hook the host registers
 * actually fired, read off the transcripts already on disk. The registrations
 * are `lib/core-hooks.js`'s `readHostHookSources`: the core's self-plugin file and
 * the canary its `.claude/settings.json` keeps, or an adopter's
 * `.claude/settings.json` and the plugin's `hooks/hooks.json`.
 *
 *   node scripts/count-guard-fires.js [--dir <path>] [--json] [--mentions] [--since <date>]
 *
 * Built at mantahostels#1246, the retrieval half of `docs/doc-map.md` §Capture and
 * placement route (e). `--since` added at mantahostels#1896 so §5's ripeness test — a
 * prediction ripens once its subject fires at or after the prediction's date
 * (mantahostels#1886, which retired the earlier 5-fire threshold) — has a filter to run
 * at all; before this it counted lifetime fires only.
 *
 * `--since` is deliberately strict: it accepts an ISO date or the corpus's own
 * `YYYY-MM-DDTHH:MM:SS.mmmZ` timestamp shape, refusing anything else rather
 * than risk `6d98075c`'s failure elsewhere in this repo — an ISO spelling that
 * parses but sorts nowhere near where it means, reporting a silent wrong
 * answer instead of an error. A fire with no timestamp (`at: null`, possible
 * by construction — `lib/guard-fires.js`) is excluded from a windowed count
 * rather than guessed either way, and the exclusion is reported, not silent.
 *
 * A FIRE PROVES THE TEXT WAS PRINTED, NEVER THAT IT WAS READ (mantahostels#1264). A
 * non-zero count is necessary for a route-(e) shed and is not sufficient.
 *
 * IN NO §N3 FAMILY, DELIBERATELY: it gates nothing, runs from a prompt, writes
 * no file and files no issue. `package.json`'s `report:` namespace is a command
 * grouping, not that family.
 *
 * The needles and the three routes: `scripts/guard-fire-needles.json` and
 * `scripts/lib/guard-fires.js`, which owns every seam here worth reusing. A
 * host keys a guard it registers itself in `.claude/guard-fire-needles.json`,
 * `guards` only (#1267); `mergeNeedles` says what it refuses. So it builds
 * its subjects from `subjectsFor` rather than `readRegisteredGuardSubjects`, which
 * reads the core's needles alone and drops the shed candidates (#2297).
 */

const fs = require("node:fs");
const { writeFd } = require("./lib/write-fd.js");
const path = require("node:path");
const {
	guardKeys,
	keyOrigins,
	mergeNeedles,
	registeredGuards,
	registryDrift,
	subjectsFor,
	transcriptFires,
	transcriptMentions,
	tally,
	transcriptDir,
	readTranscriptFiles,
	sessionKeyFor,
} = require("./lib/guard-fires");
const {
	readHostHookSources,
	mergeHooks,
	pluginHooksFile,
} = require("./lib/core-hooks.js");
const { hostRoot } = require("./lib/host-root.js");
const { flagValue, parseOrExit } = require("./lib/cli-args");
const { caught } = require("./lib/caught.js");

/** @type {import("./lib/cli-args").CliSpec} */
const CLI = {
	usage:
		"Usage: node scripts/count-guard-fires.js [--dir <path>] [--json] [--mentions] [--since <date>]",
	flags: {
		"--dir": "value",
		"--json": "boolean",
		"--mentions": "boolean",
		"--since": "value",
	},
};

/* Core content: the needles file ships beside this script, so it is named from
 * THIS DIRECTORY and never through the host root (#1) — a plugin install keeps
 * it beside the caller. */
const NEEDLES = path.join(__dirname, "guard-fire-needles.json");
const CORE = path.join(__dirname, "..");
const PLUGIN_HOOKS = pluginHooksFile(CORE);
const CORE_IS_HOST = fs.realpathSync(CORE) === hostRoot();
const HOST_NEEDLES = path.join(
	hostRoot(),
	".claude",
	"guard-fire-needles.json",
);

/** @param {string} p */
const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));

/**
 * Absent is the common case, an adopter with no guards of its own, so it is
 * silent.
 * @param {string} p
 * @returns {Record<string, any> | null}
 */
function readHostNeedles(p) {
	try {
		return readJson(p);
	} catch (e) {
		if (caught(e).code !== "ENOENT") throw e;
		return null;
	}
}

/**
 * Straight to the fd, never `console`: node buffers writes to a PIPE and drops
 * whatever is still buffered at `process.exit`, and `--json` exists to be piped.
 * @param {string} text
 */
const say = (text) => writeFd(1, `${text}\n`);

/** @param {string|null} iso */
const day = (iso) => (iso ? iso.slice(0, 10) : "never");

/**
 * Parse `--since` into the corpus's own timestamp shape
 * (`YYYY-MM-DDTHH:MM:SS.mmmZ`), so the result is comparable to a fire's `at`
 * by plain string ordering — strict per the file header's `6d98075c` note. A
 * non-UTC offset is refused rather than read against the wrong wall clock.
 *
 * @param {string} raw
 * @returns {{ok: true, since: string} | {ok: false, error: string}}
 */
function parseSince(raw) {
	const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
	const full =
		/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})?$/.exec(
			raw,
		);

	let y;
	let mo;
	let d;
	let h;
	let mi;
	let s;
	let ms;
	if (dateOnly) {
		y = Number(dateOnly[1]);
		mo = Number(dateOnly[2]);
		d = Number(dateOnly[3]);
		h = 0;
		mi = 0;
		s = 0;
		ms = 0;
	} else if (full) {
		const offset = full[8];
		if (offset && offset !== "Z" && offset !== "+00:00" && offset !== "-00:00")
			return {
				ok: false,
				error:
					"--since must be UTC — every corpus timestamp ends in Z, and the " +
					`filter compares strings, so ${JSON.stringify(raw)} would be read ` +
					"against the wrong wall clock rather than converted.",
			};
		y = Number(full[1]);
		mo = Number(full[2]);
		d = Number(full[3]);
		h = Number(full[4]);
		mi = Number(full[5]);
		s = Number(full[6]);
		ms = full[7] ? Number(full[7].slice(1).padEnd(3, "0").slice(0, 3)) : 0;
	} else {
		return {
			ok: false,
			error:
				"--since needs an ISO date (YYYY-MM-DD) or timestamp " +
				`(YYYY-MM-DDTHH:MM:SS[.mmm][Z]), not ${JSON.stringify(raw)}.`,
		};
	}

	const epoch = Date.UTC(y, mo - 1, d, h, mi, s, ms);
	const check = new Date(epoch);
	if (
		check.getUTCFullYear() !== y ||
		check.getUTCMonth() !== mo - 1 ||
		check.getUTCDate() !== d ||
		check.getUTCHours() !== h ||
		check.getUTCMinutes() !== mi ||
		check.getUTCSeconds() !== s
	)
		return {
			ok: false,
			error: `--since is not a real date/time: ${JSON.stringify(raw)}.`,
		};

	/** @param {number} n @param {number} [len] */
	const pad = (n, len = 2) => String(n).padStart(len, "0");
	return {
		ok: true,
		since: `${pad(y, 4)}-${pad(mo)}-${pad(d)}T${pad(h)}:${pad(mi)}:${pad(s)}.${pad(ms, 3)}Z`,
	};
}

/**
 * Where `at` sits relative to a `--since` boundary.
 * @param {string | null} at
 * @param {string} since
 * @returns {"keep" | "undated" | "before"}
 */
function windowVerdict(at, since) {
	if (at === null) return "undated";
	return at < since ? "before" : "keep";
}

/**
 * @param {string} file
 * @returns {string | null}
 */
function readTranscript(file) {
	try {
		return fs.readFileSync(file, "utf8");
	} catch {
		return null;
	}
}

/**
 * Whether a fire or mention falls inside the `--since` window; one carrying
 * no `at` falls outside it.
 * @param {{subject: string, at: string | null}} item
 * @param {string | null} since
 * @returns {boolean}
 */
function isInWindow(item, since) {
	if (!since) return true;
	return windowVerdict(item.at, since) === "keep";
}

/**
 * Tallies a fire or mention the window left out into `undated` (corpus-wide
 * and per subject) where it carries no `at`; a dated one fell before the
 * boundary and is not counted.
 * @param {{subject: string, at: string | null}} item
 * @param {{count: number, bySubject: Map<string, number>}} undated accumulator: counts the undated item, overall and by subject
 */
function tallyIfUndated(item, undated) {
	if (item.at !== null) return;
	undated.count += 1;
	undated.bySubject.set(
		item.subject,
		(undated.bySubject.get(item.subject) ?? 0) + 1,
	);
}

/**
 * @param {Map<string, Set<string>>} sessions accumulator: `sessionKey` is added under `key`
 * @param {string} key
 * @param {string} sessionKey
 */
function addSession(sessions, key, sessionKey) {
	if (!sessions.has(key)) sessions.set(key, new Set());
	sessions.get(key)?.add(sessionKey);
}

/**
 * @typedef {object} ScanState
 * @property {import("./lib/guard-fires.js").Subject[]} subjects
 * @property {string | null} since
 * @property {Array<{subject: string, needle: string, route: string, at: string|null}>} fires
 * @property {Map<string, number>} mentions
 * @property {Map<string, Set<string>>} sessions
 * @property {{count: number, bySubject: Map<string, number>}} undatedFires
 * @property {{count: number, bySubject: Map<string, number>}} undatedMentions
 */

/**
 * One transcript's fires, windowed, into `state`.
 * @param {ScanState} state accumulator: fires, sessions and undatedFires are filled; subjects and since are read
 * @param {string} text
 * @param {{file: string, tier: "main" | "subagent"}} source
 */
function scanFires(state, text, { file, tier }) {
	for (const f of transcriptFires(text, state.subjects, tier)) {
		if (!isInWindow(f, state.since)) {
			tallyIfUndated(f, state.undatedFires);
			continue;
		}
		state.fires.push(f);
		const sessionKey = sessionKeyFor(file, tier);
		addSession(state.sessions, f.subject, sessionKey);
		// Keyed by subject AND needle, alongside the subject-only key above: a
		// guard printing several rules needs a session count PER RULE, since the
		// subject-level count already answers a different question (mantahostels#2137).
		// Both key shapes share this one map — a bare `subject` and a
		// `subject\tneedle` pair — so only a targeted `.get()` is safe here;
		// iterating the map's keys would double-count. The `\t` delimiter
		// assumes no subject or needle id contains one, unenforced.
		addSession(state.sessions, `${f.subject}\t${f.needle}`, sessionKey);
	}
}

/**
 * One transcript's needle hits that are NOT fires, windowed, into `state`.
 * @param {ScanState} state accumulator: mentions and undatedMentions are filled; subjects and since are read
 * @param {string} text
 * @param {"main" | "subagent"} tier
 */
function scanMentions(state, text, tier) {
	for (const m of transcriptMentions(text, state.subjects, tier)) {
		if (!isInWindow(m, state.since)) {
			tallyIfUndated(m, state.undatedMentions);
			continue;
		}
		state.mentions.set(m.subject, (state.mentions.get(m.subject) ?? 0) + 1);
	}
}

/**
 * Scan every transcript once, for fires and — under `--mentions` — for the
 * needle hits that are NOT fires.
 *
 * A transcript that will not open is COUNTED AND NAMED rather than skipped
 * silently: it makes a count read low for a reason that is not the guard.
 *
 * `since`, where given, is normalised (`parseSince`'s output) and applied per
 * fire and per mention, never per file — a session spans midnight, so file
 * mtime is the wrong granularity. A fire or mention with no `at` is tallied
 * separately, both corpus-wide and per subject: ripeness is judged per
 * subject, so a global "N undated" cannot say whether the affected subject
 * is the one a reader is checking.
 *
 * @param {Array<{file: string, tier: "main" | "subagent"}>} files
 * @param {import("./lib/guard-fires.js").Subject[]} subjects
 * @param {boolean} wantMentions
 * @param {string | null} [since]
 */
function scan(files, subjects, wantMentions, since = null) {
	/** @type {ScanState} */
	const state = {
		subjects,
		since,
		fires: [],
		mentions: new Map(),
		sessions: new Map(),
		undatedFires: { count: 0, bySubject: new Map() },
		undatedMentions: { count: 0, bySubject: new Map() },
	};
	/** @type {string[]} */
	const unreadable = [];

	for (const source of files) {
		const text = readTranscript(source.file);
		if (text === null) {
			unreadable.push(source.file);
			continue;
		}
		scanFires(state, text, source);
		if (wantMentions) scanMentions(state, text, source.tier);
	}
	return {
		rolled: tally(state.fires),
		mentions: state.mentions,
		sessions: state.sessions,
		unreadable,
		undatedFires: state.undatedFires.count,
		undatedMentions: state.undatedMentions.count,
		undatedFiresBySubject: state.undatedFires.bySubject,
		undatedMentionsBySubject: state.undatedMentions.bySubject,
	};
}

/**
 * Everything the report shows, as data: `--json` and the human table read it.
 *
 * @param {Record<string, any>} needles
 * @param {Record<string, any>} settings
 * @param {ReturnType<typeof scan>} scanned
 */
function rows(needles, settings, scanned) {
	const registered = registeredGuards(settings);
	const { rolled, mentions, sessions, undatedFiresBySubject } = scanned;

	/** @param {string} id */
	const of = (id) => {
		const t = rolled.get(id);
		const byNeedle = t?.byNeedle ?? {};
		/** @type {Record<string, number>} */
		const sessionsByNeedle = {};
		for (const needle of Object.keys(byNeedle))
			sessionsByNeedle[needle] = sessions.get(`${id}\t${needle}`)?.size ?? 0;
		return {
			total: t?.total ?? 0,
			last: t?.last ?? null,
			byRoute: t?.byRoute ?? {},
			byNeedle,
			lastByNeedle: t?.lastByNeedle ?? {},
			sessions: sessions.get(id)?.size ?? 0,
			sessionsByNeedle,
			mentions: mentions.get(id) ?? 0,
			undated: undatedFiresBySubject?.get(id) ?? 0,
		};
	};

	const guards = guardKeys(settings).map((key) => ({
		key,
		// A hook's `if` holds exactly one permission rule, so a guard narrowed to
		// several is registered once per rule, and naming the rule is what tells
		// those registrations apart (mantahostels#2825). Deduping what is left conceals one
		// case: a guard registered twice on the same event AND narrowing. This
		// column was the only place that showed — hook-wiring holds the
		// registration count load-bearing but reports nothing, and the guard
		// registry's own `if` pass aggregates per script.
		events: [
			...new Set(
				registered
					.filter((r) => r.key === key)
					.map((r) => {
						const at = r.matcher ? `${r.event}:${r.matcher}` : r.event;
						return r.if ? `${at} if ${r.if}` : at;
					}),
			),
		],
		silent: needles.guards?.[key]?.silent ?? null,
		keyed: (needles.guards?.[key]?.needles?.length ?? 0) > 0,
		...of(`guard:${key}`),
	}));

	const candidates = Object.entries(needles.candidates ?? {}).map(
		([id, cand]) => ({
			id,
			span: cand.span,
			printedBy: cand.printedBy,
			route: cand.route,
			leads: Boolean(cand.leads),
			note: cand.note ?? null,
			...of(`cand:${id}`),
		}),
	);
	// A registry flag, never a literal id here: a renamed id must not silently
	// lose the ordering. Which candidate leads, and why: the registry's leadsWhy.
	candidates.sort((a, b) => Number(b.leads) - Number(a.leads));

	return { guards, candidates };
}

/**
 * @typedef {{dir: string, files: number, unreadable: string[], mentions: boolean, since: string | null, undatedFires: number, undatedMentions: number}} Corpus
 * @typedef {ReturnType<typeof rows>["guards"][number]} GuardRow
 */

/**
 * @param {Corpus} corpus
 * @returns {string[]}
 */
function buildCorpusLines(corpus) {
	const out = [
		`CORPUS  ${corpus.files} transcripts in ${corpus.dir}, read ${new Date().toISOString().slice(0, 10)}.`,
		"        It grows daily — sessions write into it while this runs — so carry the count",
		"        with the figures. Both tiers are read: a main session's own file and every",
		"        subagent it dispatched, under that session's subagents/ directory (mantahostels#1779).",
	];
	if (corpus.since) out.push(...buildWindowLines(corpus));
	if (corpus.unreadable.length > 0)
		out.push(
			`        ⚠ ${corpus.unreadable.length} transcript(s) could not be read, so every count below is a floor:`,
			...corpus.unreadable.map((f) => `          ${f}`),
		);
	out.push("");
	return out;
}

/**
 * @param {Corpus} corpus
 * @returns {string[]}
 */
function buildWindowLines(corpus) {
	const out = [
		`        WINDOW  since ${corpus.since} — every fire and mention before it is excluded.`,
	];
	if (corpus.undatedFires)
		out.push(
			`        ⚠ ${corpus.undatedFires} fire(s) carry no timestamp and cannot be placed in or out of the`,
			"          window, so they are excluded either way — every FIRED count below is a floor.",
		);
	if (corpus.mentions && corpus.undatedMentions)
		out.push(
			`        ⚠ ${corpus.undatedMentions} mention(s) carry no timestamp and are excluded the same way.`,
		);
	return out;
}

/**
 * @param {GuardRow[]} fired
 * @param {Corpus} corpus
 * @returns {string[]}
 */
function buildFiredLines(fired, corpus) {
	const out = [
		`FIRED (${fired.length})`,
		`  FIRES  SESSIONS${corpus.mentions ? "  MENTIONS" : ""}  LAST FIRE   HOOK`,
	];
	for (const g of [...fired].sort((a, b) => b.total - a.total)) {
		const seen = corpus.mentions ? `  ${String(g.mentions).padStart(8)}` : "";
		out.push(
			`  ${String(g.total).padStart(5)}  ${String(g.sessions).padStart(8)}${seen}  ${day(g.last)}  ${g.key}  [${g.events.join(", ")}]${g.undated ? `  (+${g.undated} undated, excluded)` : ""}`,
			// Each needle carries its OWN last fire, not the guard's. A guard
			// printing several rules gives the LAST FIRE column above a date
			// belonging to whichever of them fired most recently, and
			// docs/doc-map.md §Capture and placement §5's ripeness test reads that
			// column per RULE (mantahostels#2118).
			//
			// `undated` here means a counted fire whose record carried no
			// timestamp — NOT the row's `(+n undated, excluded)`, which is a fire
			// dropped from a --since window. The counts on this line are keyed by
			// needle and the undated tally is keyed by subject, so under --since
			// each is a floor and the row above says by how much (mantahostels#2137).
			//
			// The session count here is per needle too (mantahostels#2137); SESSIONS above
			// is per guard.
			`         ${Object.entries(g.byNeedle)
				.sort((a, b) => b[1] - a[1])
				.map(
					([needle, count]) =>
						`${needle} ${count} across ${g.sessionsByNeedle[needle] ?? 0} session(s) (${g.lastByNeedle[needle] ? day(g.lastByNeedle[needle]) : "undated"})`,
				)
				.join(" · ")}`,
		);
	}
	out.push("");
	return out;
}

/**
 * @param {GuardRow[]} never
 * @param {Corpus} corpus
 * @returns {string[]}
 */
function buildNeverLines(never, corpus) {
	const out = [
		`NEVER FIRED (${never.length}) — under the deterrence caveat`,
		"  A zero here is evidence about retrieval, never about a rule's worth: a guard nothing",
		"  trips may be a guard working by deterrence. It IS decisive for route (e) — text never",
		"  printed never reaches a reader, so no prose can be shed to it.",
	];
	if (corpus.since)
		out.push(
			"  ⚠ WINDOWED: this zero is since the boundary above, not lifetime — it does NOT license a",
			"    route (e) shed. Run with no --since for that verdict.",
		);
	for (const g of never)
		out.push(
			`  0  ${g.key}  [${g.events.join(", ")}]${g.undated ? `  (${g.undated} undated fire(s) excluded)` : ""}${corpus.mentions ? `  (${g.mentions} mention(s))` : ""}`,
		);
	out.push("");
	return out;
}

/**
 * @param {GuardRow[]} unkeyable
 * @returns {string[]}
 */
function buildSilentLines(unkeyable) {
	return [
		`SILENT BY DESIGN (${unkeyable.length}) — not a zero, an unmeasurable`,
		"  This method cannot count these either way.",
		...unkeyable.map(
			(g) => `  —  ${g.key}  ${g.silent ?? "no needles registered"}`,
		),
		"",
	];
}

/**
 * @param {ReturnType<typeof rows>["candidates"]} candidates
 * @param {Corpus} corpus
 * @returns {string[]}
 */
function buildCandidateLines(candidates, corpus) {
	const out = [
		"ROUTE-(e) SHED CANDIDATES (docs/research/always-loaded-shed-candidates.md)",
		"  PROVEN is the hook and deny routes together — the harness's own record of the text",
		"  reaching a session. +CLI is the Bash-stdout route on top, an upper bound only: a `cat`",
		"  of the printing script lands its source in the very same field. A candidate whose whole",
		"  count is CLI has no proven fire at all — read those before shedding on them.",
	];
	if (corpus.since)
		out.push(
			"  ⚠ WINDOWED: PROVEN and +CLI below are since the boundary above, not lifetime — a 0 here",
			"    does not mean no proven fire ever. Run with no --since to judge a shed.",
		);
	out.push("  PROVEN   +CLI  LAST FIRE   CANDIDATE");
	for (const c of candidates) {
		const proven = (c.byRoute.hook ?? 0) + (c.byRoute.deny ?? 0);
		out.push(
			`  ${String(proven).padStart(6)}  ${String(c.byRoute.cli ?? 0).padStart(5)}  ${day(c.last)}  ${c.id} — ${c.span}`,
			`          printed by: ${c.printedBy ?? "nothing"}`,
		);
		if (c.note) out.push(`          ${c.note}`);
	}
	return out;
}

/**
 * @param {ReturnType<typeof rows>} data
 * @param {Corpus} corpus
 * @returns {string}
 */
function render(data, corpus) {
	const fired = data.guards.filter((g) => g.keyed && g.total > 0);
	const never = data.guards.filter((g) => g.keyed && g.total === 0);
	const unkeyable = data.guards.filter((g) => !g.keyed);

	return [
		...buildCorpusLines(corpus),
		...buildFiredLines(fired, corpus),
		...buildNeverLines(never, corpus),
		...buildSilentLines(unkeyable),
		...buildCandidateLines(data.candidates, corpus),
	].join("\n");
}

/**
 * Refuse a host needles file carrying more than `guards`, or keying a guard
 * the core already keys, naming each fault on stderr.
 * @param {string[]} extra
 * @param {string[]} clashes
 * @returns {boolean} true where the run must stop
 */
function refuseHostNeedles(extra, clashes) {
	if (extra.length > 0) {
		writeFd(
			2,
			`${HOST_NEEDLES} carries ${extra.join(", ")} — a host needles file holds a \`guards\` object only, so remove the rest.\n`,
		);
		return true;
	}
	if (clashes.length > 0) {
		for (const key of clashes)
			writeFd(
				2,
				`${key} is keyed in both ${NEEDLES} and ${HOST_NEEDLES} — the core owns its own guards' words, so remove it from the host file.\n`,
			);
		return true;
	}
	return false;
}

/**
 * Warn on stderr about each registered hook with no needles entry, and each
 * entry no hook file registers.
 * @param {{unkeyed: string[], stale: string[]}} drift
 * @param {Map<string, string[]>} origins
 * @param {string[]} hostKeys
 */
function warnDrift(drift, origins, hostKeys) {
	for (const key of drift.unkeyed) {
		const from = origins.get(key) ?? [];
		// A key the plugin registers is the core's to word, as is any key run
		// from the core's own checkout; one only an adopter registers can only
		// be worded in the adopter's file.
		const home =
			CORE_IS_HOST || from.includes(PLUGIN_HOOKS) ? NEEDLES : HOST_NEEDLES;
		writeFd(
			2,
			`⚠ ${key} is registered in ${from.join(" and ")} with no entry in ${home} — it is not counted at all, and its absence below is not a zero.\n`,
		);
	}
	for (const key of drift.stale)
		writeFd(
			2,
			`⚠ ${key} has an entry in ${hostKeys.includes(key) ? HOST_NEEDLES : NEEDLES} but no hook file here registers it — its needles are scanned for nothing. Remove the entry, or register the hook.\n`,
		);
}

/**
 * The `--since` boundary, null where the flag is absent; a bad one is
 * reported on stderr and comes back not ok.
 * @param {string | undefined} raw
 * @returns {{ok: true, since: string | null} | {ok: false}}
 */
function parseSinceFlag(raw) {
	if (raw === undefined) return { ok: true, since: null };
	const parsed = parseSince(raw);
	if (!parsed.ok) {
		writeFd(2, `${parsed.error}\n`);
		return { ok: false };
	}
	return { ok: true, since: parsed.since };
}

/**
 * @param {string[]} argv
 * @returns {number} the exit code
 */
function main(argv) {
	const { flags } = parseOrExit(argv, CLI);
	/* Host content: the settings file and the transcript directory belong to
	 * the repository being worked on, so both read the host root (#1). */
	const dir = flagValue(flags, "--dir") ?? transcriptDir(hostRoot());
	const { needles, hostKeys, clashes, extra } = mergeNeedles(
		readJson(NEEDLES),
		readHostNeedles(HOST_NEEDLES),
	);
	if (refuseHostNeedles(extra, clashes)) return 2;
	const sources = readHostHookSources(hostRoot(), { core: CORE });
	const settings = mergeHooks(sources);
	const origins = keyOrigins(sources);

	warnDrift(registryDrift(needles, settings), origins, hostKeys);

	const files = readTranscriptFiles(dir);
	if (files === null) {
		writeFd(2, `Cannot read transcripts in ${dir}.\n`);
		return 2;
	}

	const sinceArg = parseSinceFlag(flagValue(flags, "--since"));
	if (!sinceArg.ok) return 2;
	const since = sinceArg.since;

	const wantMentions = Boolean(flags["--mentions"]);
	const scanned = scan(
		files,
		subjectsFor(needles, settings),
		wantMentions,
		since,
	);
	const data = rows(needles, settings, scanned);

	if (flags["--json"]) {
		say(
			JSON.stringify(
				{
					corpus: {
						dir,
						transcripts: files.length,
						unreadable: scanned.unreadable,
						read: new Date().toISOString(),
						since,
						undatedFires: scanned.undatedFires,
						undatedMentions: scanned.undatedMentions,
					},
					...data,
				},
				null,
				2,
			),
		);
		return 0;
	}

	say(
		render(data, {
			dir,
			files: files.length,
			unreadable: scanned.unreadable,
			mentions: wantMentions,
			since,
			undatedFires: scanned.undatedFires,
			undatedMentions: scanned.undatedMentions,
		}),
	);
	return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { main, rows, render, scan, parseSince };
