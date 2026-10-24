// @vitest-environment node
/*
 * lib/status-marker.js's one parse of a message's status markers (#1550),
 * driven directly: the priced-options guard's own tests reach it only through
 * the hook process. Every status limb in that guard reads this parse, so a
 * wrong field here misfiles background jobs while each limb's own logic looks
 * sound.
 */

import { describe, expect, it } from "vitest";
import { governingMarker, parseStatus } from "./status-marker.js";

describe("parseStatus", () => {
	it("reads nothing from a message with no marker", () => {
		const status = parseStatus("Done, nothing more.");

		expect(status.governing).toBeNull();
		expect(status.last).toEqual({
			"needs input:": null,
			"result:": null,
			"waiting:": null,
		});
		expect(status.decorated).toBeNull();
		expect(status.hasLaterMarker("result:")).toBe(false);
		expect(governingMarker("Done, nothing more.")).toEqual({
			name: "",
			payload: "",
			at: -1,
		});
	});

	it.each(["needs input:", "result:", "waiting:"] as const)(
		"reads %s alone as governing and as its own last",
		(name) => {
			const message = `Report.\n\n${name} the payload`;
			const status = parseStatus(message);

			const expected = {
				name,
				payload: " the payload",
				at: "Report.\n\n".length,
				line: `${name} the payload`,
				below: "",
				fromEnd: message.length - "Report.\n\n".length,
			};
			expect(status.governing).toEqual(expected);
			expect(status.last[name]).toEqual(expected);
			expect(status.hasLaterMarker(name)).toBe(false);
		},
	);

	it("lets the later marker govern over a quoted one above it, keeping both by name", () => {
		const message =
			"The block said:\n\nresult: <what was delivered>\n\nneeds input: which parser ships";
		const status = parseStatus(message);

		expect(status.governing?.name).toBe("needs input:");
		expect(status.last["result:"]?.payload).toBe(" <what was delivered>");
		expect(status.hasLaterMarker("result:")).toBe(true);
		expect(status.hasLaterMarker("needs input:")).toBe(false);
		expect(governingMarker(message).name).toBe("needs input:");
	});

	it("reads the text below a marker's line and its distance from the end", () => {
		const message = "result: shipped\n\nMore report here.";
		const result = parseStatus(message).last["result:"];

		expect(result?.below).toBe("\nMore report here.");
		expect(result?.fromEnd).toBe(message.length);
	});

	it("keeps a marker's line whole past a lone carriage return its payload stops at", () => {
		const marker = parseStatus("needs input: pick A\rI will build it").last[
			"needs input:"
		];

		expect(marker?.payload).toBe(" pick A");
		expect(marker?.line).toBe("needs input: pick A\rI will build it");
	});

	it("reads a decorated-only marker as decorated, with no bare one", () => {
		const status = parseStatus("Done.\n\n**Needs Input:** which way");

		expect(status.governing).toBeNull();
		expect(status.decorated).toEqual({ name: "needs input:", lead: "**" });
	});

	it("strips the whitespace out of a decorated marker's lead", () => {
		expect(parseStatus("> `waiting:` the suite").decorated).toEqual({
			name: "waiting:",
			lead: ">`",
		});
	});
});
