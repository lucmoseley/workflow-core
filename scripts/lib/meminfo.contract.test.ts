// @vitest-environment node
/*
 * Holds lib/meminfo-fake.ts, which refill-loop-run.test.ts points
 * `WFC_MEMINFO` at, to the real `/proc/meminfo` and to the parser the refill
 * loop reads the swap hold through (lib/admission.js's readSwapHold, over
 * lib/meminfo.js, #3093).
 * The live case reads the real file, a free call. Breaking it costs the
 * loop's swap hold: a fake the parser reads otherwise than the real file
 * passes a refill-loop-run test the loop fails.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readSwapHold } from "./admission.js";
import { buildMeminfo, MEMINFO_KEYS } from "./meminfo-fake";

const REAL = "/proc/meminfo";
const was = process.env.WFC_MEMINFO;
afterEach(() => {
	if (was === undefined) delete process.env.WFC_MEMINFO;
	else process.env.WFC_MEMINFO = was;
});

function readFake(text: string) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "meminfo-contract-"));
	try {
		fs.writeFileSync(path.join(dir, "meminfo"), text);
		process.env.WFC_MEMINFO = path.join(dir, "meminfo");
		return readSwapHold();
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

describe("the meminfo fake against the real file (#3093)", () => {
	it.skipIf(!fs.existsSync(REAL))(
		"writes each of its lines in the real file's shape",
		() => {
			const real = fs.readFileSync(REAL, "utf8");
			const fake = buildMeminfo({
				availableMb: 1,
				swapTotalMb: 1,
				swapFreeMb: 1,
			});
			for (const key of MEMINFO_KEYS) {
				const shape = new RegExp(`^${key}:\\s+\\d+ kB$`, "m");
				expect(real).toMatch(shape);
				expect(fake).toMatch(shape);
			}
			delete process.env.WFC_MEMINFO;
			expect(typeof readSwapHold().held).toBe("boolean");
		},
	);

	it("reads back the readings it was built with", () => {
		expect(
			readFake(
				buildMeminfo({ availableMb: 1024, swapTotalMb: 2048, swapFreeMb: 256 }),
			),
		).toEqual({
			held: true,
			swapFreeMb: 256,
			swapTotalMb: 2048,
			availableMb: 1024,
		});
		expect(
			readFake(
				buildMeminfo({
					availableMb: 8192,
					swapTotalMb: 2048,
					swapFreeMb: 2048,
				}),
			),
		).toEqual({ held: false });
	});
});
