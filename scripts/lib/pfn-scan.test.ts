// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
	chunks,
	emptyScan,
	flagRareInto,
	formatReport,
	parseIdentity,
	parseLayout,
	scanInto,
} from "./pfn-scan.js";

// #5735
const IDENTITY = `1: kd> .echo @@lmi
@@lmi
1: kd> !lmi nt
Debug Data Dirs: Type  Size     VA  Pointer
             CODEVIEW    25, 4ff7c,   4f77c RSDS - GUID: {C88DB430-8AC3-0EFB-3914-4EB14B6C6330}
               Age: 1, Pdb: ntkrnlmp.pdb
1: kd> .echo @@end
@@end
`;

const LAYOUT = `1: kd> .echo @@db
@@db
1: kd> ? poi(nt!MmPfnDatabase)
Evaluate expression: -24739011624960 = ffffe980\`00000000
1: kd> .echo @@size
@@size
1: kd> ?? sizeof(nt!_MMPFN)
unsigned int64 0x30
1: kd> .echo @@u4
@@u4
1: kd> dt nt!_MMPFN u4.
   +0x028 u4  :
      +0x000 PteFrame : Pos 0, 36 Bits
      +0x000 ResidentPage : Pos 36, 1 Bit
      +0x000 ResidentPageContainsBadPages : Pos 37, 1 Bit
      +0x000 Unused1 : Pos 38, 1 Bit
      +0x000 Partition : Pos 39, 10 Bits
      +0x000 FileOnly : Pos 49, 1 Bit
      +0x000 EntireField : Uint8B
1: kd> .echo @@nruns
@@nruns
1: kd> dd poi(nt!MmPhysicalMemoryBlock) L1
ffffc883\`1dab4600  00000002
1: kd> .echo @@runs
@@runs
1: kd> dq poi(nt!MmPhysicalMemoryBlock)+10 L80
ffffc883\`1dab4610  00000000\`00000100 00000000\`00000010
ffffc883\`1dab4620  00000000\`00880000 00000000\`00380000
ffffc883\`1dab4630  4e657071\`02120000 00000000\`9c7a3174
1: kd> .echo @@end
@@end
`;

const layoutOf = () => {
	const l = parseLayout(LAYOUT);
	if ("why" in l) throw new Error(l.why);
	return l;
};

const entries = (qwords: bigint[]) => {
	const b = Buffer.alloc(qwords.length * 0x30);
	qwords.forEach((q, i) => {
		b.writeBigUInt64LE(q, i * 0x30 + 0x28);
	});
	return b;
};

describe("parseIdentity", () => {
	it("reads the PDB name and its symbol-store key", () => {
		expect(parseIdentity(IDENTITY)).toEqual({
			pdb: "ntkrnlmp.pdb",
			key: `${"C88DB430-8AC3-0EFB-3914-4EB14B6C6330".replace(/-/g, "")}1`,
		});
	});

	it("says why where no GUID is printed", () => {
		expect(parseIdentity("@@lmi\nnothing\n@@end\n")).toHaveProperty("why");
	});
});

describe("parseLayout", () => {
	it("reads the database base, entry size, u4 fields and RAM runs", () => {
		const l = layoutOf();
		expect(l.database).toBe(BigInt("0xffffe98000000000"));
		expect(l.entrySize).toBe(0x30);
		expect(l.u4Offset).toBe(0x28);
		expect(l.fields.PteFrame).toEqual({ pos: 0, bits: 36 });
		expect(l.fields.Partition).toEqual({ pos: 39, bits: 10 });
		expect(l.runs).toEqual([
			{ base: BigInt(0x1_00), count: BigInt(0x10) },
			{ base: BigInt(0x88_00_00), count: BigInt(0x38_00_00) },
		]);
	});

	it("says why where the symbols gave no layout", () => {
		expect(parseLayout("@@db\nCouldn't resolve\n@@end\n")).toHaveProperty(
			"why",
		);
	});
});

describe("scanInto and flagRareInto", () => {
	const common = BigInt("0x0044000000000105");
	it("flags the 24 Nov damaged qword and nothing in a common pattern", () => {
		const l = layoutOf();
		const scan = emptyScan(l);
		const bytes = entries([
			...Array.from({ length: 8 }, () => common),
			...Array.from({ length: 8 }, () => BigInt("0x0004000ffffffffe")),
			BigInt("0x71b53de1c168c949"),
		]);
		scanInto(scan, l, BigInt(0x1_00), bytes);
		flagRareInto(scan, l, BigInt(0x1_00), bytes);
		expect(scan.read).toBe(BigInt(17));
		expect(scan.flagged).toHaveLength(1);
		expect(scan.flagged[0]?.pfn).toBe(BigInt(0x1_10));
		expect(scan.flagged[0]?.address).toBe(
			BigInt("0xffffe98000000000") + BigInt(0x1_10 * 0x30),
		);
		expect(scan.flagged[0]?.reasons).toEqual([
			"PteFrame 0x1c168c949 is not RAM",
			"Partition 0x27b",
			"Unused1 set",
			"rare high bits 0x71b53de",
		]);
	});
});

describe("chunks", () => {
	it("splits each run into reads of at most 0x10000 entries", () => {
		const c = chunks(layoutOf());
		expect(c[0]).toMatchObject({ first: BigInt(0x1_00), count: BigInt(0x10) });
		expect(c).toHaveLength(1 + 0x38);
		expect(c[1]?.address).toBe(
			BigInt("0xffffe98000000000") + BigInt(0x88_00_00) * BigInt(0x30),
		);
	});
});

describe("formatReport", () => {
	it("names the flagged entry and whether an earlier scan had it", () => {
		const l = layoutOf();
		const scan = emptyScan(l);
		scanInto(scan, l, BigInt(0x1_00), entries([BigInt("0x71b53de1c168c949")]));
		const text = formatReport(scan, {
			dump: "live-261128-0700.dmp",
			combining: "on",
			earlier: new Set(["0x100"]),
		});
		expect(text).toContain("Flagged +0x28 qwords: **1**");
		expect(text).toContain("`71b53de1'c168c949`");
		expect(text).toMatch(/\| 0x100 \|.*\| yes \|/);
	});
});
