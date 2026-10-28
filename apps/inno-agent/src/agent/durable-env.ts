import type { Context } from "@earendil-works/chord/context";
import {
	ExecutionError,
	FileError,
	type BinaryReader,
	type DirReader,
	type ExecutionEnv,
	type FileInfo,
	type FileWatcher,
	type Result,
	type ShellExecOptions,
	type ShellExecResult,
	type TextLineReader,
	type WatchChange,
	type WatchTarget,
} from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { canonicalContainmentRoot, resolveContainedPath } from "../utils/path-safety.js";

/**
 * Host environment for workspace-contained durable file tools. Read, write and
 * exact-edit operations stay inside the workspace; shell and all other
 * mutations fail closed even if a future registry accidentally adds a tool
 * that was not intended for this runtime.
 */
export class WorkspaceFileEnv extends NodeExecutionEnv implements ExecutionEnv {
	private readonly canonicalWorkspaceRoot: string;

	constructor(private readonly workspaceRoot: string) {
		super({ cwd: workspaceRoot });
		this.canonicalWorkspaceRoot = canonicalContainmentRoot(workspaceRoot);
	}

	private contained(path: string): string | FileError {
		// SDK mutation queuing canonicalizes paths before joining them again. On
		// macOS (/var → /private/var) that canonical absolute path no longer has
		// the lexical workspace prefix, so check against both views of the root.
		return resolveContainedPath(this.workspaceRoot, path)
			?? resolveContainedPath(this.canonicalWorkspaceRoot, path)
			?? new FileError("permission_denied", "Path escapes the durable session workspace", path);
	}

	private deny<T>(path: string): Result<T, FileError> {
		return { ok: false, error: new FileError("permission_denied", "Operation is disabled in the durable workspace file environment", path) };
	}

	override async absolutePath(path: string, context: Context): Promise<Result<string, FileError>> {
		const resolved = await super.absolutePath(path, context);
		if (!resolved.ok) return resolved;
		const contained = this.contained(resolved.value);
		return contained instanceof FileError ? { ok: false, error: contained } : { ok: true, value: contained };
	}

	override async joinPath(parts: string[], context: Context): Promise<Result<string, FileError>> {
		const joined = await super.joinPath(parts, context);
		if (!joined.ok) return joined;
		const contained = this.contained(joined.value);
		return contained instanceof FileError ? { ok: false, error: contained } : { ok: true, value: contained };
	}

	override async readTextFile(path: string, context: Context): Promise<Result<string, FileError>> {
		const contained = this.contained(path);
		return contained instanceof FileError ? { ok: false, error: contained } : super.readTextFile(contained, context);
	}

	override async openTextLineReader(path: string, context: Context): Promise<Result<TextLineReader, FileError>> {
		const contained = this.contained(path);
		return contained instanceof FileError ? { ok: false, error: contained } : super.openTextLineReader(contained, context);
	}

	override async readTextLines(path: string, options: { maxLines?: number } | undefined, context: Context): Promise<Result<string[], FileError>> {
		const contained = this.contained(path);
		return contained instanceof FileError ? { ok: false, error: contained } : super.readTextLines(contained, options, context);
	}

	override async readBinaryFile(path: string, context: Context): Promise<Result<Uint8Array, FileError>> {
		const contained = this.contained(path);
		return contained instanceof FileError ? { ok: false, error: contained } : super.readBinaryFile(contained, context);
	}

	override async openBinaryReader(path: string, options: { noFollow?: boolean } | undefined, context: Context): Promise<Result<BinaryReader, FileError>> {
		const contained = this.contained(path);
		return contained instanceof FileError ? { ok: false, error: contained } : super.openBinaryReader(contained, options, context);
	}

	override async fileInfo(path: string, context: Context): Promise<Result<FileInfo, FileError>> {
		const contained = this.contained(path);
		return contained instanceof FileError ? { ok: false, error: contained } : super.fileInfo(contained, context);
	}

	override async listDir(path: string, context: Context): Promise<Result<FileInfo[], FileError>> {
		const contained = this.contained(path);
		return contained instanceof FileError ? { ok: false, error: contained } : super.listDir(contained, context);
	}

	override async openDirReader(path: string, context: Context): Promise<Result<DirReader, FileError>> {
		const contained = this.contained(path);
		return contained instanceof FileError ? { ok: false, error: contained } : super.openDirReader(contained, context);
	}

	override async canonicalPath(path: string, context: Context): Promise<Result<string, FileError>> {
		const contained = this.contained(path);
		return contained instanceof FileError ? { ok: false, error: contained } : super.canonicalPath(contained, context);
	}

	override async exists(path: string, context: Context): Promise<Result<boolean, FileError>> {
		const contained = this.contained(path);
		return contained instanceof FileError ? { ok: false, error: contained } : super.exists(contained, context);
	}

	override watch(_targets: readonly WatchTarget[], _onChange: (change: WatchChange) => void, _context: Context): Promise<Result<FileWatcher, FileError>> {
		return Promise.resolve(this.deny("watch"));
	}

	override async writeFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
		const contained = this.contained(path);
		return contained instanceof FileError ? { ok: false, error: contained } : super.writeFile(contained, content, context);
	}

	override appendFile(path: string, _content: string | Uint8Array, _context: Context): Promise<Result<void, FileError>> {
		return Promise.resolve(this.deny(path));
	}

	override truncateFile(path: string, _size: number, _context: Context): Promise<Result<void, FileError>> {
		return Promise.resolve(this.deny(path));
	}

	override flushFile(path: string, _context: Context): Promise<Result<void, FileError>> {
		return Promise.resolve(this.deny(path));
	}

	override renameFile(sourcePath: string, _destinationPath: string, _context: Context): Promise<Result<void, FileError>> {
		return Promise.resolve(this.deny(sourcePath));
	}

	override createDir(path: string, _options: { recursive?: boolean } | undefined, _context: Context): Promise<Result<void, FileError>> {
		return Promise.resolve(this.deny(path));
	}

	override remove(path: string, _options: { recursive?: boolean; force?: boolean } | undefined, _context: Context): Promise<Result<void, FileError>> {
		return Promise.resolve(this.deny(path));
	}

	override createTempDir(_prefix: string | undefined, _context: Context): Promise<Result<string, FileError>> {
		return Promise.resolve(this.deny("tempdir"));
	}

	override createTempFile(_options: { prefix?: string; suffix?: string } | undefined, _context: Context): Promise<Result<string, FileError>> {
		return Promise.resolve(this.deny("tempfile"));
	}

	override exec(_command: string | readonly string[], _options: ShellExecOptions | undefined, _context: Context): Promise<Result<ShellExecResult, ExecutionError>> {
		return Promise.resolve({
			ok: false,
			error: new ExecutionError("shell_unavailable", "Shell execution is disabled in the durable workspace file runtime"),
		});
	}
}
