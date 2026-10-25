import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { withTenantTransaction } from "./schema.js";

export type ResourceKind = "session" | "workspace" | "job" | "channel" | "memory" | "terminal" | "permission";

export interface TenantContext {
	tenantId: string;
	userId: string;
	role: "owner";
}

export interface LegacyResourceSet {
	sessions: string[];
	workspaces: string[];
}

export interface LegacyMigrationReport {
	dryRun: boolean;
	ownerUserId: string;
	tenantId: string | null;
	assigned: number;
	alreadyOwned: number;
	conflicts: Array<{ resourceType: ResourceKind; resourceId: string }>;
}

export class ResourceOwnershipError extends Error {
	readonly statusCode = 404;
	constructor(kind: ResourceKind, resourceId: string) {
		super(`${kind} not found: ${resourceId}`);
		this.name = "ResourceOwnershipError";
	}
}

export class TenantStore {
	constructor(private readonly pool: Pool) {}

	async ensurePersonalTenant(userId: string): Promise<TenantContext> {
		const client = await this.pool.connect();
		try {
			return await withTenantTransaction(client, async () => {
				const tenant = await client.query<{ id: string }>(
					`INSERT INTO tenants (id, owner_user_id)
					 VALUES ($1, $2)
					 ON CONFLICT (owner_user_id) DO UPDATE SET owner_user_id = EXCLUDED.owner_user_id
					 RETURNING id`,
					[randomUUID(), userId],
				);
				const tenantId = tenant.rows[0].id;
				await client.query(
					`INSERT INTO tenant_memberships (tenant_id, user_id, role)
					 VALUES ($1, $2, 'owner') ON CONFLICT (user_id) DO NOTHING`,
					[tenantId, userId],
				);
				return { tenantId, userId, role: "owner" as const };
			});
		} finally {
			client.release();
		}
	}

	async findPersonalTenant(userId: string): Promise<TenantContext | null> {
		const result = await this.pool.query<{ id: string }>(
			"SELECT id FROM tenants WHERE owner_user_id = $1",
			[userId],
		);
		const tenantId = result.rows[0]?.id;
		return tenantId ? { tenantId, userId, role: "owner" } : null;
	}

	async claimResource(context: TenantContext, kind: ResourceKind, resourceId: string): Promise<void> {
		const client = await this.pool.connect();
		try {
			await withTenantTransaction(client, async () => {
				// Membership is checked in the same transaction as the claim; callers
				// never supply a tenant id directly.
				const member = await client.query(
					"SELECT 1 FROM tenant_memberships WHERE tenant_id = $1 AND user_id = $2",
					[context.tenantId, context.userId],
				);
				if (member.rowCount !== 1) throw new ResourceOwnershipError(kind, resourceId);
				const inserted = await client.query(
					`INSERT INTO resource_ownership (tenant_id, resource_type, resource_id)
					 VALUES ($1, $2, $3) ON CONFLICT (resource_type, resource_id) DO NOTHING RETURNING tenant_id`,
					[context.tenantId, kind, resourceId],
				);
				if (inserted.rowCount === 1) return;
				const existing = await client.query<{ tenant_id: string }>(
					"SELECT tenant_id FROM resource_ownership WHERE resource_type = $1 AND resource_id = $2",
					[kind, resourceId],
				);
				if (existing.rows[0]?.tenant_id !== context.tenantId) {
					throw new ResourceOwnershipError(kind, resourceId);
				}
			});
		} finally {
			client.release();
		}
	}

	async ownsResource(context: TenantContext, kind: ResourceKind, resourceId: string): Promise<boolean> {
		const result = await this.pool.query(
			`SELECT 1 FROM resource_ownership
			 WHERE tenant_id = $1 AND resource_type = $2 AND resource_id = $3`,
			[context.tenantId, kind, resourceId],
		);
		return result.rowCount === 1;
	}

	async listResourceIds(context: TenantContext, kind: ResourceKind): Promise<Set<string>> {
		const result = await this.pool.query<{ resource_id: string }>(
			"SELECT resource_id FROM resource_ownership WHERE tenant_id = $1 AND resource_type = $2",
			[context.tenantId, kind],
		);
		return new Set(result.rows.map((row) => row.resource_id));
	}

	async releaseResource(context: TenantContext, kind: ResourceKind, resourceId: string): Promise<void> {
		await this.pool.query(
			"DELETE FROM resource_ownership WHERE tenant_id = $1 AND resource_type = $2 AND resource_id = $3",
			[context.tenantId, kind, resourceId],
		);
	}

	async migrateLegacyResources(
		ownerUserId: string,
		resources: LegacyResourceSet,
		dryRun: boolean,
	): Promise<LegacyMigrationReport> {
		const context = dryRun
			? await this.findPersonalTenant(ownerUserId)
			: await this.ensurePersonalTenant(ownerUserId);
		const report: LegacyMigrationReport = {
			dryRun,
			ownerUserId,
			tenantId: context?.tenantId ?? null,
			assigned: 0,
			alreadyOwned: 0,
			conflicts: [],
		};
		for (const [kind, ids] of [["session", resources.sessions], ["workspace", resources.workspaces]] as const) {
			for (const resourceId of new Set(ids)) {
				const existing = await this.pool.query<{ tenant_id: string }>(
					"SELECT tenant_id FROM resource_ownership WHERE resource_type = $1 AND resource_id = $2",
					[kind, resourceId],
				);
				const owner = existing.rows[0]?.tenant_id;
				if (owner && owner !== context?.tenantId) {
					report.conflicts.push({ resourceType: kind, resourceId });
					continue;
				}
				if (owner) {
					report.alreadyOwned += 1;
					continue;
				}
				report.assigned += 1;
				if (!dryRun) await this.claimResource(context!, kind, resourceId);
			}
		}
		return report;
	}
}
