// @vitest-environment node

import { describe, expect, it } from "vitest";
import { registeredTimeoutsMs } from "./hook-timeouts";
import { RUN_TIMEOUT_MS } from "./rendered-injection.js";

describe("RUN_TIMEOUT_MS", () => {
	it("is the injector's hook timeout at every registration", () => {
		const timeouts = registeredTimeoutsMs("inject-tracker-docs.js");
		expect(timeouts.length).toBeGreaterThan(0);
		expect(new Set(timeouts)).toEqual(new Set([RUN_TIMEOUT_MS]));
	});
});
