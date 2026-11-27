// workflow-core#5804

const { requiredGroup } = require("./regex-group.js");

/**
 * @typedef {{pos: number, bits: number}} BitField
 * @typedef {{base: bigint, count: bigint}} Run
 * @typedef {{database: bigint, entrySize: number, u4Offset: number,
 *   fields: Record<string, BitField>, runs: Run[]}} Layout
 * @typedef {{pfn: bigint, address: bigint, qword: bigint, reasons: string[]}} Flagged
 * @typedef {{entries: bigint, read: bigint, flagged: Flagged[],
 *   patterns: Map<bigint, number>}} Scan
 */

const MARK = "@@";
// guess, workflow-core#5735: its 4,095 neighbours used six patterns, each many times over
const RARE_PATTERN = 3;

/** @param {string} text */
function hex(text) {
	return BigInt(`0x${text.replace(/`/g, "")}`);
}

/**
 * @param {string} out
 * @returns {Record<string, string>}
 */
function sections(out) {
	/** @type {Record<string, string>} */
	const found = {};
	const re = new RegExp(`^.*?${MARK}(\\w+)\\s*$`, "gm");
	const marks = [...out.matchAll(re)];
	marks.forEach((m, i) => {
		const end = marks[i + 1]?.index ?? out.length;
		found[requiredGroup(m, 1, re)] = out.slice(
			(m.index ?? 0) + m[0].length,
			end,
		);
	});
	return found;
}

/** @param {string} name */
const echo = (name) => `.echo ${MARK}${name}`;

const IDENTITY_COMMANDS = [echo("lmi"), "!lmi nt", echo("end"), "q"];

/**
 * @param {string} out
 * @returns {{pdb: string, key: string} | {why: string}}
 */
function parseIdentity(out) {
	const re = /GUID: \{([0-9A-Fa-f-]+)\}\s+Age: ([0-9A-Fa-f]+), Pdb: (\S+)/;
	const m = re.exec(sections(out).lmi ?? "");
	if (!m) return { why: "`!lmi nt` printed no CODEVIEW GUID" };
	const guid = requiredGroup(m, 1, re).replace(/-/g, "");
	return {
		pdb: requiredGroup(m, 3, re),
		key: `${guid}${requiredGroup(m, 2, re)}`.toUpperCase(),
	};
}

// guess, workflow-core#5804: the 24 Nov dump has 15 runs
const MAX_RUNS = 64;

const LAYOUT_COMMANDS = [
	echo("db"),
	"? poi(nt!MmPfnDatabase)",
	echo("size"),
	"?? sizeof(nt!_MMPFN)",
	echo("u4"),
	"dt nt!_MMPFN u4.",
	echo("nruns"),
	"dd poi(nt!MmPhysicalMemoryBlock) L1",
	echo("runs"),
	`dq poi(nt!MmPhysicalMemoryBlock)+10 L${(MAX_RUNS * 2).toString(16)}`,
	echo("end"),
	"q",
];

/**
 * @param {string} text
 * @returns {bigint[]}
 */
function dumpWords(text) {
	/** @type {bigint[]} */
	const words = [];
	for (const line of text.split("\n")) {
		const cols = line.trim().split(/\s+/);
		if (cols.length < 2 || !/^[0-9a-f]+`[0-9a-f]+$/i.test(cols[0] ?? ""))
			continue;
		for (const c of cols.slice(1)) {
			if (!/^[0-9a-f`]+$/i.test(c)) break;
			words.push(hex(c));
		}
	}
	return words;
}

/** @param {string} text @returns {Record<string, BitField>} */
function parseFields(text) {
	/** @type {Record<string, BitField>} */
	const fields = {};
	const re = /\+0x[0-9a-f]+ (\w+) +: Pos (\d+), (\d+) Bits?/g;
	for (const m of text.matchAll(re))
		fields[requiredGroup(m, 1, re)] = {
			pos: Number(requiredGroup(m, 2, re)),
			bits: Number(requiredGroup(m, 3, re)),
		};
	return fields;
}

/**
 * @param {string} countText
 * @param {string} runsText
 * @returns {Run[] | {why: string}}
 */
function parseRuns(countText, runsText) {
	const [n] = dumpWords(countText);
	const words = dumpWords(runsText);
	const count = Number(n ?? BigInt(0));
	if (count === 0 || count > MAX_RUNS || words.length < count * 2)
		return { why: `MmPhysicalMemoryBlock read ${count} runs` };
	/** @type {Run[]} */
	const runs = [];
	for (let i = 0; i < count; i++)
		runs.push({
			base: words[i * 2] ?? BigInt(0),
			count: words[i * 2 + 1] ?? BigInt(0),
		});
	return runs;
}

/**
 * @param {string} out
 * @returns {Layout | {why: string}}
 */
function parseLayout(out) {
	const s = sections(out);
	const dbRe = /Evaluate expression: .* = ([0-9a-f`]+)/i;
	const sizeRe = /unsigned int64 (0x[0-9a-f]+)/i;
	const u4Re = /\+(0x[0-9a-f]+) u4/i;
	const db = dbRe.exec(s.db ?? "");
	const size = sizeRe.exec(s.size ?? "");
	const u4 = u4Re.exec(s.u4 ?? "");
	if (!db || !size || !u4)
		return { why: "the kernel symbols gave no MmPfnDatabase or _MMPFN" };
	const fields = parseFields(s.u4 ?? "");
	if (!fields.PteFrame || !fields.Partition)
		return { why: "_MMPFN u4 has no PteFrame or Partition field" };
	const runs = parseRuns(s.nruns ?? "", s.runs ?? "");
	if ("why" in runs) return runs;
	return {
		database: hex(requiredGroup(db, 1, dbRe)),
		entrySize: Number(requiredGroup(size, 1, sizeRe)),
		u4Offset: Number(requiredGroup(u4, 1, u4Re)),
		fields,
		runs,
	};
}

