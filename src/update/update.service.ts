import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SubdomainService } from '../subdomain/subdomain.service';
import { FileSyncService } from '../file-sync/file-sync.service';
import {
    FileDiffReport,
    SyncResult,
    UpdateResult,
} from '../common/interfaces/sync-result.interface';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as path from 'path';

const execAsync = promisify(exec);

/**
 * Orchestrates the update process: resolves paths, compares files,
 * copies changes, and redeploys the backend (mirroring ClientProvisioner.ts).
 */
@Injectable()
export class UpdateService {
    private readonly logger = new Logger(UpdateService.name);

    constructor(
        private readonly configService: ConfigService,
        private readonly subdomainService: SubdomainService,
        private readonly fileSyncService: FileSyncService,
    ) { }

    // ============================================================================
    // Public API
    // ============================================================================

    /**
     * Check for changes between base and client directories (dry run).
     * Returns diff reports without copying anything.
     */
    async checkForChanges(clientName: string): Promise<UpdateResult> {
        this.subdomainService.validateClientName(clientName);

        const paths = this.resolvePaths(clientName);
        await this.subdomainService.validatePathsExist(
            paths.baseFrontend,
            paths.baseBackend,
            paths.clientFrontend,
            paths.clientBackend,
        );

        // Compare frontend (full directory)
        const frontendDiff = await this.fileSyncService.compareDirectories(
            paths.baseFrontend,
            paths.clientFrontend,
        );

        // Compare backend dist folder
        const backendDistDiff = await this.fileSyncService.compareDirectories(
            path.join(paths.baseBackend, 'dist'),
            path.join(paths.clientBackend, 'dist'),
        );

        // Compare backend root files (package.json, package-lock.json)
        const backendRootDiff = await this.fileSyncService.compareSpecificFiles(
            paths.baseBackend,
            paths.clientBackend,
            ['package.json', 'package-lock.json'],
        );

        // Merge backend diffs
        const backendDiff = this.mergeBackendDiffs(backendDistDiff, backendRootDiff);

        return {
            clientName,
            dryRun: true,
            frontend: { diff: frontendDiff },
            backend: { diff: backendDiff },
        };
    }

    /**
     * Sync all changes (frontend + backend) from base to client.
     */
    async syncAll(clientName: string): Promise<UpdateResult> {
        this.subdomainService.validateClientName(clientName);

        const frontendResult = await this.syncFrontend(clientName);
        const backendResult = await this.syncBackend(clientName);

        return {
            clientName,
            dryRun: false,
            frontend: frontendResult.frontend,
            backend: backendResult.backend,
        };
    }

    /**
     * Sync only frontend changes from systego.net to {client}.systego.net.
     */
    async syncFrontend(clientName: string): Promise<UpdateResult> {
        this.subdomainService.validateClientName(clientName);

        const paths = this.resolvePaths(clientName);
        await this.subdomainService.validatePathsExist(
            paths.baseFrontend,
            paths.clientFrontend,
        );

        this.logger.log(`[Frontend Sync] Comparing ${paths.baseFrontend} → ${paths.clientFrontend}`);

        const diff = await this.fileSyncService.compareDirectories(
            paths.baseFrontend,
            paths.clientFrontend,
        );

        let sync: SyncResult | undefined;

        if (diff.added.length > 0 || diff.modified.length > 0) {
            this.logger.log(`[Frontend Sync] Copying ${diff.added.length + diff.modified.length} files...`);
            sync = await this.fileSyncService.syncChanges(
                paths.baseFrontend,
                paths.clientFrontend,
                diff,
            );

            // Fix file ownership after copying
            await this.fixOwnership(paths.clientFrontend);
        } else {
            this.logger.log('[Frontend Sync] No changes detected, skipping.');
        }

        return {
            clientName,
            dryRun: false,
            frontend: { diff, sync },
        };
    }

    /**
     * Sync only backend changes from bcknd.systego.net to api-{client}.systego.net.
     * Syncs: dist/ folder + package.json + package-lock.json
     * Then redeploys using the same pattern as ClientProvisioner.ts.
     */
    async syncBackend(clientName: string): Promise<UpdateResult> {
        this.subdomainService.validateClientName(clientName);

        const paths = this.resolvePaths(clientName);
        await this.subdomainService.validatePathsExist(
            paths.baseBackend,
            paths.clientBackend,
        );

        this.logger.log(`[Backend Sync] Comparing ${paths.baseBackend} → ${paths.clientBackend}`);

        // Compare dist/ directory
        const distDiff = await this.fileSyncService.compareDirectories(
            path.join(paths.baseBackend, 'dist'),
            path.join(paths.clientBackend, 'dist'),
        );

        // Compare root files
        const rootDiff = await this.fileSyncService.compareSpecificFiles(
            paths.baseBackend,
            paths.clientBackend,
            ['package.json', 'package-lock.json'],
        );

        const mergedDiff = this.mergeBackendDiffs(distDiff, rootDiff);

        let sync: SyncResult | undefined;
        const hasDistChanges = distDiff.added.length > 0 || distDiff.modified.length > 0;
        const hasRootChanges = rootDiff.added.length > 0 || rootDiff.modified.length > 0;

        if (hasDistChanges || hasRootChanges) {
            const startedAt = new Date();
            const copiedFiles: string[] = [];
            const errors: Array<{ file: string; error: string }> = [];

            // 1. Sync dist/ folder changes
            if (hasDistChanges) {
                this.logger.log(`[Backend Sync] Copying ${distDiff.added.length + distDiff.modified.length} dist files...`);
                const distSync = await this.fileSyncService.syncChanges(
                    path.join(paths.baseBackend, 'dist'),
                    path.join(paths.clientBackend, 'dist'),
                    distDiff,
                );
                copiedFiles.push(...distSync.copiedFiles.map((f) => `dist/${f}`));
                errors.push(...distSync.errors);
            }

            // 2. Sync root files (package.json, package-lock.json)
            if (hasRootChanges) {
                this.logger.log('[Backend Sync] Copying package files...');
                const rootSync = await this.fileSyncService.syncChanges(
                    paths.baseBackend,
                    paths.clientBackend,
                    rootDiff,
                );
                copiedFiles.push(...rootSync.copiedFiles);
                errors.push(...rootSync.errors);
            }

            // 3. Redeploy backend (mirrors ClientProvisioner.ts pattern)
            await this.redeployBackend(clientName, paths.clientBackend, hasRootChanges);

            sync = {
                success: errors.length === 0,
                copiedFiles,
                errors,
                startedAt,
                completedAt: new Date(),
            };
        } else {
            this.logger.log('[Backend Sync] No changes detected, skipping.');
        }

        return {
            clientName,
            dryRun: false,
            backend: { diff: mergedDiff, sync },
        };
    }

