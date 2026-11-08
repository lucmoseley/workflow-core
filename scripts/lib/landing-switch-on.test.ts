// @vitest-environment node
/*
 * lib/landing-switch-on.js judges each reading (#4688). Loosened, a core
 * before v2.1.0 fails, or the cut-over mark is read on a landing-off repo.
 */
import { describe, expect, it } from "vitest";

const { judgeSwitchOn } = require("./landing-switch-on.js");

const HOW = { note: "N", cutoverCommand: "C", stepsCommand: "S" };
const judge = (
	version: string,
	landingOn: boolean,
	cutOver: () => boolean | null = () => {
		throw new Error("cut-over mark read");
	},
) => judgeSwitchOn({ version, landingOn, cutOver }, HOW);

describe("judgeSwitchOn (#4688)", () => {
	it("skips a core before v2.1.0, a pre-release of it included", () => {
		expect(judge("2.0.9", false).outcome).toBe("skip");
		expect(judge("1.9.0", false).outcome).toBe("skip");
	});

	it("fails landing off from v2.1.0 without reading the mark", () => {
		for (const v of ["2.1.0", "v2.1.0", "2.1.0-rc.1", "3.0.0"])
			expect(judge(v, false)).toMatchObject({
				outcome: "fail",
				tag: "LANDING-OFF",
			});
		expect(judge("2.1.0", false).line).toContain("`S`");
	});

	it("fails landing on but not cut over, naming the cutover command", () => {
		const j = judge("2.1.0", true, () => false);
		expect(j).toMatchObject({ outcome: "fail", tag: "NOT-CUT-OVER" });
		expect(j.line).toContain("`C`");
	});

	it("passes landing on and cut over", () => {
		expect(judge("2.1.0", true, () => true).outcome).toBe("ok");
	});

	it("is broken on an unread mark or a version that is no x.y.z", () => {
		expect(judge("2.1.0", true, () => null).outcome).toBe("broken");
		expect(judge("2.1", false).outcome).toBe("broken");
	});
});
