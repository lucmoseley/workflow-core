const {
	escapeShield,
	parseCommand,
	unmask,
	unwrap,
	wrapperScript,
} = require("./shell-parse.js");
const { afterSlash, literal } = require("./shell-words.js");
const { trimEndRun } = require("./trim-run.js");

const ZERO = BigInt(0);
const ONE = BigInt(1);
const TWO = BigInt(2);
const HUNDRED = BigInt(100);

// guess, #5529
const MAX_DEPTH = 3;
// 55 ms for 147 KB measured, #5529
const MAX_SCRIPT_BYTES = 262_144;

const BUSY_BODY = [
	":",
	"true",
	"false",
	"echo",
	"printf",
	"let",
	"test",
	"[",
	"[[",
	"break",
	"continue",
];

const RESERVED = ["do", "then", "else", "elif", "!", "{", "}", "if", "time"];

const RELEVANT = [
	"yes",
	"stress",
	"stress-ng",
	"systemd-run",
	"taskset",
	"source",
	".",
	"eval",
	"flock",
	"watch",
	"bash",
	"sh",
	"dash",
	"zsh",
	"ksh",
];

const SHELLS = ["bash", "sh", "dash", "zsh", "ksh"];

const SCRIPT_WRAPPERS = ["flock", "watch"];

const CAP_WRAPPERS = ["taskset"];

const SINKS = ["cat", "tee", "dd", "pv"];

const QUOTA_VALUE_FLAGS = [
	"-u",
	"--unit",
	"-E",
	"--setenv",
	"-M",
	"--machine",
	"-H",
	"--host",
	"--slice",
	"--description",
	"--uid",
	"--gid",
	"--nice",
	"--working-directory",
	"--on-calendar",
	"--on-active",
	"--timer-property",
	"--path-property",
	"--socket-property",
	"--service-type",
];

const SHELL_VALUE_FLAGS = ["-o", "+o", "-O", "+O", "--rcfile", "--init-file"];

const WS = "[ \\t\\n\\v\\f\\r]*";

/**
 * @typedef {object} CpuLoadPorts
 * @property {() => string} coreCount
 * @property {(path: string, maxBytes: number) => string | null} readScript
 * @typedef {import("./kit-context.js").KitContext & CpuLoadPorts} CpuLoadContext
 * @typedef {object} Scan
 * @property {bigint} maxCpus
 * @property {bigint} maxQuota
 * @property {string} base
 * @property {CpuLoadContext} ctx
 * @typedef {{ capped: boolean, runFrom: number }} Cap
 * @typedef {object} Verdict
 * @property {"generator" | "capped" | "multi"} kind
 * @property {string} where
 */

/**
 * @param {string} word
 * @param {string[]} spans
 */
function lit(word, spans) {
	const { text, known } = literal(word, spans);
	return { text: trimEndRun(text, "\n"), known };
}

/** @param {string} digits */
function arith(digits) {
	if (digits.length > 1 && digits.startsWith("0")) {
		if (/[89]/.test(digits)) return null;
		return BigInt.asIntN(64, BigInt(`0o${digits.slice(1)}`));
	}
	return BigInt.asIntN(64, BigInt(digits));
}

const SPLIT_SHIELD = escapeShield("&|;()<>$");

/** @param {string} masked */
function splitLines(masked) {
	return masked
		.split("\n")
		.map((line) =>
			SPLIT_SHIELD.shield(line)
				.replace(/([<>])&/g, "$1\x03")
				.replace(/&>/g, "\x03>")
				.replace(/>\|/g, ">\x04")
				.replace(
					new RegExp(`for${WS}\\(\\(${WS};${WS};${WS}\\)\\)`, "g"),
					"while true",
				)
				.replace(
					new RegExp(`while${WS}\\(\\(${WS}1${WS}\\)\\)`, "g"),
					"while true",
				)
				.replace(/\$\(\([^()]*\)\)/g, "0")
				.replace(/\(\([^()]*\)\)/g, "let")
				.replace(/(&&|\|\||\|&|[;&|()])/g, "\x05$1\n"),
		)
		.join("\n")
		.split("\n")
		.map(SPLIT_SHIELD.unshield);
}

/** @param {string} s */
const ifsWords = (s) => s.split(/[ \t\n]+/).filter((w) => w !== "");

/**
 * @param {string[]} words
 * @param {number} i
 * @param {string[]} spans
 * @returns {{ step: number, v: string } | { runFrom: number }}
 */