/**
 * @param {bigint} value
 * @param {BitField} f
 */
const field = (value, f) =>
	(value >> BigInt(f.pos)) & ((BigInt(1) << BigInt(f.bits)) - BigInt(1));

/**
 * @param {bigint} pfn
 * @param {Run[]} runs
 */
const isRam = (pfn, runs) =>
	runs.some((r) => pfn >= r.base && pfn < r.base + r.count);

/** @param {BitField} pteFrame */
const patternShift = (pteFrame) => BigInt(pteFrame.pos + pteFrame.bits);

/** @param {Layout} layout @returns {Scan} */
function emptyScan(layout) {
	return {
		entries: layout.runs.reduce((n, r) => n + r.count, BigInt(0)),
		read: BigInt(0),
		flagged: [],
		patterns: new Map(),
	};
}

/**
 * @param {Scan} scan
 * @param {Layout} layout
 * @param {bigint} first
 * @param {Buffer} bytes
 */
function scanInto(scan, layout, first, bytes) {
	const { PteFrame: pte, Partition: part, Unused1: unused } = layout.fields;
	if (!pte || !part) return;
	const shift = patternShift(pte);
	// measured, workflow-core#5804: 118,594 entries in the 24 Nov dump carry the frame 0xffffffffe
	const sentinel = (BigInt(1) << BigInt(pte.bits)) - BigInt(2);
	const n = Math.floor(bytes.length / layout.entrySize);
	for (let i = 0; i < n; i++) {
		const qword = bytes.readBigUInt64LE(i * layout.entrySize + layout.u4Offset);
		const pfn = first + BigInt(i);
		const pattern = qword >> shift;
		scan.patterns.set(pattern, (scan.patterns.get(pattern) ?? 0) + 1);
		/** @type {string[]} */
		const reasons = [];
		const frame = field(qword, pte);
		if (frame !== BigInt(0) && frame < sentinel && !isRam(frame, layout.runs))
			reasons.push(`PteFrame 0x${frame.toString(16)} is not RAM`);
		const partition = field(qword, part);
		if (partition !== BigInt(0))
			reasons.push(`Partition 0x${partition.toString(16)}`);
		if (unused && field(qword, unused) !== BigInt(0))
			reasons.push("Unused1 set");
		if (reasons.length > 0)
			scan.flagged.push({
				pfn,
				address: layout.database + pfn * BigInt(layout.entrySize),
				qword,
				reasons,
			});
	}
	scan.read += BigInt(n);
}

/**
 * @param {Scan} scan
 * @param {Layout} layout
 * @param {bigint} first
 * @param {Buffer} bytes
 */
