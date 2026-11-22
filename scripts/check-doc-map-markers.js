#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

/**
 * @typedef {import("./lib/check").Ctx} Ctx
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

const CLASSES_FILE = "doc-map-classes.json";

/** @param {string} dataDir */
function readClassesBeside(dataDir) {
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

const MARKER = /⚠(?=\s+\S)/g;

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

const WRITTEN = /\b(\d{1,2})\s+([A-Za-z]{3,9})\.?\s+(\d{4})\b/g;
const ISO = /\b(\d{4})-(\d{2})-(\d{2})\b/g;

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
 * @param {string} line
 * @param {boolean} [row]
 * @returns {string[]}
 */
function markersOn(line, row = false) {
	const starts = [...line.matchAll(MARKER)].map((m) => m.index);
	return starts.map((start, i) => {
		const wall = row ? line.indexOf("|", start) : -1;
		const ends = [line.length, starts[i + 1], wall === -1 ? undefined : wall];
		const text = line
			.slice(start + 1, Math.min(...ends.filter((e) => e !== undefined)))
			.trim();
		const openers = line.slice(0, start).split("**").length - 1;
		return openers % 2 === 1 ? text.replace("**", "") : text;
	});
}

/**
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

/** @param {string} text */
const plain = (text) => text.replace(/[*`_]/g, "").toLowerCase();

/**
 * @param {string} text
 * @param {number} [n]
 */
const truncate = (text, n = 96) =>
	text.length > n ? `${text.slice(0, n - 1)}…` : text;

/**
 * @param {string} text
 * @returns {string|null}
 */
function permanenceOf(text) {
	return plain(text).includes(STANDING_TAG) ? `tagged ${STANDING_TAG}` : null;
}

/**
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
 * @param {{figure: string|null|undefined, heading: string, inRegister: boolean}} at
 * @param {string} line
 */
function enterHeading(at, line) {
	const fig = line.match(FIGURE_ID);
	at.figure = fig ? fig[1] : null;
	at.heading = line.replace(/^#+\s*/, "").trim();
	if (/^## /.test(line)) at.inRegister = /^## Section A/.test(line);
}

/**
 * @param {{line: string, where: string, isRow: boolean}[]} located
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

const KNOWN_INCOMPLETE = "known incomplete";

/**
 * @param {Ctx} ctx
 * @param {Marker[]} markers
 * @param {{dataDir: string, ageOf: (at: number) => number, sectionBEmpty: boolean}} opts
 * @returns {{markers: Marker[], census: {read: number, quiet: number, aged: number, raised: number}|null}}
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
		if (y === undefined || m === undefined || d === undefined)
			return ctx.broken(`${id}: knownIncomplete \`${iso}\` is not YYYY-MM-DD`);
		const at = Date.UTC(y, m - 1, d);
		const ageDays = ageOf(at);

		const i = out.findIndex(
			(mk) => mk.where === id && plain(mk.text).includes(KNOWN_INCOMPLETE),
		);
		const prose = out[i];
		if (prose) {
			if (prose.at !== null && prose.at <= iso) {
				census.quiet++;
				continue;
			}
			out[i] = {
				...prose,
				at: iso,
				ageDays,
				standing: false,
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

/**
 * @param {Ctx} ctx
 * @param {string} text
 * @param {string} mapPath
 * @returns {boolean}
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
 * @param {string} raw
 * @param {string} where
 * @param {{today: number, ageOf: (at: number) => number}} ageing
 * @returns {Marker}
 */
function proseMarker(raw, where, { today, ageOf }) {
	const phrase = OUTSTANDING.find((p) => plain(raw).includes(p));
	const barred = NEVER_PERMANENT.find((p) => plain(raw).includes(p));
	const permanent = barred ? null : permanenceOf(raw);
	const at = anchorDate(raw, today);
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
 * @param {Ctx} ctx
 * @param {Marker} m
 */
function gateMarker(ctx, m) {
	const where = `${m.where}: ${truncate(m.text)}`;
	// #1591
	const key = (/** @type {string} */ tag) => `${tag}\t${m.where}\t${m.text}`;
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
 * @param {Ctx} ctx
 * @param {Marker[]} markers
 * @param {string} mapPath
 * @param {{read: number, quiet: number, aged: number, raised: number}|null} sidecar
 */
function sayCensus(ctx, markers, mapPath, sidecar) {
	ctx.say(`${markers.length} ⚠ marker(s) in ${mapPath}:\n`);
	const width = Math.min(
		44,
		Math.max(0, ...markers.map((m) => m.where.length)),
	);
	for (const m of markers)
		ctx.say(
			`  ${truncate(m.where, width).padEnd(width)} ${(m.standing ? "standing" : `${m.ageDays} days`).padEnd(12)} ⚠ ${truncate(m.text, 78)}`,
		);

	ctx.say(
		sidecar
			? `\n${sidecar.read} knownIncomplete date(s) in ${DATA_FILES.restatements}: ` +
					`${sidecar.quiet} left to an entry's own no-older marker, ` +
					`${sidecar.aged} ageing one (older, or undated), ${sidecar.raised} raised here.`
			: `\nno ${DATA_FILES.restatements} beside ${mapPath}, so no sidecar date was aged.`,
	);

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
		const today = witaDay(now);
		/** @param {number} at */
		const ageOf = (at) => calendarDaysSince(at, now);
		const ageing = { today, ageOf };
		/** @type {Marker[]} */
		const prose = [];
		for (const { line, where, isRow } of locate(
			text,
			registered,
			readClassesBeside(dataDir),
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
