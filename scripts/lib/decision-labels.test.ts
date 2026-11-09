// @vitest-environment node
/*
 * Pins the decision-ticket predicate (#4740). Loosen it and a build ticket
 * is refused a reply-only Practice skip; tighten it and a decision ticket
 * closes on one, or drops off /wayfinder's frontier. Pure functions of a
 * label list, so plain in-process calls with no fixture.
 */
import { describe, expect, it } from "vitest";

const {
	decisionMarks,
	isDecisionTicket,
	isRouteStep,
} = require("./decision-labels.js");

describe("isDecisionTicket", () => {
	it("names takes:wayfinder alone a decision ticket", () => {
		expect(isDecisionTicket(["takes:wayfinder", "kind:ticket"])).toBe(true);
	});

	it("names any wayfinder: label a decision ticket", () => {
		expect(isDecisionTicket(["takes:implement", "wayfinder:task"])).toBe(true);
		expect(isDecisionTicket(["wayfinder:map"])).toBe(true);
	});

	it("names no other label a decision ticket", () => {
		expect(isDecisionTicket(["takes:implement", "kind:ticket"])).toBe(false);
		expect(isDecisionTicket(["takes:to-spec", "wayfinder"])).toBe(false);
		expect(isDecisionTicket([])).toBe(false);
	});
});

describe("isRouteStep", () => {
	it("reads a wayfinder: label and not takes:wayfinder", () => {
		expect(isRouteStep(["wayfinder:research"])).toBe(true);
		expect(isRouteStep(["takes:wayfinder"])).toBe(false);
	});
});

describe("decisionMarks", () => {
	it("returns the marking labels in order", () => {
		expect(
			decisionMarks(["wayfinder:grilling", "urgent", "takes:wayfinder"]),
		).toEqual(["wayfinder:grilling", "takes:wayfinder"]);
	});
});