function flagRareInto(scan, layout, first, bytes) {
	const pte = layout.fields.PteFrame;
	if (!pte) return;
	const shift = patternShift(pte);
	const n = Math.floor(bytes.length / layout.entrySize);
	const byPfn = new Map(scan.flagged.map((f) => [f.pfn, f]));
	for (let i = 0; i < n; i++) {
		const qword = bytes.readBigUInt64LE(i * layout.entrySize + layout.u4Offset);
		const pattern = qword >> shift;
		if ((scan.patterns.get(pattern) ?? 0) > RARE_PATTERN) continue;
		const pfn = first + BigInt(i);
		const reason = `rare high bits 0x${pattern.toString(16)}`;
		const known = byPfn.get(pfn);
		if (known) known.reasons.push(reason);
		else
			scan.flagged.push({
				pfn,
				address: layout.database + pfn * BigInt(layout.entrySize),
				qword,
				reasons: [reason],
			});
	}
}

// guess, workflow-core#5804
const CHUNK_ENTRIES = BigInt(0x1_00_00);

/**
 * @param {Layout} layout
 * @returns {{first: bigint, count: bigint, address: bigint}[]}
 */
function chunks(layout) {
	const out = [];
	for (const r of layout.runs)
		for (let at = BigInt(0); at < r.count; at += CHUNK_ENTRIES) {
			const count = r.count - at < CHUNK_ENTRIES ? r.count - at : CHUNK_ENTRIES;
			const first = r.base + at;
			out.push({
				first,
				count,
				address: layout.database + first * BigInt(layout.entrySize),
			});
		}
	return out;
}

const QWORD_DIGITS = 16;
// guess, workflow-core#5804: the 24 Nov dump has 8 patterns in all
const PATTERNS_SHOWN = 8;

/** @param {bigint} v */
const hx = (v) => `0x${v.toString(16)}`;
/** @param {bigint} v */
const qw = (v) => {
	const s = v.toString(16).padStart(QWORD_DIGITS, "0");
	return `${s.slice(0, QWORD_DIGITS / 2)}'${s.slice(QWORD_DIGITS / 2)}`;
};

// guess, workflow-core#5804
const REPORT_ROWS = 40;

/**
 * @param {Scan} scan
 * @param {{dump: string, combining: string, earlier: Set<string>}} context
 */
function formatReport(scan, { dump, combining, earlier }) {
	const pct =
		scan.entries === BigInt(0)
			? 0
			: Number((scan.read * BigInt(10_000)) / scan.entries) / 100;
	const lines = [
		`**PFN scan — \`${dump}\`** (workflow-core#5804)`,
		"",
		`- Page combining before the dump: ${combining}`,
		`- Entries read: ${scan.read} of ${scan.entries} (${pct}%)`,
		`- Flagged +0x28 qwords: **${scan.flagged.length}**`,
	];
	if (scan.flagged.length > 0) {
		lines.push(
			"",
			"| PFN | Entry | +0x28 qword | Why | In an earlier scan |",
			"|---|---|---|---|---|",
		);
		for (const f of scan.flagged.slice(0, REPORT_ROWS))
			lines.push(
				`| ${hx(f.pfn)} | \`${qw(f.address)}\` | \`${qw(f.qword)}\` | ${f.reasons.join("; ")} | ${earlier.has(hx(f.pfn)) ? "yes" : "no"} |`,
			);
		if (scan.flagged.length > REPORT_ROWS)
			lines.push(
				"",
				`${scan.flagged.length - REPORT_ROWS} more in the scan's JSON.`,
			);
	}
	const top = [...scan.patterns.entries()].sort((a, b) => b[1] - a[1]);
	lines.push(
		"",
		`High-bit patterns (bits above PteFrame), ${top.length} seen: ${top
			.slice(0, PATTERNS_SHOWN)
			.map(([p, n]) => `${hx(p)} ×${n}`)
			.join(", ")}`,
		"",
		"A live dump of a running system can catch an entry mid-update: an entry counts as damaged only where a later dump shows it too.",
	);
	return lines.join("\n");
}

/** @param {Scan} scan */
const toJson = (scan) => ({
	entries: String(scan.entries),
	read: String(scan.read),
	flagged: scan.flagged.map((f) => ({
		pfn: hx(f.pfn),
		address: hx(f.address),
		qword: hx(f.qword),
		reasons: f.reasons,
	})),
	patterns: Object.fromEntries(
		[...scan.patterns.entries()].map(([p, n]) => [hx(p), n]),
	),
});

module.exports = {
	IDENTITY_COMMANDS,
	LAYOUT_COMMANDS,
	flagRareInto,
	chunks,
	emptyScan,
	formatReport,
	parseIdentity,
	parseLayout,
	scanInto,
	toJson,
};
