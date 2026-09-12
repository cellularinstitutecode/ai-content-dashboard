// web/lib/planner-constants.ts
// The numbers that decide how the planner behaves.
//
// They lived as private consts in lib/autopilot.ts, which is a server-only
// module: nothing that needs to EXPLAIN the planner could read them. So the
// explanation was going to be prose typed from memory, and prose typed from
// memory drifts — somebody tunes the anti-repeat window and the assistant
// carries on telling people it is thirty days for the rest of the deployment.
//
// One definition, imported by the engine and interpolated into the playbook, so
// the explanation cannot be wrong about the engine it is explaining.
//
// No imports: the test runner strips types and runs this file directly.

/** Attempts a single planned run gets before it is marked failed. */
export const MAX_ATTEMPTS = 2;

/** A draft scoring below this is rewritten once (up to strategy.max_regens). */
export const SCORE_THRESHOLD = 70;

/** How far back the angle picker looks to avoid covering the same ground twice. */
export const ANTI_REPEAT_DAYS = 30;

/** How many days ahead each tick materialises slots for. */
export const HORIZON_DAYS = 10;
