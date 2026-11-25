const fs = require("node:fs");
const path = require("node:path");
const { fileThrough } = require("./file-through.js");
const { findFiledLine } = require("./filed-line.js");
const { buildScriptFilerArgv } = require("./script-filer-argv.js");
const { gh, buildGhReaders, parseErrLine } = require("./gh.js");
const { gitCommonDir } = require("./git.js");
const { markersDir } = require("./marker-root.js");
const { pidLock } = require("./pid-lock.js");
const { takesLabel } = require("./takes-label.js");
const { requireKey } = require("./workflow-core-config.js");
const { writeFd } = require("./write-fd.js");

const LABEL = takesLabel("triage");

// guess, workflow-core#3094
const LOOKBACK_MS = 72 * 60 * 60 * 1000;

/** @param {string} file @returns {Record<string, number>} */
function readMarker(file) {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		return {};
	}
}

/** @param {string} root */
function sharedMarkersDir(root) {
	const common = gitCommonDir(root) ?? "";
	return markersDir(
		path.basename(common) === ".git" ? path.dirname(common) : root,
	);
}

/**
 * @param {string} title
 * @param {string} body
 * @param {string} standalone
 * @param {string} root
 * @returns {number|null}
 */
function fileOne(title, body, standalone, root) {
	const ran = fileThrough(
		buildScriptFilerArgv({
			title,
			labels: [LABEL],
			placement: { standalone },
			origin: "incident",
		}),
		body,
		root,
	);
	const n = findFiledLine(ran.stdout ?? "")?.n;
	if (n === undefined) {
		writeFd(
			2,
			`${title}: not filed: ${(ran.stderr || ran.error?.message || "").trim()}\n`,
		);
		return null;
	}
	writeFd(1, `${title}: filed #${n}.\n`);
	return n;
}

/**
 * @template T
 * @param {object} o
 * @param {string} o.root
 * @param {string} o.script
 * @param {string} o.marker
 * @param {string} o.what
 * @param {string} o.standalone
 * @param {T[]} o.incidents
 * @param {(i: T) => string} o.titleOf
 * @param {(i: T) => string} o.bodyOf
 * @param {(repo: string) => Map<string, number>} o.readTickets
 * @param {boolean} o.dryRun
 */
function fileIncidents({
	root,
	script,
	marker,
	what,
	standalone,
	incidents,
	titleOf,
	bodyOf,
	readTickets,
	dryRun,
}) {
	const markers = sharedMarkersDir(root);
	const markerFile = path.join(markers, `${marker}.json`);
	const due = () => {
		const recorded = readMarker(markerFile);
		return incidents.filter((i) => !(titleOf(i) in recorded));
	};
	if (due().length === 0) return 0;
	if (dryRun) {
		for (const i of due()) writeFd(1, `${titleOf(i)}\n\n${bodyOf(i)}\n`);
		return 0;
	}
	const lock = pidLock(path.join(markers, `${marker}.lock`), script);
	if (!lock.acquire()) return 0;
	try {
		const repo = requireKey("tracker", { root });
		let filed;
		try {
			filed = readTickets(repo);
		} catch (e) {
			writeFd(
				2,
				`could not list ${repo}'s ${what} (${parseErrLine(e)}). Nothing filed.\n`,
			);
			return 1;
		}
		let code = 0;
		for (const i of due()) {
			const title = titleOf(i);
			const n = filed.get(title) ?? fileOne(title, bodyOf(i), standalone, root);
			if (n === null) {
				code = 1;
				continue;
			}
			fs.writeFileSync(
				markerFile,
				`${JSON.stringify({ ...readMarker(markerFile), [title]: n })}\n`,
			);
		}
		return code;
	} finally {
		lock.release();
	}
}

/**
 * @param {string} repo
 * @param {string} what
 * @param {string} prefix
 * @param {typeof gh} [run]
 * @returns {Map<string, number>}
 */
function readTicketsByPrefix(repo, what, prefix, run = gh) {
	/** @type {{number: number, title: string}[]} */
	const found = buildGhReaders(run).ghIssueListAll(what, [
		"--repo",
		repo,
		"--state",
		"all",
		"--search",
		`in:title "${prefix.trim()}"`,
		"--json",
		"number,title",
	]);
	return new Map(
		found
			.filter((i) => i.title.startsWith(prefix))
			.map((i) => [i.title, i.number]),
	);
}

/** @param {Date} d */
const utcMinute = (d) => d.toISOString().slice(0, 16).replace("T", " ");

/** @param {Date} d */
const localMinute = (d) =>
	`${[d.getFullYear(), d.getMonth() + 1, d.getDate()]
		.map((v) => String(v).padStart(2, "0"))
		.join("-")} ${[d.getHours(), d.getMinutes()]
		.map((v) => String(v).padStart(2, "0"))
		.join(":")}`;

/** @param {string} name */
const buildProcessSpan = (name) =>
	`\`${name.replace(/[`|\p{Cc}]/gu, "?") || "(empty)"}\``;

module.exports = {
	LOOKBACK_MS,
	buildProcessSpan,
	fileIncidents,
	localMinute,
	readTicketsByPrefix,
	utcMinute,
};
