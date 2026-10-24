#!/usr/bin/env node
/*
 * check-doc-map-markers.js — ages every ⚠ marker in docs/doc-map.md, wherever
 * in the document it sits.
 *
 * Usage:
 *   node check-doc-map-markers.js [<doc-map.md>] [--data-dir <dir>]
 *   (default: docs/doc-map.md, and the sidecar beside it)
 *
 * Markers are raised in §B entries, on Section A register rows and in section
 * prose, and all three are read (mantahostels#649). Two kinds sit in the same notation, and
 * the marker's own text is what separates them:
 *
 *   DATED     an observation — "unapplied in 3 files / 10 hits at 6 Aug 2026".
 *             It asserts a state on a date, so it can go stale. WARN past 14
 *             days, FAIL past 30.
 *   UNDATED   a standing hazard — a collision, an editing trap, a figure that
 *             was assumed and never measured. Nothing clears it, so ageing it
 *             would leave CI red forever. Listed, never gated.
 *
 * The split is on the date alone, never on what the marker is about. A
 * "do not bulk-replace 15% — 15 files / 50 hits at 1 Aug 2026" marker is a permanent
 * hazard and still ages.
 *
 * RE-dating is how a session re-confirms a marker whose fix is genuinely blocked
 * (mantahostels#209).
 *
 * PERMANENT is the third kind (mantahostels#1357). A date is not always a confirmation
 * stamp — a marker may state one as a fact about the world: a supersession that
 * happened on a day, a corpus that begins on one. It ages anyway, and nothing
 * can ever clear it, so `Document guards` goes red forever. The `(standing)`
 * tag, anywhere in the marker's own text, makes one standing.
 *
 * THE TAG NEVER REACHES A MARKER WHOSE OWN TEXT SAYS WORK IS OUTSTANDING (the
 * `NEVER_PERMANENT` list below, which is wider than `OUTSTANDING` and says why).
 *
 * Two residuals that limb leaves. The list is a set of phrases, so a genuinely
 * outstanding marker worded outside it is silenced for good. And `(standing)`
 * is applied by the session raising the marker and reviewed by nothing, so the
 * escape is only as sound as the judgement that a date is stated rather than
 * confirmed.
 *
 * The escape the split creates is a marker that describes outstanding work and
 * omits the date. That FAILs: an undated marker whose own text says work is
 * outstanding ("unapplied", "known stale copy", "still open") must be dated or
 * reworded.
 *
 * Dates are read on the WITA clock the document was written on, never on UTC
 * (mantahostels#919). A written date carries no hour, so ages come out in whole calendar
 * days: nought on the day it was written.
 *
 * A marker may carry two dates — when it was written, and a date it tells a
 * reader to act on. It ages from the latest one that is not in the future, so
 * FUTURE now fires only where every date on it is ahead of the calendar
 * (mantahostels#1052). See `anchorDate`.
 *
 * No git. mantahostels#130 ruled a commit date the wrong instrument for exactly this: CI
 * clones shallow so the history is not reliably there to read, and an amend or
 * rebase that moves a commit without changing a byte resets the clock. The date
 * comes from the document instead.
 *
 * Each marker is reported under where it sits — its `B<n>`, the register row's
 * document path, or the enclosing heading. A Section A marker meant to stand
 * forever omits the date and lets its issue citation carry the provenance;
 * on a table row, write the date in the marker's own cell.
 *
 * Not a 60-90-day FAIL (mantahostels#217), beyond the horizon anyone remembers the
 * ruling by; and not WARN-only, since blunting a marker means deleting a
 * deliberately raised flag, which is visible in review.
 *
 * Thresholds are 14/30 days, the pair check-manual-freshness.js already uses for
 * review latency. Justified on mantahostels#217.
 *
 * ONE FACT HAS A SECOND HOME. "Restated-in is known incomplete" is written both
 * as a marker in §B prose and as `knownIncomplete` in
 * docs/doc-map-restatements.json, and mantahostels#1450's migration will eventually leave
 * the sidecar as its only home. Both are aged here, on the same thresholds, and
 * the pair never reports twice — see `ageSidecar` for which of the two speaks.
 */