    // ============================================================================
    // Private Helpers
    // ============================================================================

    /**
     * Resolve all filesystem paths for a given client.
     */
    private resolvePaths(clientName: string) {
        return {
            baseFrontend: this.subdomainService.getBaseFrontendPath(),
            baseBackend: this.subdomainService.getBaseBackendPath(),
            clientFrontend: this.subdomainService.getClientFrontendPath(clientName),
            clientBackend: this.subdomainService.getClientBackendPath(clientName),
        };
    }

    /**
     * Merge dist/ diffs and root file diffs into a single report.
     * Prefixes dist files with "dist/" for clarity.
     */
    private mergeBackendDiffs(
        distDiff: FileDiffReport,
        rootDiff: FileDiffReport,
    ): FileDiffReport {
        return {
            added: [
                ...distDiff.added.map((f) => `dist/${f}`),
                ...rootDiff.added,
            ],
            modified: [
                ...distDiff.modified.map((f) => `dist/${f}`),
                ...rootDiff.modified,
            ],
            unchanged: distDiff.unchanged + rootDiff.unchanged,
            deleted: [
                ...distDiff.deleted.map((f) => `dist/${f}`),
                ...rootDiff.deleted,
            ],
        };
    }

    /**
     * Redeploy the backend after syncing files.
     * Mirrors the deployment pattern from ClientProvisioner.ts:
     *  - If package.json changed → npm install --production
     *  - Fix file ownership (chown -R systego:psacln)
     *  - Touch tmp/restart.txt to trigger Plesk Passenger restart
     */
    private async redeployBackend(
        clientName: string,
        backendDir: string,
        packageChanged: boolean,
    ): Promise<void> {
        this.logger.log(`[Redeploy] Starting redeployment for api-${clientName}...`);

        try {
            // 1. If package files changed, reinstall production dependencies
            if (packageChanged) {
                this.logger.log('[Redeploy] Package files changed — running npm install --production...');
                const { stdout, stderr } = await execAsync('npm install --production', {
                    cwd: backendDir,
                    timeout: 120000, // 2 minute timeout
                });
                if (stdout) this.logger.log(`[Redeploy] npm: ${stdout.trim()}`);
                if (stderr) this.logger.warn(`[Redeploy] npm stderr: ${stderr.trim()}`);
            }

            // 2. Fix file ownership for Plesk Passenger
            await this.fixOwnership(backendDir);

            // 3. Touch tmp/restart.txt to trigger Passenger restart
            await this.triggerNodeRestart(backendDir);

            this.logger.log(`[Redeploy] ✅ Redeployment complete for api-${clientName}`);
        } catch (err: any) {
            this.logger.error(`[Redeploy] ❌ Redeployment failed for api-${clientName}: ${err.message}`);
            throw err;
        }
    }

    /**
     * Fix file ownership to match Plesk Passenger expectations.
     * Uses chown -R systego:psacln (same as ClientProvisioner.ts).
     */
    private async fixOwnership(dir: string): Promise<void> {
        try {
            this.logger.log(`[Ownership] Fixing permissions on ${dir}...`);
            await execAsync(`chown -R systego:psacln ${dir}`);
        } catch (err: any) {
            this.logger.warn(`[Ownership] chown failed (may need root): ${err.message}`);
            // Non-fatal: might not have root permissions depending on deployment
        }
    }

    /**
     * Touch tmp/restart.txt to restart the Plesk Passenger Node.js app.
     * Mirrors triggerNodeRestart from ClientProvisioner.ts.
     */
    private async triggerNodeRestart(destDir: string): Promise<void> {
        const tmpDir = path.join(destDir, 'tmp');
        await fs.mkdir(tmpDir, { recursive: true }).catch(() => { });

        const restartFile = path.join(tmpDir, 'restart.txt');
        const time = new Date();

        try {
            await fs.utimes(restartFile, time, time);
        } catch {
            await fs.writeFile(restartFile, 'restart time: ' + time.toISOString());
        }

        this.logger.log('[Redeploy] Triggered Node.js restart (tmp/restart.txt)');
    }
}
