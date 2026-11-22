// @vitest-environment node
import { expect, it } from "vitest";

it("fails only under the verdict probe", () => {
	expect(process.env.WFC_VERDICT_PROBE ?? "").toBe("");
});
