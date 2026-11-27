// #5804
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { runCommand } = require("./run-command.js");
const scan = require("./pfn-scan.js");

const PS = "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";
const DIAG = "/mnt/c/diag/5743";
const SYMBOLS = `${DIAG}/sym`;
const SYMBOL_SERVER = "https://msdl.microsoft.com/download/symbols";
// guess, #5804
const MAX_OUT = 64 * 1024 * 1024;

/** @param {string} p @returns {string} */
function toWin(p) {
	const r = runCommand("wslpath", ["-w", p]);
	if (r.error !== null) throw new Error(r.error);
	return r.out;
}

/**
 * @param {string} dump
 * @param {string} symbolDir
 * @param {string[]} commands
 * @param {string} work
 */
function runCdb(dump, symbolDir, commands, work) {
	const file = path.join(work, "commands.txt");
	fs.writeFileSync(file, `${commands.join("\r\n")}\r\n`);
	const cmd = `& cdbARM64.exe -z '${toWin(dump)}' -y '${toWin(symbolDir)}' -cf '${toWin(file)}'`;
	const r = spawnSync(PS, ["-NoProfile", "-Command", cmd], {
		encoding: "utf8",
		maxBuffer: MAX_OUT,
	});
	if (r.error) throw new Error(`cdb: ${r.error.message}`);
	return (r.stdout ?? "").replace(/\r/g, "");
}

/**
 * @param {{pdb: string, key: string}} id
 * @returns {string}
 */
function fetchSymbols({ pdb, key }) {
	const dir = path.join(SYMBOLS, pdb, key);
	const file = path.join(dir, pdb);
	if (fs.existsSync(file)) return dir;
	fs.mkdirSync(dir, { recursive: true });
	const r = runCommand("curl", [
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
	const work = path.join(DIAG, `scan-${process.pid}`);
	fs.mkdirSync(work, { recursive: true });
	try {
		fs.mkdirSync(SYMBOLS, { recursive: true });
		const id = scan.parseIdentity(
			runCdb(dump, SYMBOLS, scan.IDENTITY_COMMANDS, work),
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
			scan.addEntries(result, layout, p.first, fs.readFileSync(p.file));
		for (const p of read)
			scan.addRarePatterns(result, layout, p.first, fs.readFileSync(p.file));
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
		} catch {
			// #5804
		}
	}
	return seen;
}

module.exports = { DIAG, earlierFlagged, scanDump };
