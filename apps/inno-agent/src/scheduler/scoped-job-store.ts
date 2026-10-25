import { join } from "node:path";
import { getCurrentTenant } from "../tenants/current.js";
import { JobStore, type ScheduledJobCreateInput } from "./job-store.js";
import type { JobRunRecord, ScheduledJob } from "./types.js";

/**
 * Resolve job storage at execution time. Authenticated tenants never share the
 * legacy global jobs.json/runs.jsonl; local mode keeps its original JobStore.
 */
export class ScopedJobStore extends JobStore {
	private readonly tenantStores = new Map<string, JobStore>();
	private readonly localStore: JobStore;

	constructor(
		private readonly dataDir: string,
		localJobsDir: string,
		defaultTimezone?: string,
	) {
		super(localJobsDir, defaultTimezone);
		this.localStore = new JobStore(localJobsDir, this.defaultTimezone);
	}

	private current(): JobStore {
		const tenant = getCurrentTenant();
		if (!tenant) return this.localStore;
		let store = this.tenantStores.get(tenant.tenantId);
		if (!store) {
			store = new JobStore(join(this.dataDir, "tenants", tenant.tenantId, "jobs"), this.defaultTimezone);
			this.tenantStores.set(tenant.tenantId, store);
		}
		return store;
	}

	override list(): ScheduledJob[] { return this.current().list(); }
	override normalizePersistedJobs(): ScheduledJob[] { return this.current().normalizePersistedJobs(); }
	override get(id: string): ScheduledJob | undefined { return this.current().get(id); }
	override create(input: ScheduledJobCreateInput): ScheduledJob { return this.current().create(input); }
	override update(id: string, patch: Partial<ScheduledJob>): ScheduledJob | undefined {
		return this.current().update(id, patch);
	}
	override mutate(id: string, mutator: (current: ScheduledJob) => Partial<ScheduledJob>): Promise<ScheduledJob | undefined> {
		return this.current().mutate(id, mutator);
	}
	override delete(id: string): boolean { return this.current().delete(id); }
	override appendRun(record: JobRunRecord): void { this.current().appendRun(record); }
	override listRuns(jobId?: string, limit = 50): JobRunRecord[] { return this.current().listRuns(jobId, limit); }
	override getStatus(): ReturnType<JobStore["getStatus"]> { return this.current().getStatus(); }
}
