import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SubdomainService } from '../subdomain/subdomain.service';
import { FileSyncService } from '../file-sync/file-sync.service';
import {
    FileDiffReport,
    SyncResult,
    UpdateResult,
    MasterRefreshResult,
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

    // ============================================================================
    // Master Builds Refresh — sync live Systego → master-builds
    // ============================================================================

    /**
     * Check for changes between live Systego deployments and master-builds (dry run).
     */
    async checkMasterChanges(): Promise<MasterRefreshResult> {
        const liveFrontend = this.configService.get<string>('app.liveFrontendDir')!;
        const liveBackend = this.configService.get<string>('app.liveBackendDir')!;
        const masterFrontend = this.configService.get<string>('app.baseFrontendDir')!;
        const masterBackend = this.configService.get<string>('app.baseBackendDir')!;

        await this.subdomainService.validatePathsExist(liveFrontend, liveBackend, masterFrontend, masterBackend);

        // Frontend: compare everything, exclude node_modules, tmp, uploads
        const frontendExcludes = ['node_modules', 'tmp', 'uploads', '.git', '.env'];
        const frontendDiff = await this.fileSyncService.compareDirectories(
            liveFrontend,
            masterFrontend,
            frontendExcludes,
        );

        // Backend: compare only dist/, package.json, package-lock.json
        const backendDistDiff = await this.fileSyncService.compareDirectories(
            path.join(liveBackend, 'dist'),
            path.join(masterBackend, 'dist'),
        );
        const backendRootDiff = await this.fileSyncService.compareSpecificFiles(
            liveBackend,
            masterBackend,
            ['package.json', 'package-lock.json'],
        );
        const backendDiff = this.mergeBackendDiffs(backendDistDiff, backendRootDiff);

        return {
            dryRun: true,
            frontend: { diff: frontendDiff },
            backend: { diff: backendDiff },
        };
    }

    /**
     * Refresh master-builds from live Systego deployments (frontend + backend).
     * - Frontend: systego.net/httpdocs → master-builds/frontend-latest (all except node_modules, tmp, uploads)
     * - Backend: bcknd.systego.net → master-builds/backend-latest (dist/, package.json, package-lock.json)
     */
    async refreshMaster(): Promise<MasterRefreshResult> {
        const frontendResult = await this.refreshMasterFrontend();
        const backendResult = await this.refreshMasterBackend();

        return {
            dryRun: false,
            frontend: frontendResult.frontend,
            backend: backendResult.backend,
        };
    }

    /**
     * Refresh master-builds frontend from live systego.net.
     * Copies everything except node_modules, tmp, uploads.
     */
    async refreshMasterFrontend(): Promise<MasterRefreshResult> {
        const liveFrontend = this.configService.get<string>('app.liveFrontendDir')!;
        const masterFrontend = this.configService.get<string>('app.baseFrontendDir')!;

        await this.subdomainService.validatePathsExist(liveFrontend, masterFrontend);

        const frontendExcludes = ['node_modules', 'tmp', 'uploads', '.git', '.env'];

        this.logger.log(`[Master Refresh] Frontend: ${liveFrontend} → ${masterFrontend}`);
        const diff = await this.fileSyncService.compareDirectories(liveFrontend, masterFrontend, frontendExcludes);

        let sync: SyncResult | undefined;
        if (diff.added.length > 0 || diff.modified.length > 0) {
            this.logger.log(`[Master Refresh] Copying ${diff.added.length + diff.modified.length} frontend files...`);
            sync = await this.fileSyncService.syncChanges(liveFrontend, masterFrontend, diff);
        } else {
            this.logger.log('[Master Refresh] Frontend: no changes detected.');
        }

        return { dryRun: false, frontend: { diff, sync } };
    }

    /**
     * Refresh master-builds backend from live bcknd.systego.net.
     * Copies only dist/, package.json, package-lock.json.
     */
    async refreshMasterBackend(): Promise<MasterRefreshResult> {
        const liveBackend = this.configService.get<string>('app.liveBackendDir')!;
        const masterBackend = this.configService.get<string>('app.baseBackendDir')!;

        await this.subdomainService.validatePathsExist(liveBackend, masterBackend);

        this.logger.log(`[Master Refresh] Backend: ${liveBackend} → ${masterBackend}`);

        // Compare dist/ directory
        const distDiff = await this.fileSyncService.compareDirectories(
            path.join(liveBackend, 'dist'),
            path.join(masterBackend, 'dist'),
        );

        // Compare root files
        const rootDiff = await this.fileSyncService.compareSpecificFiles(
            liveBackend,
            masterBackend,
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

            if (hasDistChanges) {
                this.logger.log(`[Master Refresh] Copying ${distDiff.added.length + distDiff.modified.length} dist files...`);
                const distSync = await this.fileSyncService.syncChanges(
                    path.join(liveBackend, 'dist'),
                    path.join(masterBackend, 'dist'),
                    distDiff,
                );
                copiedFiles.push(...distSync.copiedFiles.map((f) => `dist/${f}`));
                errors.push(...distSync.errors);
            }

            if (hasRootChanges) {
                this.logger.log('[Master Refresh] Copying package files...');
                const rootSync = await this.fileSyncService.syncChanges(liveBackend, masterBackend, rootDiff);
                copiedFiles.push(...rootSync.copiedFiles);
                errors.push(...rootSync.errors);
            }

            sync = {
                success: errors.length === 0,
                copiedFiles,
                errors,
                startedAt,
                completedAt: new Date(),
            };
        } else {
            this.logger.log('[Master Refresh] Backend: no changes detected.');
        }

        return { dryRun: false, backend: { diff: mergedDiff, sync } };
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

        const rawDiff = await this.fileSyncService.compareDirectories(
            paths.baseFrontend,
            paths.clientFrontend,
        );

        // Filter out client logo files (logo-*.png in assets/) so the client's custom logo is preserved
        const diff = this.filterLogoFiles(rawDiff);

        let sync: SyncResult | undefined;

        if (diff.added.length > 0 || diff.modified.length > 0) {
            this.logger.log(`[Frontend Sync] Copying ${diff.added.length + diff.modified.length} files...`);
            sync = await this.fileSyncService.syncChanges(
                paths.baseFrontend,
                paths.clientFrontend,
                diff,
            );

            // Rebuild: inject the client-specific API URL into the compiled React bundles
            // Replaces https://bcknd.systego.net → https://api-{clientName}.systego.net
            // (mirrors injectApiUrlIntoBundle from ClientProvisioner.ts)
            const clientApiUrl = `https://api-${clientName}.systego.net`;
            this.logger.log(`[Frontend Rebuild] Injecting API URL: ${clientApiUrl}`);
            await this.injectApiUrlIntoBundle(paths.clientFrontend, clientApiUrl);

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
     * Fix file ownership and permissions to match Plesk expectations.
     * 
     * Plesk Apache/Nginx requires:
     *  - Ownership: systego:psacln (domain user + Plesk group)
     *  - Directories: 755 (rwxr-xr-x)
     *  - Files: 644 (rw-r--r--)
     * 
     * Without this, the web server returns 403 Forbidden.
     */
    private async fixOwnership(dir: string): Promise<void> {
        this.logger.log(`[Permissions] Fixing ownership and permissions on ${dir}...`);

        // 1. Try chown (requires root or matching user)
        try {
            await execAsync(`chown -R systego:psacln ${dir}`);
            this.logger.log(`[Permissions] ✅ chown -R systego:psacln succeeded`);
        } catch (err: any) {
            this.logger.warn(`[Permissions] ⚠️ chown failed: ${err.message}`);
            this.logger.warn(`[Permissions] Falling back to chmod to ensure web server can read files...`);
        }

        // 2. Always fix permissions (chmod) — this works even without root
        //    Directories: 755 (web server needs execute to traverse)
        //    Files: 644 (web server needs read access)
        try {
            await execAsync(`find ${dir} -type d -exec chmod 755 {} +`);
            await execAsync(`find ${dir} -type f -exec chmod 644 {} +`);
            this.logger.log(`[Permissions] ✅ chmod 755/644 applied successfully`);
        } catch (err: any) {
            this.logger.error(`[Permissions] ❌ chmod failed: ${err.message}`);
            this.logger.error(`[Permissions] The web server may return 403 Forbidden. Fix manually: chmod -R 755 ${dir}`);
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

    /**
     * Filter out client logo files from the diff report.
     * Logo files match the pattern "logo-*.png" inside the assets/ directory.
     * This ensures each client keeps their custom uploaded logo.
     */
    private filterLogoFiles(diff: FileDiffReport): FileDiffReport {
        const isLogoFile = (filePath: string): boolean => {
            const normalized = filePath.replace(/\\/g, '/');
            const basename = normalized.split('/').pop() || '';
            return (
                normalized.includes('assets/') &&
                basename.startsWith('logo-') &&
                basename.endsWith('.png')
            );
        };

        const filteredAdded = diff.added.filter((f) => !isLogoFile(f));
        const filteredModified = diff.modified.filter((f) => !isLogoFile(f));

        const logoSkipped = (diff.added.length - filteredAdded.length) + (diff.modified.length - filteredModified.length);
        if (logoSkipped > 0) {
            this.logger.log(`[Frontend Sync] Preserved ${logoSkipped} client logo file(s) — skipped from sync.`);
        }

        return {
            added: filteredAdded,
            modified: filteredModified,
            unchanged: diff.unchanged,
            deleted: diff.deleted,
        };
    }

    /**
     * Recursively scans a directory and replaces the old base API URL with the
     * client-specific API URL inside compiled JS, HTML, JSON, and .env files.
     * Mirrors injectApiUrlIntoBundle from ClientProvisioner.ts.
     */
    private async injectApiUrlIntoBundle(dirPath: string, newApiUrl: string): Promise<void> {
        const oldUrlBase = 'https://bcknd.systego.net';

        // Some React apps might use /api appended, some might not.
        // It's safest to just replace the base domain globally.
        // NOTE: The POS project uses "Bcknd" (capital B), so we must match case-insensitively.

        const scanAndReplace = async (currentDir: string) => {
            let entries: any[];
            try {
                entries = await fs.readdir(currentDir, { withFileTypes: true });
            } catch {
                return;
            }

            for (const entry of entries) {
                const fullPath = path.join(currentDir, entry.name);

                if (entry.isDirectory()) {
                    await scanAndReplace(fullPath);
                } else if (
                    entry.isFile() &&
                    (entry.name.endsWith('.js') || entry.name.endsWith('.html') || entry.name.endsWith('.json') || entry.name === '.env')
                ) {
                    try {
                        let content = await fs.readFile(fullPath, 'utf8');

                        // Case-insensitive check to catch both "bcknd" and "Bcknd"
                        if (content.toLowerCase().includes(oldUrlBase.toLowerCase())) {
                            // Replace all occurrences globally, case-insensitive
                            const regex = new RegExp(oldUrlBase.replace(/[.*/+?^${}()|[\]\\]/g, '\\$&'), 'gi');
                            content = content.replace(regex, newApiUrl);

                            await fs.writeFile(fullPath, content, 'utf8');
                            this.logger.log(`[Frontend Rebuild] Injected API URL into: ${entry.name}`);
                        }
                    } catch (err: any) {
                        this.logger.warn(`[Frontend Rebuild] Skipping ${entry.name} during injection: ${err.message}`);
                    }
                }
            }
        };

        await scanAndReplace(dirPath);
        this.logger.log(`[Frontend Rebuild] Finished injecting ${newApiUrl} into compiled React bundles.`);
    }
}
