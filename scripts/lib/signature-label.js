/*
 * signature-label.js — the label on a ticket that owes a line in the fault
 * signature log on main (workflow-core#4861). Its own module so the adopter label plan
 * reads the name without loading lib/fault-signature.js's transcript readers.
 */

const SIGNATURE_LABEL = "fault-signature";

module.exports = { SIGNATURE_LABEL };
