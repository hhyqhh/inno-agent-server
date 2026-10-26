import type { CheckInStore } from "../checkins/check-in-store.js";
import { getCurrentTenant, getCurrentTenantStore } from "../tenants/current.js";
import type { JobRunClaim } from "../tenants/store.js";
import type { ScheduledJob } from "./types.js";

/** Claim a tenant occurrence through PostgreSQL, never through client identity. */
export async function claimTenantJobRun(
	job: ScheduledJob,
	occurrenceId: string,
	scheduledAt: string,
): Promise<JobRunClaim | null> {
	const tenant = getCurrentTenant();
	const store = getCurrentTenantStore();
	if (!tenant || !store) throw new Error("Tenant job execution requires a verified tenant context");
	return store.claimJobRun(tenant, job.id, occurrenceId, scheduledAt);
}

/** Manual check-in execution keeps the legacy in-memory claim in local mode. */
export async function claimOccurrenceForExecution(
	checkInStore: CheckInStore,
	job: ScheduledJob,
	occurrenceId: string,
	scheduledAt: string,
): Promise<JobRunClaim | null> {
	if (getCurrentTenant()) return claimTenantJobRun(job, occurrenceId, scheduledAt);
	if (!checkInStore.claimOccurrence(occurrenceId)) return null;
	return {
		occurrenceId,
		release: async () => { checkInStore.releaseOccurrenceClaim(occurrenceId); },
	};
}
