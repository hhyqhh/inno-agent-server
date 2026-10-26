const HOST_EXECUTION_TOOLS = new Set(["bash", "read", "write", "edit", "grep", "find", "ls"]);

export const HOST_TERMINAL_DISABLED_ERROR = "Host terminal execution is disabled in authenticated mode";

/** PI's built-in host tools are not confined by workspace ownership. */
export function isHostExecutionTool(toolName: string): boolean {
	return HOST_EXECUTION_TOOLS.has(toolName);
}

/** Keep local/CLI/Desktop tool activation unchanged; authenticated turns fail closed. */
export function filterActiveToolsForMode(toolNames: string[], authenticated: boolean): string[] {
	return authenticated ? toolNames.filter((name) => !isHostExecutionTool(name)) : toolNames;
}
