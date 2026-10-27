import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { formatSkillsForPrompt, loadSkillsFromDir } from "@earendil-works/pi-coding-agent";
import { logger } from "../logger.js";

const WORKSPACE_AGENT_FILE = "agent.md";
const WORKSPACE_SKILLS_DIR = ".skills";

/** Build the same workspace prompt sections for legacy and durable sessions.
 * Private skills are prompt resources only; this does not install process-global
 * PI resources or make durable-only tools available to a skill. */
export function buildWorkspaceContextSections(workspaceDir: string): string[] {
	const sections: string[] = [];

	const agentFile = join(workspaceDir, WORKSPACE_AGENT_FILE);
	if (existsSync(agentFile)) {
		try {
			const content = readFileSync(agentFile, "utf-8").trim();
			if (content) {
				sections.push(`# 工作区上下文 (${WORKSPACE_AGENT_FILE})\n\n${content}`);
			}
		} catch (err) {
			logger.warn({ err }, "failed to read workspace agent.md");
			// Ignore unreadable agent.md
		}
	}

	const skillsDir = join(workspaceDir, WORKSPACE_SKILLS_DIR);
	if (existsSync(skillsDir)) {
		try {
			const { skills } = loadSkillsFromDir({ dir: skillsDir, source: "path" });
			if (skills.length > 0) {
				const block = formatSkillsForPrompt(skills);
				if (block.trim()) {
					sections.push(`# 本工作区私有技能\n${block}`);
				}
			}
		} catch (err) {
			logger.warn({ err }, "failed to discover workspace skills");
			// Ignore skill discovery failures
		}
	}

	return sections;
}
