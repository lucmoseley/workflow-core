/*
 * index.d.ts, the delivery mod's `$.state` contract. Held by the host, so a
 * fresh load of the module after a lost hooks worker reads it (#3251).
 */

declare module "claude-code" {
	interface PluginState {
		"wfc-delivery": {
			/** True from a main-loop `turn.start` until its `turn.complete`. */
			isTurnRunning: boolean;
		};
	}
}
