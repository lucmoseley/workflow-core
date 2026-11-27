/* #5805 */
import { writeFakeBin } from "./fake-bin";
import { shellQuote } from "./sh-quote.js";

const GUID = "C88DB430-8AC3-0EFB-3914-4EB14B6C6330";
const IDENTITY = `1: kd> !lmi nt
@@lmi
             CODEVIEW    25, 4ff7c,   4f77c RSDS - GUID: {${GUID}}
               Age: 1, Pdb: ntkrnlmp.pdb
@@end
`;
export const PDB = "ntkrnlmp.pdb";
export const UNOPENED = "The system cannot find the file specified.";
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

const READ = `head -c $((16#\${len#L?0x})) /dev/zero >"$file"`;
const UNREAD = `: >"$file"`;

export function writeCdb(
	dir: string,
	{ exit = 0, reads = true }: { exit?: number; reads?: boolean } = {},
): string {
	return writeFakeBin(
		dir,
		"cdb",
		`cf="" z=""
while [ $# -gt 0 ]; do case "$1" in -cf) cf="$2";; -z) z="$2";; esac; shift; done
[ ${exit} = 0 ] || { printf 'Could not open dump file [%s], Win32 error 0n2\\n%s\\n' "$z" ${shellQuote(UNOPENED)}; exit ${exit}; }
if grep -q '!lmi' "$cf"; then printf '%s' ${shellQuote(IDENTITY)}
elif grep -q '@@db' "$cf"; then printf '%s' ${shellQuote(LAYOUT)}
else
  while read -r cmd file _ len; do
    if [ "$cmd" = .writemem ]; then ${reads ? READ : UNREAD}; fi
  done < <(tr -d '\\r' <"$cf")
fi`,
	);
}