const fs = require("node:fs");
const path = require("node:path");

/**
 * One row of the census. `standing` is set from `permanent` and `at` at
 * construction and says the marker is not under the clock; `ageSidecar` may
 * clear it.
 *
 * @typedef {import("./lib/check").CheckContext} Ctx
 * @typedef {{
 *   where: string,
 *   dateFrom: string,
 *   text: string,
 *   phrase: string|null,
 *   permanent: string|null,
 *   at: string|null,
 *   ageDays: number|null,
 *   standing: boolean,
 * }} Marker
 */
const { runCheck } = require("./lib/check");
const { requiredGroup } = require("./lib/regex-group");
const { calendarDaysSince, witaDay } = require("./lib/wita");
const {
	DATA_FILES,
	FIGURE_ID,
	loadRestatements,
	parseEntries,
	readMap,
	registerPaths,
	registerRowPath,
	sectionBRange,
} = require("./lib/doc-map");
const { caught } = require("./lib/caught.js");

/* The class sidecar, read from the data dir this run was pointed at and from
 * nowhere else. lib/doc-map.js's own resolver falls back to the tracked
 * docs/doc-map-classes.json, which would age the repo's real entries alongside a
 * fixture map's. Soft: a missing or unparseable sidecar costs the fields
 * `locate` adds and nothing else. */
const CLASSES_FILE = "doc-map-classes.json";

/** @param {string} dataDir */
function classesBeside(dataDir) {
	try {
		const data = JSON.parse(
			fs.readFileSync(path.join(dataDir, CLASSES_FILE), "utf8"),
		);
		return data && typeof data === "object" && !Array.isArray(data) ? data : {};
	} catch {
		return {};
	}
}

const WARN_DAYS = 14;
const FAIL_DAYS = 30;

/* A marker opens with the sign followed by whitespace. Written otherwise the
 * sign is being named rather than raised — "retiring both the flag
 * and the ⚠; until it rules …" is prose about a marker, not one. */
const MARKER = /⚠(?=\s+\S)/g;

/* The tag that declares a marker's dates to be facts it states rather than
 * confirmations of it (mantahostels#1357). Matched on the whole parenthesised word, never
 * on a bare "standing", which a substring match would silence wherever the
 * map's prose uses the word.
 *
 * `plain()` strips emphasis before the test, so `**(standing)**` counts. */
const STANDING_TAG = "(standing)";

const MONTHS = [
	"jan",
	"feb",
	"mar",
	"apr",
	"may",
	"jun",
	"jul",
	"aug",
	"sep",
	"oct",
	"nov",
	"dec",
];

/* "6 Aug 2026" and "2 August 2026" both appear in §B; the year is required,
 * because "Ruled 2 Aug" names when a ruling happened, not when the marker was
 * last confirmed outstanding. ISO is accepted for anything written later. */
const WRITTEN = /\b(\d{1,2})\s+([A-Za-z]{3,9})\.?\s+(\d{4})\b/g;
const ISO = /\b(\d{4})-(\d{2})-(\d{2})\b/g;

/* The phrases an undated marker must not use — each says, in the marker's own
 * words, that something is still to be done. Kept to unambiguous ones: "⚠
 * Incomplete" is deliberately absent, since mantahostels#26 mandates that marker on every
 * retired-vocabulary list from birth, so it is standing by design. The
 * completeness it reports on IS knowable — an unblinded sweep settles it per
 * entry (mantahostels#2373) — but a marker that survives one is still undated, the entry
 * whose sweep came back clean dropping it rather than dating it.
 * "Restated-in is known incomplete" is
 * absent for the same reason and by the same ruling (mantahostels#775, applied at mantahostels#1372):
 * mantahostels#26 mandates it on every claim entry from birth, so the bare marker is
 * written undated. Only an instance saying something specific about its own
 * entry's list carries a date. */