function quotaWord(words, i, spans) {
	const w = lit(words[i] ?? "", spans).text;
	if (w === "--") return { runFrom: i + 1 };
	if (w === "-p" || w === "--property")
		return { step: 2, v: lit(words[i + 1] ?? "", spans).text };
	if (w.startsWith("-p") || w.startsWith("--property="))
		return { step: 1, v: w.replace(/^--property=/, "").replace(/^-p/, "") };
	if (QUOTA_VALUE_FLAGS.includes(w)) return { step: 2, v: "" };
	if (w.startsWith("-")) return { step: 1, v: "" };
	return { runFrom: i };
}

/**
 * @param {string} v
 * @returns {bigint | null | undefined}
 */
function quotaOf(v) {
	const m = /^CPUQuota=([0-9]+)(\.([0-9]*))?%$/.exec(v);
	if (!m) return;
	const quota = arith(m[1] ?? "");
	if (quota === null || !/[1-9]/.test(m[3] ?? "")) return quota;
	return BigInt.asIntN(64, quota + ONE);
}

/**
 * @param {string[]} words
 * @param {string[]} spans
 * @param {Scan} scan
 * @returns {Cap}
 */
function cappedQuota(words, spans, scan) {
	/** @type {bigint | null | undefined} */
	let quota;
	let runFrom = words.length;
	for (let i = 1; i < words.length; ) {
		const r = quotaWord(words, i, spans);
		if ("runFrom" in r) {
			runFrom = r.runFrom;
			break;
		}
		const q = quotaOf(r.v);
		if (q !== undefined) quota = q;
		i += r.step;
	}
	return {
		capped: typeof quota === "bigint" && quota <= scan.maxQuota,
		runFrom,
	};
}

/**
 * @param {string} part
 * @returns {bigint | null}
 */
function partCount(part) {
	const range = /^([0-9]+)-([0-9]+)(:([1-9][0-9]*))?$/.exec(part);
	if (!range) return /^[0-9]+$/.test(part) ? ONE : null;
	const lo = arith(range[1] ?? "");
	const hi = arith(range[2] ?? "");
	if (lo === null || hi === null || hi < lo) return null;
	const stride = arith(range[4] ?? "1") ?? ONE;
	if (stride === ZERO) return ZERO;
	const width = BigInt.asIntN(64, hi - lo);
	return width / stride + ONE;
}

/**
 * @param {string} spec
 * @param {boolean} isList
 * @returns {bigint | null}
 */
function cpuCount(spec, isList) {
	let n = ZERO;
	if (!isList) {
		const mask = spec.replace(/^0x/, "");
		if (!/^[0-9a-fA-F]{1,15}$/.test(mask)) return null;
		for (let m = BigInt(`0x${mask}`); m; m >>= ONE) n += m & ONE;
		return n;
	}
	const parts = (spec.split("\n")[0] ?? "").split(",");
	if (parts.at(-1) === "") parts.pop();
	for (const part of parts) {
		const count = partCount(part);
		if (count === null) return null;
		n = BigInt.asIntN(64, n + count);
	}
	return n;
}

/**
 * @param {string[]} words
 * @param {string[]} spans
 * @param {Scan} scan
 * @returns {Cap}
 */
function cappedTaskset(words, spans, scan) {
	let isList = false;
	for (let i = 1; i < words.length; i++) {
		const w = lit(words[i] ?? "", spans).text;
		if (w === "-p" || w === "--pid")
			return { capped: false, runFrom: words.length };
		if (w === "-c" || w === "--cpu-list") isList = true;
		else if (!w.startsWith("-")) {
			const n = cpuCount(w, isList);
			if (n === null) {
				scan.ctx.log(`taskset affinity '${w}' unreadable — taken as a cap`);
				return { capped: true, runFrom: i + 1 };
			}
			return { capped: n <= scan.maxCpus, runFrom: i + 1 };
		}
	}
	return { capped: false, runFrom: words.length };
}

/**
 * @param {string} text
 * @param {number} depth
 * @param {string} where
 * @param {Scan} scan
 */
function scanText(text, depth, where, scan) {
	if (depth >= MAX_DEPTH) return null;
	return scanSubject(text, depth, where, scan);
}

/**
 * @param {string} word
 * @param {string[]} spans
 * @param {number} depth
 * @param {Scan} scan
 */
