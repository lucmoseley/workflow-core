const CORE_FAULT_TEXT = "could not judge this call";

const SHIM_FAULT_TEXTS = /** @type {const} */ ([
	"Guard code missing",
	"Guard code failed in ",
]);

const LOCKOUT_TEXTS = [CORE_FAULT_TEXT, ...SHIM_FAULT_TEXTS];

/** @param {string} text */
const isLockoutText = (text) => LOCKOUT_TEXTS.some((t) => text.includes(t));

module.exports = { CORE_FAULT_TEXT, isLockoutText };
