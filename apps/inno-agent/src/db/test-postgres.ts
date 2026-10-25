import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";

export interface TemporaryPostgres {
	databaseUrl: string;
	close(): Promise<void>;
}

async function unusedPort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Unable to allocate PostgreSQL test port");
	const port = address.port;
	await new Promise<void>((resolve) => server.close(() => resolve()));
	return port;
}

function run(command: string, args: string[]): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
		let output = "";
		child.stdout.on("data", (chunk) => { output += chunk; });
		child.stderr.on("data", (chunk) => { output += chunk; });
		child.once("error", reject);
		child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}: ${output}`)));
	});
}

export async function startTemporaryPostgres(): Promise<TemporaryPostgres> {
	const externalUrl = process.env.INNO_TEST_DATABASE_URL;
	if (externalUrl) {
		const databaseName = `inno_test_${randomUUID().replaceAll("-", "")}`;
		const admin = new Pool({ connectionString: externalUrl });
		const databaseUrl = new URL(externalUrl);
		databaseUrl.pathname = `/${databaseName}`;
		try {
			await admin.query(`CREATE DATABASE ${databaseName}`);
			return {
				databaseUrl: databaseUrl.toString(),
				async close() {
					await admin.query(`DROP DATABASE ${databaseName} WITH (FORCE)`);
					await admin.end();
				},
			};
		} catch (err) {
			await admin.end();
			throw new Error(`Unable to create a temporary PostgreSQL database: ${String(err)}`);
		}
	}

	const directory = await mkdtemp(join(tmpdir(), "inno-postgres-"));
	const port = await unusedPort();
	let database: ChildProcess | undefined;
	let pool: Pool | undefined;
	try {
		await run("initdb", ["--pgdata", directory, "--auth=trust", "--no-locale", "--username=postgres"]);
		database = spawn("postgres", ["-D", directory, "-h", "127.0.0.1", "-p", String(port), "-k", directory], {
			stdio: ["ignore", "ignore", "pipe"],
		});
		let databaseLog = "";
		database.stderr?.on("data", (chunk) => { databaseLog += chunk; });
		const databaseUrl = `postgresql://postgres@127.0.0.1:${port}/postgres`;
		pool = new Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 500 });
		const deadline = Date.now() + 15_000;
		while (true) {
			if (database.exitCode !== null) throw new Error(`PostgreSQL exited during startup: ${databaseLog}`);
			try {
				await pool.query("SELECT 1");
				break;
			} catch (err) {
				if (Date.now() >= deadline) throw err;
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
		}
		return {
			databaseUrl,
			async close() {
				await pool?.end();
				if (database?.exitCode === null) {
					database.kill("SIGTERM");
					await new Promise<void>((resolve) => database!.once("exit", () => resolve()));
				}
				await rm(directory, { recursive: true, force: true });
			},
		};
	} catch (err) {
		await pool?.end();
		database?.kill("SIGTERM");
		await rm(directory, { recursive: true, force: true });
		throw new Error(`A real PostgreSQL installation is required for integration tests: ${String(err)}`);
	}
}
