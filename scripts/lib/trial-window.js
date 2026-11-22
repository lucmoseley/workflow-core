const fs = require("node:fs");
const path = require("node:path");
const { hostRoot } = require("./host-root.js");
const { requiredGroup } = require("./regex-group.js");
const { declaresLadder, ladderPath } = require("./workflow-core-config.js");
const { caught } = require("./caught.js");

/** @type {() => string} */
const LADDER = () =>
	process.env.WFC_LADDER || path.join(hostRoot(), ladderPath());

// lucmoseley/mantahostels#2847
const SECTION = "#### Gate 2 trial declaration";

// lucmoseley/mantahostels#2848 guess
const MAX_BASIS_STALE_HOURS = 24;

// lucmoseley/mantahostels#2848 guess
const MAX_WINDOW_DAYS = 21;

/**
 * @typedef {object} BasisSeat
 * @property {string} dir
 * @property {string} resetsAt
 * @property {number} staleHours
 */

/**
 * @typedef {object} ExcludedBaseline
 * @property {number} sevenDay
 * @property {string} resetsAt
 * @property {number} fetchedAtMs
 */

/**
 * @typedef {object} TrialDeclaration
 * @property {"none" | "malformed" | "unreadable" | "declared"} state
 * @property {string} [reason]
 * @property {string} [dir]
 * @property {string} [accountUuid]
 * @property {string} [startIso]
 * @property {string} [endIso]
 * @property {number} [startMs]
 * @property {number} [endMs]
 * @property {BasisSeat[]} [basis]
 * @property {ExcludedBaseline} [excludedBaseline]
 */

/** @type {TrialDeclaration} */
const NONE = { state: "none" };

/** @param {string} reason @returns {TrialDeclaration} */
const malformed = (reason) => ({ state: "malformed", reason });

/** @param {string} reason @returns {TrialDeclaration} */
const unreadable = (reason) => ({ state: "unreadable", reason });

/** @param {string} text @returns {string[] | null} */
function parseSectionLines(text) {
	const bare = text.replace(/<!--[\s\S]*?-->/g, "");
	const at = bare.indexOf(SECTION);
	if (at === -1) return null;
	/** @type {string[]} */
	const out = [];
	for (const line of bare.slice(at).split("\n").slice(1)) {
		if (/^#{1,4} /.test(line)) break;
		out.push(line);
	}
	return out;
}

/** @param {string[]} lines @param {string} key */
const field = (lines, key) => {
	const re = new RegExp(`^[-*]\\s+\\*\\*${key}:\\*\\*\\s*(.+?)\\s*$`);
	for (const line of lines) {
		const m = re.exec(line);
		if (m) return requiredGroup(m, 1, re);
	}
	return null;
};

const BACKTICKED = /^`([^`]+)`$/;
const WINDOW_LINE = /^`([^`]+)`\s*(?:→|->)\s*`([^`]+)`$/;
const BASIS_ENTRY =
	/^\s*`([^`]+)`\s+resets\s+`([^`]+)`\s+read\s+([\d.]+)h ago\s*$/;
const BASELINE_LINE =
	/^7d\s+(\d+)%\s*·\s*resets\s+`([^`]+)`\s*·\s*fetched\s+`([^`]+)`$/;

/** @param {string} text @returns {TrialDeclaration} */
function parseTrialWindow(text) {
	const lines = parseSectionLines(text);
	if (lines === null) return NONE;

	const seat = field(lines, "seat");
	const account = field(lines, "account");
	const basisText = field(lines, "start basis");
	const windowText = field(lines, "measured window");
	const baselineText = field(lines, "seat 3 at declaration");
	if (!seat && !account && !basisText && !windowText && !baselineText)
		return NONE;

	const dirM = seat === null ? null : BACKTICKED.exec(seat);
	if (!dirM) return malformed("no `seat` line naming a seat directory");
	const acctM = account === null ? null : BACKTICKED.exec(account);
	if (!acctM) return malformed("no `account` line naming an accountUuid");

	const window = parseWindow(windowText);
	if ("fault" in window) return malformed(window.fault);
	const { startMs, endMs } = window;
	const basis = parseBasis(basisText, startMs);
	if ("fault" in basis) return malformed(basis.fault);
	const excludedBaseline = parseBaseline(baselineText);
	if ("fault" in excludedBaseline) return malformed(excludedBaseline.fault);

	return {
		state: "declared",
		dir: requiredGroup(dirM, 1, BACKTICKED),
		accountUuid: requiredGroup(acctM, 1, BACKTICKED),
		startIso: new Date(startMs).toISOString(),
		endIso: new Date(endMs).toISOString(),
		startMs,
		endMs,
		basis: basis.seats,
		excludedBaseline,
	};
}

/**
 * @param {string|null} windowText
 * @returns {{fault: string} | {startMs: number, endMs: number}}
 */
function parseWindow(windowText) {
	const winM = windowText === null ? null : WINDOW_LINE.exec(windowText);
	if (!winM)
		return {
			fault: "no `measured window` line in the form `<start>` → `<end>`",
		};
	const startMs = Date.parse(requiredGroup(winM, 1, WINDOW_LINE));
	const endMs = Date.parse(requiredGroup(winM, 2, WINDOW_LINE));
	if (!Number.isFinite(startMs) || !Number.isFinite(endMs))
		return { fault: "the measured window's instants do not parse as dates" };
	if (endMs <= startMs)
		return { fault: "the measured window ends at or before it starts" };
	const days = (endMs - startMs) / 864e5;
	if (days > MAX_WINDOW_DAYS)
		return {
			fault:
				`the measured window runs ${Math.round(days)} days, over the ${MAX_WINDOW_DAYS}-day ` +
				"bound — the trial is a fortnight, so this is a mistyped end instant",
		};
	return { startMs, endMs };
}

/**
 * @param {string|null} basisText
 * @param {number} startMs
 * @returns {{fault: string} | {seats: BasisSeat[]}}
 */
function parseBasis(basisText, startMs) {
	if (basisText === null)
		return {
			fault: "no `start basis` line, so the start instant cannot be checked",
		};
	/** @type {BasisSeat[]} */
	const basis = [];
	for (const part of basisText.split("·")) {
		const seat = parseBasisEntry(part);
		if ("fault" in seat) return seat;
		basis.push(seat);
	}
	if (basis.length === 0)
		return { fault: "the `start basis` line names no seat" };

	const staleSeat = basis.find((b) => b.staleHours >= MAX_BASIS_STALE_HOURS);
	if (staleSeat)
		return {
			fault:
				`the start basis for \`${staleSeat.dir}\` was ${staleSeat.staleHours}h stale ` +
				`when read, at or over the ${MAX_BASIS_STALE_HOURS}h bound — its \`resets_at\` ` +
				"may be carried forward (mantahostels#2697), so the start instant cannot be trusted",
		};
	const latest = Math.max(...basis.map((b) => Date.parse(b.resetsAt)));
	if (latest !== startMs)
		return {
			fault:
				"the measured window does not start at the LATER of the start basis' " +
				`reset instants (${new Date(latest).toISOString()})`,
		};
	return { seats: basis };
}

