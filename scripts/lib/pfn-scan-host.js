// #5804
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { caught } = require("./caught.js");
const { curlBin } = require("./registry-call.js");
const { runCommand } = require("./run-command.js");
const scan = require("./pfn-scan.js");
const { writeFd } = require("./write-fd.js");
const { powershellBin, toWin } = require("./windows-host.js");

const diagDir = () => process.env.WFC_DIAG_DIR || "/mnt/c/diag/5743";
const SYMBOL_SERVER = "https://msdl.microsoft.com/download/symbols";
// guess, #5804
const MAX_OUT = 64 * 1024 * 1024;

/**
 * @param {string} dump
 * @param {string} symbolDir
 * @param {string[]} commands
 * @param {string} work
 */
function runCdb(dump, symbolDir, commands, work) {
	const file = path.join(work, "commands.txt");
	fs.writeFileSync(file, `${commands.join("\r\n")}\r\n`);
	const cdb = process.env.WFC_CDB || "cdbARM64.exe";
	const r = spawnSync(
		powershellBin(),
		[
			"-NoProfile",
			"-Command",
			`& '${cdb}' -z '${toWin(dump)}' -y '${toWin(symbolDir)}' -cf '${toWin(file)}'`,
		],
		{ encoding: "utf8", maxBuffer: MAX_OUT },
	);
	if (r.error) throw new Error(`cdb: ${r.error.message}`);
	if (r.status !== 0)
		throw new Error(`cdb exited ${r.status}: ${(r.stderr ?? "").trim()}`);
	return (r.stdout ?? "").replace(/\r/g, "");
}

/**
 * @param {{pdb: string, key: string}} id
 * @returns {string}
 */
function fetchSymbols({ pdb, key }) {
	const dir = path.join(diagDir(), "sym", pdb, key);
	const file = path.join(dir, pdb);
	if (fs.existsSync(file)) return dir;
	fs.mkdirSync(dir, { recursive: true });
	const r = runCommand(curlBin(), [
		"-fsSL",
		"-o",
		`${file}.part`,
		`${SYMBOL_SERVER}/${pdb}/${key}/${pdb}`,
	]);
	if (r.error !== null)
		throw new Error(`symbols for ${pdb} ${key}: ${r.error}`);
	fs.renameSync(`${file}.part`, file);
	return dir;
}

/**
 * @param {string} dump
 * @returns {import("./pfn-scan.js").Scan}
 */
function scanDump(dump) {
	const work = path.join(diagDir(), `scan-${process.pid}`);
	const symbols = path.join(diagDir(), "sym");
	fs.mkdirSync(work, { recursive: true });
	try {
		fs.mkdirSync(symbols, { recursive: true });
		const id = scan.parseIdentity(
			runCdb(dump, symbols, scan.IDENTITY_COMMANDS, work),
		);
		if ("why" in id) throw new Error(id.why);
		const symbolDir = fetchSymbols(id);
		const layout = scan.parseLayout(
			runCdb(dump, symbolDir, scan.LAYOUT_COMMANDS, work),
		);
		if ("why" in layout) throw new Error(layout.why);
		const parts = scan.chunks(layout).map((c, i) => ({
			...c,
			file: path.join(work, `c${i}.bin`),
			bytes: Number(c.count) * layout.entrySize,
		}));
		runCdb(
			dump,
			symbolDir,
			[
				...parts.map(
					(p) =>
						`.writemem ${toWin(p.file)} 0x${p.address.toString(16)} L?0x${p.bytes.toString(16)}`,
				),
				"q",
			],
			work,
		);
		const result = scan.emptyScan(layout);
		const read = parts.filter(
			(p) => fs.existsSync(p.file) && fs.statSync(p.file).size === p.bytes,
		);
		for (const p of read)
			scan.scanInto(result, layout, p.first, fs.readFileSync(p.file));
		for (const p of read)
			scan.flagRareInto(result, layout, p.first, fs.readFileSync(p.file));
		if (result.read === BigInt(0))
			throw new Error("no PFN entry could be read from the dump");
		return result;
	} finally {
		fs.rmSync(work, { recursive: true, force: true });
	}
}

/**
 * @param {string} dump
 * @returns {Set<string>}
 */
function earlierFlagged(dump) {
	const dir = path.dirname(dump);
	const own = `${path.basename(dump)}.pfnscan.json`;
	/** @type {Set<string>} */
	const seen = new Set();
	for (const name of fs.readdirSync(dir)) {
		if (!name.endsWith(".pfnscan.json") || name === own) continue;
		try {
			const j = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
			for (const f of j.flagged ?? []) seen.add(f.pfn);
		} catch (e) {
			writeFd(
				2,
				`pfn-scan: skipped ${name}, which did not parse: ${caught(e).message}\n`,
			);
		}
	}
	return seen;
}

module.exports = { diagDir, earlierFlagged, scanDump };