function scanScript(word, spans, depth, scan) {
	const { text: shown, known } = lit(word, spans);
	if (!known) return null;
	const path = shown.startsWith("/") ? shown : `${scan.base}/${shown}`;
	const text = scan.ctx.readScript(path, MAX_SCRIPT_BYTES);
	if (text === null) return null;
	return scanText(
		trimEndRun(text.replaceAll("\0", ""), "\n"),
		depth,
		shown,
		scan,
	);
}

/** @param {string} where @returns {Verdict} */
const buildGenerator = (where) => ({ kind: "generator", where });

/**
 * @typedef {{ sep: string, next: string, depth: number, where: string }} At
 * @typedef {(at: At, words: string[], spans: string[], scan: Scan) =>
 *   Verdict | null} Judge
 */

/**
 * @param {Cap} cap
 * @param {(runFrom: number) => Verdict | null} judgeRest
 * @returns {Verdict | null}
 */
function underCap({ capped, runFrom }, judgeRest) {
	const inner = judgeRest(runFrom);
	return capped && inner ? { ...inner, kind: "capped" } : inner;
}

/** @type {Judge} */
const judgeQuota = (at, words, spans, scan) =>
	underCap(cappedQuota(words, spans, scan), (from) =>
		judge(at, words.slice(from), spans, scan),
	);

/** @type {Judge} */
const judgeTaskset = (at, words, spans, scan) =>
	underCap(cappedTaskset(words, spans, scan), (from) =>
		judge(at, words.slice(from), spans, scan),
	);

/** @type {Judge} */
function judgeYes(at, words) {
	if (at.sep !== "|" && at.sep !== "|&") return buildGenerator(at.where);
	if (words.slice(1).some((w) => /^(1?>|&>)/.test(w)))
		return buildGenerator(at.where);
	return SINKS.includes(at.next) ? buildGenerator(at.where) : null;
}

/** @type {Judge} */
function judgeStress(at, words, spans) {
	const only = lit(words[1] ?? "", spans).text;
	if (words.length === 2 && /^(--version|--help|-V|-h|-\?)$/.test(only))
		return null;
	return buildGenerator(at.where);
}

/** @type {Judge} */
const judgeSource = (at, words, spans, scan) =>
	words.length > 1
		? scanScript(words[1] ?? "", spans, at.depth + 1, scan)
		: null;

/** @type {Judge} */
function judgeEval(at, words, spans, scan) {
	const arg = words
		.slice(1)
		.map((w) => `${lit(w, spans).text} `)
		.join("");
	return scanText(arg, at.depth + 1, at.where, scan);
}

/**
 * @param {string} w
 * @returns {{ step: number, code: boolean } | "check" | null}
 */
function shellFlag(w) {
	if (SHELL_VALUE_FLAGS.includes(w)) return { step: 2, code: false };
	const flag = w.startsWith("-");
	const long = w.startsWith("--");
	if (flag && w.slice(1).includes("n"))
		return long ? { step: 1, code: false } : "check";
	if (flag && w.slice(1).includes("c")) return { step: 1, code: !long };
	if (flag || w.startsWith("+")) return { step: 1, code: false };
	return null;
}

/**
 * @param {string[]} words
 * @param {string[]} spans
 */
function shellOperand(words, spans) {
	let code = false;
	let i = 1;
	while (i < words.length) {
		const w = lit(words[i] ?? "", spans).text;
		if (w === "--") return { i: i + 1, code };
		const f = shellFlag(w);
		if (f === "check") return null;
		if (f === null) break;
		code ||= f.code;
		i += f.step;
	}
	return { i, code };
}

/** @type {Judge} */
function judgeShell(at, words, spans, scan) {
	const op = shellOperand(words, spans);
	if (op === null || op.i >= words.length) return null;
	const { i } = op;
	const arg = lit(words[i] ?? "", spans).text;
	if (op.code) return scanText(arg, at.depth + 1, at.where, scan);
	if (afterSlash(arg) === "bg-run.sh") {
		if (lit(words[i + 1] ?? "", spans).text !== "run") return null;
		return judge(at, words.slice(i + 3), spans, scan);
	}
	return scanScript(words[i] ?? "", spans, at.depth + 1, scan);
}

/** @type {Judge} */
const judgeScript = (at, words, spans, scan) =>
	scanScript(words[0] ?? "", spans, at.depth + 1, scan);