/** @param {string} part @returns {{fault: string} | BasisSeat} */
function parseBasisEntry(part) {
	const m = BASIS_ENTRY.exec(part);
	if (!m)
		return {
			fault:
				"a `start basis` entry is not `<dir>` resets `<iso>` read <n>h ago",
		};
	const dir = requiredGroup(m, 1, BASIS_ENTRY);
	const resetsAt = requiredGroup(m, 2, BASIS_ENTRY);
	const at = Date.parse(resetsAt);
	if (!Number.isFinite(at))
		return { fault: "a `start basis` reset instant does not parse as a date" };
	const staleHours = Number(m[3]);
	if (!Number.isFinite(staleHours))
		return {
			fault: `the \`start basis\` staleness for \`${dir}\` is not a number`,
		};
	return { dir, resetsAt, staleHours };
}

/**
 * @param {string|null} baselineText
 * @returns {{fault: string} | ExcludedBaseline}
 */
function parseBaseline(baselineText) {
	const baseM = baselineText === null ? null : BASELINE_LINE.exec(baselineText);
	if (!baseM)
		return {
			fault:
				"no `seat 3 at declaration` line in the form 7d <n>% · resets `<iso>` · fetched `<iso>`",
		};
	const baselineResetsAt = requiredGroup(baseM, 2, BASELINE_LINE);
	const fetchedAtMs = Date.parse(requiredGroup(baseM, 3, BASELINE_LINE));
	if (
		!Number.isFinite(Date.parse(baselineResetsAt)) ||
		!Number.isFinite(fetchedAtMs)
	)
		return {
			fault: "the `seat 3 at declaration` instants do not parse as dates",
		};
	return {
		sevenDay: Number(requiredGroup(baseM, 1, BASELINE_LINE)),
		resetsAt: baselineResetsAt,
		fetchedAtMs,
	};
}

/**
 * @param {string} [file]
 * @param {{root?: string}} [host]
 * @returns {TrialDeclaration}
 */
function readTrialWindow(file = LADDER(), host = {}) {
	let text;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch (e) {
		const { code, message } = caught(e);
		if (code === "ENOENT" && !declaresLadder(host)) return NONE;
		return unreadable(
			`the ladder at ${file} could not be read (${code ?? message})`,
		);
	}
	return parseTrialWindow(text);
}

/**
 * @param {TrialDeclaration} decl
 * @param {number} [now]
 * @returns {"none" | "malformed" | "unreadable" | "pending" | "live" | "ended"}
 */
function windowPhase(decl, now = Date.now()) {
	if (decl.state !== "declared") return decl.state;
	if (now < /** @type {number} */ (decl.startMs)) return "pending";
	if (now < /** @type {number} */ (decl.endMs)) return "live";
	return "ended";
}

const trialLive = () => windowPhase(readTrialWindow(), Date.now()) === "live";

module.exports = {
	LADDER,
	readTrialWindow,
	trialLive,
	windowPhase,
};