const OUTSTANDING = [
	"unapplied",
	"not yet applied",
	"known stale copy",
	"conflicting copy",
	"still open",
	"still stale",
	"stale pending",
	"pending #",
];

/* The phrases that withdraw the tag's permanence — `OUTSTANDING` and more
 * (mantahostels#1357). Deliberately the wider list of the two, because the two do different
 * jobs: a phrase added to `OUTSTANDING` FAILs every undated marker already
 * using it, while one added here only leaves the marker ageing as it does
 * today. `OUTSTANDING` misses the shapes the map's outstanding markers are
 * actually written in — "Restated-in is known incomplete", "Unresolved,
 * <date>", "Unverified" — every one of which the tag would otherwise silence.
 *
 * Erring wide is the safe direction: the cost of a false hit is a permanent
 * marker that has to be reworded, against a real one silenced for good. */
const NEVER_PERMANENT = [
	...OUTSTANDING,
	"known incomplete",
	"unresolved",
	"unverified",
	"unruled",
	"awaiting #",
	"still owed",
	"still to be",
	"does not yet",
];

/**
 * A marker's text runs to the next marker or the end of its line. Continuation
 * lines are not read: a date on one belongs to whatever that line asserts, and
 * A marker can sit in a nested bullet whose next line is a sibling.
 *
 * On a table row it stops at the cell wall instead: `anchorDate` takes the
 * latest date anywhere in the text it is given, so a date in a later cell would
 * re-date the marker.
 *
 * @param {string} line
 * @param {boolean} [row]
 * @returns {string[]} */
function markersOn(line, row = false) {
	const starts = [...line.matchAll(MARKER)].map((m) => m.index);
	return starts.map((start, i) => {
		const wall = row ? line.indexOf("|", start) : -1;
		const ends = [line.length, starts[i + 1], wall === -1 ? undefined : wall];
		const text = line
			.slice(start + 1, Math.min(...ends.filter((e) => e !== undefined)))
			.trim();
		/* Most markers are written `**⚠ …**`, and some sit inside a bold run that
		 * opened earlier in the line, so the slice keeps a closer whose opener it
		 * cut. Reported as-is that trails a stray `**` through the census. An odd
		 * count before the sign is what says the run is open. */
		const openers = line.slice(0, start).split("**").length - 1;
		return openers % 2 === 1 ? text.replace("**", "") : text;
	});
}

/**
 * The date a marker is aged from, as the UTC-midnight timestamp of that
 * calendar day, or null where the marker carries none. `calendarDaysSince` ages
 * it against the same WITA day.
 *
 * The latest date wins, so re-dating a marker in place re-confirms it — but
 * only among dates that are not in the future. A marker may name a date a
 * reader is told to act *on*: mantahostels#689's says it was written 19 Aug 2026 and that
 * mantahostels#766 re-measures on or after 2 Sep 2026, and the bare maximum read that
 * second date as the marker's own and failed it FUTURE (mantahostels#1052).
 *
 * Where every date is in the future there is nothing to fall back on, so the
 * latest is returned anyway and ages negative — the typo case (2027 written for
 * 2026), which FUTURE exists to catch.
 *
 * @param {string} text
 * @param {number} today
 * @returns {number|null}
 */