/** @type {Judge} */
function judgeScriptWrapper(at, words, spans, scan) {
	const script = wrapperScript(words, spans);
	if (script === null)
		return judgeRuns(at, words, { spans, scan, judged: CAP_WRAPPERS });
	return scanText(script, at.depth + 1, at.where, scan);
}

/** @type {Map<string, Judge>} */
const JUDGES = new Map([
	["flock", judgeScriptWrapper],
	["watch", judgeScriptWrapper],
	["systemd-run", judgeQuota],
	["taskset", judgeTaskset],
	["yes", judgeYes],
	["stress", judgeStress],
	["stress-ng", judgeStress],
	["source", judgeSource],
	[".", judgeSource],
	["eval", judgeEval],
	...SHELLS.map((s) => /** @type {[string, Judge]} */ ([s, judgeShell])),
]);

/**
 * @param {At} at
 * @param {string[]} raw
 * @param {string[]} spans
 * @param {Scan} scan
 * @returns {Verdict | null}
 */
const judge = (at, raw, spans, scan) =>
	judgeRuns(at, raw, {
		spans,
		scan,
		judged: [...CAP_WRAPPERS, ...SCRIPT_WRAPPERS],
	});

/**
 * @param {At} at
 * @param {string[]} raw
 * @param {{ spans: string[], scan: Scan, judged: string[] }} with
 * @returns {Verdict | null}
 */
function judgeRuns(at, raw, { spans, scan, judged }) {
	for (const { words } of unwrap(raw, spans, judged)) {
		if (words.length === 0) continue;
		const cmd = afterSlash(lit(words[0] ?? "", spans).text);
		const by = JUDGES.get(cmd) ?? (cmd.endsWith(".sh") ? judgeScript : null);
		const verdict = by ? by(at, words, spans, scan) : null;
		if (verdict) return verdict;
	}
	return null;
}

/** @param {string[]} words */
const isRelevant = (words) =>
	words.some((w) => {
		const name = afterSlash(w);
		return RELEVANT.includes(name) || name.endsWith(".sh");
	});

/**
 * @typedef {object} ScanState
 * @property {string[]} lines
 * @property {string[]} spans
 * @property {number} depth
 * @property {string} suffix
 * @property {Scan} scan
 * @property {number} caseDepth
 * @property {boolean} pattern
 * @property {string} prev
 * @property {Verdict | null} capped
 * @property {{ busy: boolean, head: string }[]} frames
 */

/** @param {string} line */
function readLine(line) {
	const cut = line.indexOf("\x05");
	const sep = cut === -1 ? "\n" : line.slice(cut + 1);
	const seg = (cut === -1 ? line : line.slice(0, cut))
		.replaceAll("\x03", "&")
		.replaceAll("\x04", "|");
	let words = ifsWords(seg);
	while (words.length > 0 && RESERVED.includes(words[0] ?? ""))
		words = words.slice(1);
	return { sep, words };
}

/**
 * @param {ScanState} st
 * @param {string[]} words
 * @param {string} sep
 */
function skipsCase(st, words, sep) {
	const first = words[0] ?? "";
	if (st.caseDepth && first === "esac") {
		st.caseDepth -= 1;
		st.pattern = false;
		st.prev = sep;
		return true;
	}
	if (st.pattern) {
		if (sep === ")") st.pattern = false;
		st.prev = sep;
		return true;
	}
	if (st.caseDepth && words.length === 0 && sep === ";" && st.prev === ";")
		st.pattern = true;
	st.prev = sep;
	if (first !== "case") return false;
	st.caseDepth += 1;
	st.pattern = sep !== ")";
	return true;
}

/**
 * @param {ScanState} st
 * @param {string[]} words
 * @param {string} sep
 * @returns {Verdict | null | undefined}
 */
function loopWord(st, words, sep) {
	const first = words[0] ?? "";
	if (first === "while" || first === "until") {
		const head = words.join(" ");
		st.frames.push({
			busy: /^(while (true|:)|until false)$/.test(head),
			head,
		});
		return null;
	}
	if (first === "for" || first === "select") {
		st.frames.push({ busy: false, head: "" });
		return null;
	}
	if (first !== "done") return;
	const top = st.frames.pop();
	if (!top) return null;
	const parent = st.frames.at(-1);
	if (parent) parent.busy = false;
	return top.busy && sep === "&"
		? buildGenerator(`${unmask(top.head)}; do …; done &${st.suffix}`)
		: null;
}

