import { join } from "node:path";
import { readJson, writeJson, appendJsonl, readJsonl, readJsonlTail } from "../../storage/file-store.js";
import { type LearnerProfile, type LearningEvent, createDefaultProfile } from "./types.js";
import { applyLearningEventToProfile } from "./auto-profile.js";

const PROFILE_FILE = "profile.json";
const EVENTS_FILE = "events.jsonl";

/** events.jsonl is rolled to a timestamped archive once it exceeds this size. */
const EVENTS_MAX_BYTES = 10 * 1024 * 1024;

/**
 * Tail window for `loadRecentEvents`. Events are small JSON records, so this
 * holds far more than the handful a context pack needs — while never
 * re-reading the whole (up to EVENTS_MAX_BYTES) log.
 */
const EVENTS_TAIL_BYTES = 256 * 1024;

/**
 * Load the learner profile. Returns a default empty profile if not found.
 */
export function loadProfile(dataDir: string): LearnerProfile {
	return readJson<LearnerProfile>(join(dataDir, PROFILE_FILE), createDefaultProfile());
}

/**
 * Save the learner profile (increments version, updates timestamp).
 */
export function saveProfile(dataDir: string, profile: LearnerProfile): void {
	profile.version += 1;
	profile.updated_at = new Date().toISOString();
	writeJson(join(dataDir, PROFILE_FILE), profile);
}

/**
 * Record a learning event by appending to events.jsonl. The log is rotated at
 * EVENTS_MAX_BYTES; `loadEvents` (and therefore `rebuildProfileFromEvents`)
 * only replays the current segment — older segments stay on disk as archives.
 */
export function recordEvent(dataDir: string, event: LearningEvent): boolean {
	if (event.dedupe_key) {
		const existing = readJsonl<LearningEvent>(join(dataDir, EVENTS_FILE));
		if (existing.some((item) => item.dedupe_key === event.dedupe_key)) return false;
	}
	appendJsonl(join(dataDir, EVENTS_FILE), event, { maxBytes: EVENTS_MAX_BYTES });
	return true;
}

/**
 * Record a learning event and immediately fold deterministic signals into the
 * learner profile. This makes L1 useful even when the model only remembers to
 * record an event and skips a separate profile update call.
 */
export function recordEventAndUpdateProfile(dataDir: string, event: LearningEvent): LearnerProfile {
	const recorded = recordEvent(dataDir, event);
	const profile = loadProfile(dataDir);
	if (!recorded) return profile;
	if (applyLearningEventToProfile(profile, event)) {
		saveProfile(dataDir, profile);
	}
	return profile;
}

export interface IdempotentLearningEventResult<T> {
	profile: LearnerProfile;
	event: LearningEvent;
	value?: T;
	duplicate: boolean;
}

/** Apply a durable event and every derived profile mutation exactly once per
 * operation ID. The event is appended first; the applied marker and all profile
 * changes are then persisted together. A retry after either write resumes
 * without duplicating the event or folding its signals into the profile twice. */
export function recordEventAndApplyProfileOnce<T>(
	dataDir: string,
	event: LearningEvent,
	apply: (profile: LearnerProfile, persistedEvent: LearningEvent) => T,
): IdempotentLearningEventResult<T> {
	const operationId = event.dedupe_key?.trim();
	if (!operationId) throw new Error("An idempotent learning event requires a dedupe_key");
	const existing = loadEvents(dataDir).find((item) => item.dedupe_key === operationId);
	const persistedEvent = existing ?? event;
	const current = loadProfile(dataDir);
	if (current.applied_operation_ids?.includes(operationId)) {
		return { profile: current, event: persistedEvent, duplicate: true };
	}
	if (!existing) recordEvent(dataDir, event);
	const profile = loadProfile(dataDir);
	const value = apply(profile, persistedEvent);
	profile.applied_operation_ids = [...(profile.applied_operation_ids ?? []), operationId];
	saveProfile(dataDir, profile);
	return { profile, event: persistedEvent, value, duplicate: false };
}

export interface IdempotentProfileResult {
	profile: LearnerProfile;
	duplicate: boolean;
}

/** Apply a direct profile mutation and its replay marker in one atomic profile
 * write. This is required for append/delta operations replayed by pi-durable. */
export function applyProfileOperationOnce(
	dataDir: string,
	operationId: string,
	apply: (profile: LearnerProfile) => void,
): IdempotentProfileResult {
	const id = operationId.trim();
	if (!id) throw new Error("An idempotent profile mutation requires an operation ID");
	const profile = loadProfile(dataDir);
	if (profile.applied_operation_ids?.includes(id)) return { profile, duplicate: true };
	apply(profile);
	profile.applied_operation_ids = [...(profile.applied_operation_ids ?? []), id];
	saveProfile(dataDir, profile);
	return { profile, duplicate: false };
}

/**
 * Check whether the learner profile is effectively empty (new user).
 * Returns true when no goals, knowledge states, summary, or preferences
 * have been recorded — indicating a first-time user who needs onboarding.
 */
export function isProfileEmpty(profile: LearnerProfile): boolean {
	return profile.goals.length === 0
		&& profile.knowledge_states.length === 0
		&& profile.profile_summary === ""
		&& profile.preferences.explanation_style.length === 0
		&& profile.preferences.practice_style.length === 0;
}

/**
 * Load all recorded learning events. Full replay — used by
 * `rebuildProfileFromEvents`. Per-turn callers should use `loadRecentEvents`.
 */
export function loadEvents(dataDir: string): LearningEvent[] {
	return readJsonl<LearningEvent>(join(dataDir, EVENTS_FILE));
}

/**
 * Load only the most recent learning events, read from the tail of
 * events.jsonl. The per-turn context pack needs just the last few events, so
 * it must not re-read and re-parse the whole (rotated, up to EVENTS_MAX_BYTES)
 * log on every turn.
 */
export function loadRecentEvents(dataDir: string, count: number, tailBytes: number = EVENTS_TAIL_BYTES): LearningEvent[] {
	return readJsonlTail<LearningEvent>(join(dataDir, EVENTS_FILE), tailBytes).slice(-count);
}