function anchorDate(text, today) {
	/** @type {number[]} */
	const stamps = [];
	for (const w of text.matchAll(WRITTEN)) {
		const month = requiredGroup(w, 2, WRITTEN);
		const m = MONTHS.indexOf(month.slice(0, 3).toLowerCase());
		if (m !== -1)
			stamps.push(
				Date.UTC(
					+requiredGroup(w, 3, WRITTEN),
					m,
					+requiredGroup(w, 1, WRITTEN),
				),
			);
	}
	for (const i of text.matchAll(ISO))
		stamps.push(
			Date.UTC(
				+requiredGroup(i, 1, ISO),
				+requiredGroup(i, 2, ISO) - 1,
				+requiredGroup(i, 3, ISO),
			),
		);
	if (stamps.length === 0) return null;
	const past = stamps.filter((s) => s <= today);
	return Math.max(...(past.length > 0 ? past : stamps));
}

/* Markdown emphasis and the bullet's own punctuation carry no meaning for the
 * phrase match, and a marker wrapping a phrase in bold would otherwise slip it.
 */
/** @param {string} text */
const plain = (text) => text.replace(/[*`_]/g, "").toLowerCase();

/**
 * @param {string} text
 * @param {number} [n]
 */
const truncate = (text, n = 96) =>
	text.length > n ? `${text.slice(0, n - 1)}…` : text;

/**
 * Why this marker's dates are facts it states rather than confirmations of it,
 * or null where they are not — the tag in this file's header. The string is the
 * reason, and the census prints it.
 *
 * @param {string} text
 * @returns {string|null}
 */
function permanenceOf(text) {
	return plain(text).includes(STANDING_TAG) ? `tagged ${STANDING_TAG}` : null;
}

/**
 * Every line of the map paired with the location a marker on it is reported
 * under: its `B<n>` inside a figure entry, the register row's document path on a
 * Section A row, and otherwise the enclosing heading.
 *
 * A §A subsection registering as a LIST renders no `role` or `route` prose
 * into the map at all (mantahostels#2743), so the markers inside them would leave the
 * census the day that subsection stopped being a table. The text is still in `docs/doc-map-classes.json`, so `sidecar` re-supplies it:
 * one located line per field, reported under its own path exactly as the row
 * was. `isRow` is false on those, because a sidecar field is one value and not
 * a row of cells — a marker in it runs to the end of the field rather than to
 * the next `|`.
 *
 * @param {string} text
 * @param {Set<string>} registered
 * @param {Record<string, {role?: string|null, route?: string|null}>} [sidecar]
 * @returns {{line: string, where: string, isRow: boolean}[]}
 */
function locate(text, registered, sidecar = {}) {
	/** @type {{line: string, where: string, isRow: boolean}[]} */
	const located = [];
	/** @type {{figure: string|null|undefined, heading: string, inRegister: boolean}} */
	const at = { figure: null, heading: "(preamble)", inRegister: false };
	for (const line of text.split("\n")) {
		if (/^#+ /.test(line)) enterHeading(at, line);
		const row =
			at.inRegister && !at.figure ? registerRowPath(line, registered) : null;
		/* Cell-bounding is a property of the line, not of the lookup: a Section A
		 * row whose path the register does not carry is still a table row. */
		located.push({
			line,
			where: at.figure || row || at.heading,
			isRow: line.startsWith("|"),
		});
	}
	addSidecarFields(located, sidecar);
	return located;
}

/**
 * Moves `locate`'s position onto a heading line: the figure it opens, if any,
 * its text, and — on a `## ` heading — whether Section A is entered.
 *
 * @param {{figure: string|null|undefined, heading: string, inRegister: boolean}} at accumulator: the walk's position, moved onto the heading
 * @param {string} line
 */
function enterHeading(at, line) {
	const fig = line.match(FIGURE_ID);
	at.figure = fig ? fig[1] : null;
	at.heading = line.replace(/^#+\s*/, "").trim();
	if (/^## /.test(line)) at.inRegister = /^## Section A/.test(line);
}

/**
 * Appends a located line per sidecar `role`/`route` field whose path no row
 * of the map already located.
 *
 * @param {{line: string, where: string, isRow: boolean}[]} located accumulator: a line per unlocated sidecar field is pushed here
 * @param {Record<string, {role?: string|null, route?: string|null}>} sidecar
 */
function addSidecarFields(located, sidecar) {
	const asRow = new Set(located.map((l) => l.where));
	for (const [p, entry] of Object.entries(sidecar)) {
		if (asRow.has(p)) continue;
		for (const field of [entry?.role, entry?.route])
			if (field) located.push({ line: field, where: p, isRow: false });
	}
}

/* The marker text the sidecar's `knownIncomplete` date belongs to, matched on
 * the phrase the map's own prose uses. It sits in `NEVER_PERMANENT`, so the
 * `(standing)` tag can never silence one of these — the fact is outstanding work
 * by definition.
 *
 * THE FIELD IS WRITTEN ONLY WHERE THE MARKER NAMES THE WORK (mantahostels#1372). An undated
 * marker with no key ages off nothing, so adding a key is the only thing that
 * puts an entry back under the clock — and the only enforcement this has. */
const KNOWN_INCOMPLETE = "known incomplete";

/**
 * Ages every `knownIncomplete` date in docs/doc-map-restatements.json onto
 * a copy of the marker census, so the sidecar copy of the fact gates exactly
 * as the prose marker does.
 *
 * Three cases, and only ever one row per entry:
 *
 *   a DATED prose marker on that entry   the OLDER of the two dates ages it;
 *                                        the other is dropped.
 *   an UNDATED one                       the sidecar supplies the date the
 *                                        bullet omits, on that same row.
 *   none                                 the sidecar raises the marker itself
 *                                        — the state the migration leaves.
 *
 * OLDER RATHER THAN "THE PROSE WINS" (mantahostels#1471). The two dates can diverge in the map
 * — one entry read 20 Aug 2026 in prose and 2026-08-19 in the sidecar — and
 * letting the prose date win would hide however stale the sidecar's had gone,
 * then flip the verdict to STALE on the day mantahostels#1450's migration deletes the prose
 * marker. Taking the older means deleting either copy cannot change the
 * verdict — at the accepted cost that re-dating one copy and forgetting the
 * other clears nothing.
 *
 * **Residual:** the prose marker is found by the phrase alone
 * (`KNOWN_INCOMPLETE`), so a differently-worded marker on that entry raises a
 * second row, and any OTHER marker on it using the phrase absorbs the sidecar's
 * date instead. Both are visible in the census rather than silent.
 *
 * An absent sidecar leaves the map read alone (mantahostels#1471): the fixtures the tests
 * write carry none, and a checker that went BROKEN on one would gate on a file
 * it does not own. A sidecar renamed or moved out from beside the map therefore
 * ages nothing — so the caller says which of the two happened rather than
 * printing nothing either way. Present and unreadable is BROKEN, since a
 * `knownIncomplete` nobody can parse is a date nothing ages.
 *
 * The ids are not checked against the map's entries — check-doc-map.js and
 * check-restatement-edges.js both already BROKEN on an orphan key, and one
 * here would report the same typo a third time.
 *
 * @param {Ctx} ctx
 * @param {Marker[]} markers
 * @param {{dataDir: string, ageOf: (at: number) => number, sectionBEmpty: boolean}} opts
 *   `sectionBEmpty` — §B holds no `### B<n>` entries, so an empty sidecar is a
 *   day-one state rather than data gone missing (workflow-core#52).
 * @returns {{markers: Marker[], census: {read: number, quiet: number, aged: number, raised: number}|null}}
 *   the markers with the sidecar's dates aged in, and the census of what it
 *   read, or null where no sidecar sits there.
 */
function ageSidecar(ctx, markers, { dataDir, ageOf, sectionBEmpty }) {
	const file = path.join(dataDir, DATA_FILES.restatements);
	let data;
	try {
		data = loadRestatements(file, { allowEmpty: sectionBEmpty });
	} catch (e) {
		const { code, message } = caught(e);
		if (code === "ENOENT") return { markers, census: null };
		ctx.broken(`restatement sidecar unreadable — ${message}`);
	}

	const out = [...markers];
	const census = { read: 0, quiet: 0, aged: 0, raised: 0 };
	for (const [id, entry] of Object.entries(data)) {
		const iso = entry.knownIncomplete;
		if (!iso) continue;
		census.read++;
		const [y, m, d] = iso.split("-").map(Number);
		/* loadRestatements has already refused any value not YYYY-MM-DD. */
		if (y === undefined || m === undefined || d === undefined)
			return ctx.broken(`${id}: knownIncomplete \`${iso}\` is not YYYY-MM-DD`);
		const at = Date.UTC(y, m - 1, d);
		const ageDays = ageOf(at);

		const i = out.findIndex(
			(mk) => mk.where === id && plain(mk.text).includes(KNOWN_INCOMPLETE),
		);
		const prose = out[i];
		if (prose) {
			/* ISO sorts chronologically, so this is the older-wins test and the
			 * undated case at once — `at` is null where the bullet carries no date. */
			if (prose.at !== null && prose.at <= iso) {
				census.quiet++;
				continue;
			}
			out[i] = {
				...prose,
				at: iso,
				ageDays,
				standing: false,
				/* The row sits in prose, but the date now being aged does not — so the
				 * remedy names the field that carries it, not the bullet. */
				dateFrom: "sidecar",
			};
			census.aged++;
			continue;
		}

		out.push({
			where: id,
			dateFrom: "sidecar",
			text: `Restated-in is known incomplete — ${DATA_FILES.restatements}, ${iso}`,
			phrase: null,
			permanent: null,
			at: iso,
			ageDays,
			standing: false,
		});
		census.raised++;
	}
	return { markers: out, census };
}

/* The walk does not use these entries; parsing them is the BROKEN guard,
 * without which a map missing Section B reports Section A alone and reads
 * as a pass. A genuinely empty registry ("None registered.", this repo's
 * own dogfooding copy) is not that failure (workflow-core#52) — only the section's
 * absence, or a heading-shaped line under it that FIGURE_ID could not
 * parse, is.
 * **Residual:** this scan runs only where §B is entirely empty, so a
 * genuine `### B1` sitting beside an unparseable `### Bx` still passes. */
/**
 * @param {Ctx} ctx
 * @param {string} text
 * @param {string} mapPath
 * @returns {boolean} whether §B holds no `### B<n>` entries — BROKEN first
 *   where it is missing, or empty beside a heading that does not parse
 */
function isSectionBEmpty(ctx, text, mapPath) {
	const lines = text.split("\n");
	const figures = parseEntries(text, FIGURE_ID);
	if (figures.length === 0) {
		const range = sectionBRange(lines);
		if (!range) ctx.broken(`no "## Section B" heading found in ${mapPath}`);
		const body = lines.slice(range.start, range.end);
		const stray = body.find((l) => /^###\s/.test(l) && !FIGURE_ID.test(l));
		if (stray)
			ctx.broken(
				`Section B heading "${stray.trim()}" in ${mapPath} does not parse as "### B<n>"`,
			);
	}
	return figures.length === 0;
}

/**
 * One prose marker's census row.
 *
 * @param {string} raw
 * @param {string} where
 * @param {{today: number, ageOf: (at: number) => number}} ageing
 * @returns {Marker}
 */
function proseMarker(raw, where, { today, ageOf }) {
	/* Two lists, two jobs — `OUTSTANDING` FAILs an undated marker, the
	 * wider `NEVER_PERMANENT` withdraws the tag's permanence. */
	const phrase = OUTSTANDING.find((p) => plain(raw).includes(p));
	const barred = NEVER_PERMANENT.find((p) => plain(raw).includes(p));
	const permanent = barred ? null : permanenceOf(raw);
	/* The date is still read on a permanent marker, and still reported —
	 * only the ageing is withheld. */
	const at = anchorDate(raw, today);
	/* `dateFrom` says where the date being aged is written, and so which
	 * file a reader has to edit to clear it — not where the row was
	 * raised, which the merge case in `ageSidecar` splits from it. */
	return {
		where,
		dateFrom: "prose",
		text: raw,
		phrase: phrase ?? null,
		permanent,
		at: at === null ? null : new Date(at).toISOString().slice(0, 10),
		ageDays: at === null ? null : ageOf(at),
		standing: permanent !== null || at === null,
	};
}

/**
 * FAILs or WARNs one marker on its age; an undated one FAILs only where its
 * text says work is outstanding.
 *
 * @param {Ctx} ctx
 * @param {Marker} m
 */
function gateMarker(ctx, m) {
	const where = `${m.where}: ${truncate(m.text)}`;
	/* The age is out of the key: it climbs a day at a time (workflow-core#1591). */
	const key = (/** @type {string} */ tag) => `${tag}\t${m.where}\t${m.text}`;
	/* `standing` is set from `at === null`, so the second test names an
	 * age this branch has already caught — and is what says so. */
	if (m.standing || m.ageDays === null) {
		if (m.phrase)
			ctx.fail(
				"UNDATED",
				`${where} — says "${m.phrase}" but carries no date, so nothing ages it`,
				undefined,
				key("UNDATED"),
			);
		return;
	}
	const age = m.ageDays;
	if (m.ageDays < 0)
		ctx.fail(
			"FUTURE",
			`${where} — dated in the future (${m.at})`,
			undefined,
			key("FUTURE"),
		);
	else if (m.ageDays > FAIL_DAYS)
		/* The escape rides on the finding, not only on the closing report:
		 * `ctx.say` goes to stderr and is suppressed under --json, so the
		 * Actions annotation a reader of a red job sees carries this line
		 * alone. */
		ctx.fail(
			"STALE",
			`${where} — outstanding ${age} days (>${FAIL_DAYS}), dated ${m.at}` +
				staleRemedy(m),
			undefined,
			key("STALE"),
		);
	else if (m.ageDays > WARN_DAYS)
		ctx.warn(
			"AGEING",
			`${where} — outstanding ${age} days (>${WARN_DAYS}), dated ${m.at}`,
			undefined,
			key("AGEING"),
		);
}

/** @param {Marker} m */
function staleRemedy(m) {
	return m.dateFrom === "sidecar"
		? `; re-confirm by re-dating \`knownIncomplete\` on ${m.where} in ` +
				`${DATA_FILES.restatements}, or complete the list and drop the field`
		: `; re-confirm by appending today's date, or tag it ${STANDING_TAG} ` +
				"if that date is one the marker states rather than confirms";
}

/**
 * The census lines: every marker, the sidecar's tally, and the permanent
 * markers' stated dates.
 *
 * @param {Ctx} ctx
 * @param {Marker[]} markers
 * @param {string} mapPath
 * @param {{read: number, quiet: number, aged: number, raised: number}|null} sidecar
 */
function sayCensus(ctx, markers, mapPath, sidecar) {
	/* Every marker prints, gating or not: criterion 1 of mantahostels#217 is that the
	 * report is the whole set. */
	ctx.say(`${markers.length} ⚠ marker(s) in ${mapPath}:\n`);
	/* A register row's location is its whole path, so the column is sized to
	 * what is actually there. */
	const width = Math.min(
		44,
		Math.max(0, ...markers.map((m) => m.where.length)),
	);
	for (const m of markers)
		ctx.say(
			`  ${truncate(m.where, width).padEnd(width)} ${(m.standing ? "standing" : `${m.ageDays} days`).padEnd(12)} ⚠ ${truncate(m.text, 78)}`,
		);

	/* Where every sidecar date sits beside a dated prose marker the limb adds
	 * no row at all — and where no sidecar is there to read it adds none
	 * either. Without this line the two are indistinguishable from each other
	 * and from the limb not having run. */
	ctx.say(
		sidecar
			? `\n${sidecar.read} knownIncomplete date(s) in ${DATA_FILES.restatements}: ` +
					`${sidecar.quiet} left to an entry's own no-older marker, ` +
					`${sidecar.aged} ageing one (older, or undated), ${sidecar.raised} raised here.`
			: `\nno ${DATA_FILES.restatements} beside ${mapPath}, so no sidecar date was aged.`,
	);

	/* A permanent marker prints as "standing" beside genuinely undated ones, so
	 * this is the only place its date appears. */
	const permanent = markers.filter((m) => m.permanent && m.at);
	if (permanent.length > 0) {
		ctx.say(
			`\n${permanent.length} carry a date that is stated, not confirmed, so nothing ages them:`,
		);
		for (const m of permanent)
			ctx.say(
				`  ${truncate(m.where, width).padEnd(width)} ${m.at}  ${m.permanent}`,
			);
	}
}

runCheck({
	name: "doc-map-markers",
	usage: "node check-doc-map-markers.js [<doc-map.md>] [--data-dir <dir>]",
	valueFlags: ["--data-dir"],
	run(/** @type {Ctx} */ ctx) {
		const mapPath = ctx.args[0] || "docs/doc-map.md";
		const dataDir = ctx.value("--data-dir", path.dirname(mapPath));

		const text = readMap(ctx, mapPath);
		const sectionBEmpty = isSectionBEmpty(ctx, text, mapPath);

		const registered = new Set(registerPaths(text));
		const now = Date.now();
		/* The WITA calendar day the run happens on — the boundary an action date
		 * sits beyond and a written date does not. */
		const today = witaDay(now);
		/* Whole WITA days, so the age never carries a fraction the document did
		 * not state. */
		/** @param {number} at */
		const ageOf = (at) => calendarDaysSince(at, now);
		const ageing = { today, ageOf };
		/** @type {Marker[]} */
		const prose = [];
		for (const { line, where, isRow } of locate(
			text,
			registered,
			classesBeside(dataDir),
		))
			for (const raw of markersOn(line, isRow))
				prose.push(proseMarker(raw, where, ageing));

		const { markers, census: sidecar } = ageSidecar(ctx, prose, {
			dataDir,
			ageOf,
			sectionBEmpty,
		});

		for (const m of markers) gateMarker(ctx, m);

		sayCensus(ctx, markers, mapPath, sidecar);

		/* The census above says how old everything is; this says which of them is a
		 * finding and why.
		 *
		 * No severity prefix: check.js owns the one `SEVERITY:` line a run emits, and
		 * the tag already says which fault this is. */
		if (ctx.findings.length > 0) {
			ctx.say("");
			for (const f of ctx.findings) ctx.say(`  ${f.tag.padEnd(9)}${f.message}`);
		}

		const dated = markers.filter((m) => !m.standing);
		ctx.say(
			`\nStanding markers never gate. A dated one WARNs past ${WARN_DAYS} days and ` +
				`FAILs past ${FAIL_DAYS};\nre-date it when you re-confirm it is still outstanding, ` +
				"or clear the marker with the work.\nRe-dating may append rather than " +
				'replace — "…, 20 Aug 2026; re-confirmed 18 Sep 2026" — the latest date ' +
				"winning.\nWhere the date is one the marker STATES rather than one anyone " +
				`confirmed — a supersession,\na corpus bound — write ${STANDING_TAG} in the ` +
				"marker instead. It never reaches a marker whose own\ntext says work is outstanding.\n",
		);

		return {
			okLine:
				`all ${markers.length} marker(s) current — ${dated.length} dated and ` +
				`inside ${WARN_DAYS} days, ${markers.length - dated.length} standing.`,
			noun: "ageing or undated doc-map marker(s)",
			data: { markers },
		};
	},
});
