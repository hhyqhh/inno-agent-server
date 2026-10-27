import type { IncomingMessage } from "node:http";
import type { ResourceKind, TenantContext, TenantStore } from "./store.js";
import { enterTenantContext } from "./current.js";

const requestTenants = new WeakMap<IncomingMessage, TenantContext>();

/** Tenant identity is populated only from the verified server-side session. */
export function setRequestTenant(req: IncomingMessage, context: TenantContext, store: TenantStore): void {
	requestTenants.set(req, context);
	enterTenantContext(context, store);
}

export function getRequestTenant(req: IncomingMessage): TenantContext | null {
	return requestTenants.get(req) ?? null;
}

/** Internal request-shaped scope for background services that already restore
 * verified tenant ALS. No socket or client-supplied identity is involved. */
export function createBackgroundRequest(context?: TenantContext, store?: TenantStore): IncomingMessage {
	const req = {} as IncomingMessage;
	if (context) {
		if (!store) throw new Error("A tenant store is required for a background tenant scope");
		setRequestTenant(req, context, store);
	}
	return req;
}

export async function ownsRequestResource(
	req: IncomingMessage,
	store: TenantStore | null | undefined,
	kind: ResourceKind,
	resourceId: string,
): Promise<boolean> {
	const tenant = getRequestTenant(req);
	if (!tenant) return true;
	if (!store) throw new Error("Tenant store is required for an authenticated request");
	return store.ownsResource(tenant, kind, resourceId);
}

export async function claimRequestResource(
	req: IncomingMessage,
	store: TenantStore | null | undefined,
	kind: ResourceKind,
	resourceId: string,
): Promise<void> {
	const tenant = getRequestTenant(req);
	if (!tenant) return;
	if (!store) throw new Error("Tenant store is required for an authenticated request");
	await store.claimResource(tenant, kind, resourceId);
}

export async function releaseRequestResource(
	req: IncomingMessage,
	store: TenantStore | null | undefined,
	kind: ResourceKind,
	resourceId: string,
): Promise<void> {
	const tenant = getRequestTenant(req);
	if (!tenant) return;
	if (!store) throw new Error("Tenant store is required for an authenticated request");
	await store.releaseResource(tenant, kind, resourceId);
}
