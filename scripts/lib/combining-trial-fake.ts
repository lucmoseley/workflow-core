/* #5805 */
import fs from "node:fs";
import path from "node:path";
import { shellQuote } from "./sh-quote.js";

const GUID = "C88DB430-8AC3-0EFB-3914-4EB14B6C6330";
const IDENTITY = `1: kd> !lmi nt
@@lmi
             CODEVIEW    25, 4ff7c,   4f77c RSDS - GUID: {${GUID}}
               Age: 1, Pdb: ntkrnlmp.pdb
@@end
`;
export const PDB = "ntkrnlmp.pdb";
export const PDB_KEY = `${GUID.replace(/-/g, "")}1`;

const LAYOUT = `@@db
Evaluate expression: -24739011624960 = ffffe980\`00000000
@@size
unsigned int64 0x30
@@u4
   +0x028 u4  :
      +0x000 PteFrame : Pos 0, 36 Bits
      +0x000 ResidentPage : Pos 36, 1 Bit
      +0x000 ResidentPageContainsBadPages : Pos 37, 1 Bit
      +0x000 Unused1 : Pos 38, 1 Bit
      +0x000 Partition : Pos 39, 10 Bits
      +0x000 FileOnly : Pos 49, 1 Bit
      +0x000 EntireField : Uint8B
@@nruns
ffffc883\`1dab4600  00000001
@@runs
ffffc883\`1dab4610  00000000\`00000100 00000000\`00000010
@@end
`;

const write = (dir: string, name: string, body: string) => {
	fs.mkdirSync(dir, { recursive: true });
	const bin = path.join(dir, name);
	fs.writeFileSync(bin, `#!/bin/bash\n${body}\n`, { mode: 0o755 });
	return bin;
};

export function writeCdb(
	dir: string,
	{ exit = 0, reads = true }: { exit?: number; reads?: boolean } = {},
): string {
	return write(
		dir,
		"cdb",
		`cf=""
while [ $# -gt 0 ]; do [ "$1" = -cf ] && cf="$2"; shift; done
[ ${exit} = 0 ] || { echo 'cannot open the dump' >&2; exit ${exit}; }
if grep -q '!lmi' "$cf"; then printf '%s' ${shellQuote(IDENTITY)}
elif grep -q '@@db' "$cf"; then printf '%s' ${shellQuote(LAYOUT)}
else
  ${reads ? "" : "exit 0"}
  while read -r cmd file _ len; do
    if [ "$cmd" = .writemem ]; then head -c $((16#\${len#L?0x})) /dev/zero >"$file"; fi
  done < <(tr -d '\\r' <"$cf")
fi`,
	);
}

export const writeWslpath = (dir: string) =>
	write(dir, "wslpath", `printf '%s' "$2"`);

export function writeSchtasks(
	dir: string,
	diag: string,
	tasks: Record<string, { log: string; line: string }>,
): string {
	const arms = Object.entries(tasks)
		.map(
			([task, { log, line }]) =>
				`  ${shellQuote(task)}) printf '%s\\r\\n' ${shellQuote(`2026-11-28T07:00:00 ${line}`)} >>${shellQuote(path.join(diag, log))};;`,
		)
		.join("\n");
	return write(
		dir,
		"schtasks.exe",
		`case "$3" in
${arms}
  *) echo "ERROR: The system cannot find the file specified." >&2; exit 1;;
esac
echo 'SUCCESS: Attempted to run the scheduled task.'`,
	);
}