/**
 * @param {string[]} lines
 * @param {number} idx
 */
function readerAfter(lines, idx) {
	const after = lines[idx + 1] ?? "";
	const cut = after.indexOf("\x05");
	return afterSlash(
		ifsWords(cut === -1 ? after : after.slice(0, cut))[0] ?? "",
	);
}

/**
 * @param {ScanState} st
 * @param {string[]} words
 * @param {string} sep
 * @param {number} idx
 * @returns {At}
 */
function lineAt(st, words, sep, idx) {
	const piped = sep === "|" || sep === "|&";
	const shown = `${unmask(words.join(" "))}${sep === "&" ? " &" : ""}`;
	return {
		sep,
		next: piped && idx + 1 < st.lines.length ? readerAfter(st.lines, idx) : "",
		depth: st.depth,
		where: `${shown}${st.suffix}`,
	};
}

/**
 * @param {ScanState} st
 * @param {string} line
 * @param {number} idx
 * @returns {Verdict | null}
 */
function scanLine(st, line, idx) {
	const { sep, words } = readLine(line);
	if (skipsCase(st, words, sep)) return null;
	const first = words[0] ?? "";
	if (words.length === 0 || first.startsWith("#")) return null;
	const loop = loopWord(st, words, sep);
	if (loop !== undefined) return loop;
	const top = st.frames.at(-1);
	if (top && !BUSY_BODY.includes(first) && !/^[A-Za-z_].*=/s.test(first))
		top.busy = false;
	if (!isRelevant(words)) return null;
	const verdict = judge(lineAt(st, words, sep, idx), words, st.spans, st.scan);
	if (verdict === null) return null;
	if (verdict.kind !== "capped") return verdict;
	if (st.capped !== null || (st.frames.length > 0 && sep === "&"))
		return { ...verdict, kind: "multi" };
	st.capped = verdict;
	return null;
}

/**
 * @param {string} text
 * @param {number} depth
 * @param {string} file
 * @param {Scan} scan
 * @returns {Verdict | null}
 */
function scanSubject(text, depth, file, scan) {
	const { masked, spans } = parseCommand(text);
	/** @type {ScanState} */
	const st = {
		lines: splitLines(masked),
		spans,
		depth,
		suffix: file ? ` (in ${file})` : "",
		scan,
		caseDepth: 0,
		pattern: false,
		prev: "",
		capped: null,
		frames: [],
	};
	for (const [idx, line] of st.lines.entries()) {
		const verdict = scanLine(st, line, idx);
		if (verdict !== null) return verdict;
	}
	return st.capped;
}

const WHY = {
	generator: "is a CPU load generator with no CPU cap",
	multi:
		"is a capped CPU load generator beside another, or started in a loop — two caps add up to more than one",
};

/**
 * @param {string} command
 * @param {CpuLoadContext} ctx
 * @returns {import("./guard-entry.js").Decision}
 */
function decide(command, ctx) {
	const cores = ctx.coreCount();
	if (!/^[1-9][0-9]*$/.test(cores)) {
		ctx.log("the core count did not resolve — every command allowed unchecked");
		return null;
	}
	const half = BigInt.asIntN(64, BigInt(cores)) / TWO;
	const maxCpus = half || ONE;
	const maxQuota = BigInt.asIntN(64, maxCpus * HUNDRED);
	const base = ctx.cwd?.startsWith("/") ? ctx.cwd : ctx.fallbackCwd;
	const verdict = scanSubject(command, 0, "", {
		maxCpus,
		maxQuota,
		base,
		ctx,
	});
	if (verdict === null || verdict.kind === "capped") return null;
	const reason = `Refused: \`${verdict.where}\` ${WHY[verdict.kind]}. Every session shares this machine's ${cores} cores; on 23 Oct 2026 eight uncapped \`yes\` loops starved the kernel's RCU thread and WSL had to be restarted (#2710).

Synthetic load runs inside a cap of at most ${maxCpus} cores, the whole load under one cap:

  systemd-run --user --scope -p CPUQuota=${maxQuota}% -- bash -c '<the load>; wait'
  taskset -c 0-${BigInt.asIntN(64, maxCpus - ONE)} bash -c '<the load>; wait'

\`yes | <command>\`, feeding a command, passes.`;
	return { deny: reason };
}

module.exports = { field: "command", noun: "command", decide };
