#!/usr/bin/env node

const fs = require("node:fs");
const { scriptPath } = require("./lib/script-path.js");
const { writeFd } = require("./lib/write-fd.js");
const path = require("node:path");
const {
	guardKeys,
	keyOrigins,
	CORE_NEEDLES,
	hostNeedlesFile,
	readNeedles,
	registeredGuards,
	registryDrift,
	subjectsFor,
	transcriptFires,
	transcriptMentions,
	tally,
	transcriptDirs,
	readTranscriptCorpus,
	sessionKeyFor,
} = require("./lib/guard-fires");
const {
	readHostHookSources,
	mergeHooks,
	pluginHooksFile,
} = require("./lib/core-hooks.js");
const { hostRoot } = require("./lib/host-root.js");
const { flagValue, parseOrExit } = require("./lib/cli-args");

/** @type {import("./lib/cli-args").CliSpec} */
const CLI = {
	usage: `Usage: node ${scriptPath("count-guard-fires.js")} [--dir <path>] [--json] [--mentions] [--since <date>]`,
	flags: {
		"--dir": "value",
		"--json": "boolean",
		"--mentions": "boolean",
		"--since": "value",
	},
};

const CORE = path.join(__dirname, "..");
const PLUGIN_HOOKS = pluginHooksFile(CORE);
const CORE_IS_HOST = fs.realpathSync(CORE) === hostRoot();
const HOST_NEEDLES = hostNeedlesFile(hostRoot());

/**
 * @param {string} text
 */
const say = (text) => writeFd(1, `${text}\n`);

/** @param {string|null} iso */
const day = (iso) => (iso ? iso.slice(0, 10) : "never");

/**
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
 * @param {{subject: string, at: string | null}} item
 * @param {string | null} since
 * @returns {boolean}
 */
function isInWindow(item, since) {
	if (!since) return true;
	return windowVerdict(item.at, since) === "keep";
}

/**
 * @param {{subject: string, at: string | null}} item
 * @param {{count: number, bySubject: Map<string, number>}} undated
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
 * @param {Map<string, Set<string>>} sessions
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
 * @param {ScanState} state
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
		// lucmoseley/mantahostels#2137
		addSession(state.sessions, `${f.subject}\t${f.needle}`, sessionKey);
	}
}

/**
 * @param {ScanState} state
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
	candidates.sort((a, b) => Number(b.leads) - Number(a.leads));

	return { guards, candidates };
}

/**
 * @typedef {{dirs: string[], files: number, unreadable: string[], mentions: boolean, since: string | null, undatedFires: number, undatedMentions: number}} Corpus
 * @typedef {ReturnType<typeof rows>["guards"][number]} GuardRow
 */

/**
 * @param {Corpus} corpus
 * @returns {string[]}
 */
function buildCorpusLines(corpus) {
	const out = [
		`CORPUS  ${corpus.files} transcripts in ${corpus.dirs.join(", ")}, read ${new Date().toISOString().slice(0, 10)}.`,
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
 * @param {string[]} extra
 * @param {string[]} clashes
 * @returns {boolean}
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
				`${key} is keyed in both ${CORE_NEEDLES} and ${HOST_NEEDLES} — the core owns its own guards' words, so remove it from the host file.\n`,
			);
		return true;
	}
	return false;
}

/**
 * @param {{unkeyed: string[], stale: string[]}} drift
 * @param {Map<string, string[]>} origins
 * @param {string[]} hostKeys
 */
function warnDrift(drift, origins, hostKeys) {
	for (const key of drift.unkeyed) {
		const from = origins.get(key) ?? [];
		const home =
			CORE_IS_HOST || from.includes(PLUGIN_HOOKS) ? CORE_NEEDLES : HOST_NEEDLES;
		writeFd(
			2,
			`⚠ ${key} is registered in ${from.join(" and ")} with no entry in ${home} — it is not counted at all, and its absence below is not a zero.\n`,
		);
	}
	for (const key of drift.stale)
		writeFd(
			2,
			`⚠ ${key} has an entry in ${hostKeys.includes(key) ? HOST_NEEDLES : CORE_NEEDLES} but no hook file here registers it — its needles are scanned for nothing. Remove the entry, or register the hook.\n`,
		);
}

/**
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
 * @returns {number}
 */
function main(argv) {
	const { flags } = parseOrExit(argv, CLI);
	const given = flagValue(flags, "--dir");
	const dirs = given ? [given] : transcriptDirs();
	const { needles, hostKeys, clashes, extra } = readNeedles(hostRoot());
	if (refuseHostNeedles(extra, clashes)) return 2;
	const sources = readHostHookSources(hostRoot(), { core: CORE });
	const settings = mergeHooks(sources);
	const origins = keyOrigins(sources);

	warnDrift(registryDrift(needles, settings), origins, hostKeys);

	const { files, unreadable } = readTranscriptCorpus(dirs);
	if (unreadable.length > 0) {
		writeFd(2, `Cannot read transcripts in ${unreadable.join(", ")}.\n`);
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
						dirs,
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
			dirs,
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
