import { AsyncLocalStorage } from "node:async_hooks";
import type { TenantContext, TenantStore } from "./store.js";

interface CurrentTenant {
	context: TenantContext;
	store: TenantStore;
}

const currentTenant = new AsyncLocalStorage<CurrentTenant>();

/** Bind verified tenant identity to the request's asynchronous execution chain. */
export function enterTenantContext(context: TenantContext, store: TenantStore): void {
	currentTenant.enterWith({ context, store });
}

export function getCurrentTenant(): TenantContext | null {
	return currentTenant.getStore()?.context ?? null;
}

export function getCurrentTenantStore(): TenantStore | null {
	return currentTenant.getStore()?.store ?? null;
}

/** Run work with an explicit verified tenant, without leaking it to siblings. */
export function runInTenantContext<T>(context: TenantContext, store: TenantStore, operation: () => T): T {
	return currentTenant.run({ context, store }, operation);
}

/** Singleton construction/background timers must not capture the bootstrap request's tenant. */
export function runWithoutTenantContext<T>(operation: () => T): T {
	return currentTenant.exit(operation);
}
