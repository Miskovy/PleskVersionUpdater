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

    async checkForChanges(clientName: string): Promise<UpdateResult> {
        this.subdomainService.validateClientName(clientName);

        const paths = this.resolvePaths(clientName);
        await this.subdomainService.validatePathsExist(
            paths.baseFrontend,
            paths.baseBackend,
            paths.clientFrontend,
            paths.clientBackend,
        );

        const frontendDiff = await this.fileSyncService.compareDirectories(
            paths.baseFrontend,
            paths.clientFrontend,
        );

        const backendDistDiff = await this.fileSyncService.compareDirectories(
            path.join(paths.baseBackend, 'dist'),
            path.join(paths.clientBackend, 'dist'),
        );

        // التعديل هنا: فحص التغييرات في مجلد المايجريشن الخاص بـ Drizzle
        // لو المجلد عندك اسمه مختلف (مثلاً src/db/migrations)، عدل المسار هنا
        const backendDrizzleDiff = await this.fileSyncService.compareDirectories(
            path.join(paths.baseBackend, 'drizzle'),
            path.join(paths.clientBackend, 'drizzle'),
        ).catch(() => ({ added: [], modified: [], deleted: [], unchanged: 0 })); // Catch in case folder doesn't exist yet

        const backendRootDiff = await this.fileSyncService.compareSpecificFiles(
            paths.baseBackend,
            paths.clientBackend,
            ['package.json', 'package-lock.json'],
        );

        // دمج كل التغييرات
        const backendDiff = this.mergeBackendDiffs(backendDistDiff, backendDrizzleDiff, backendRootDiff);

        return {
            clientName,
            dryRun: true,
            frontend: { diff: frontendDiff },
            backend: { diff: backendDiff },
        };
    }

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
    // Master Builds Refresh
    // ============================================================================

    async checkMasterChanges(): Promise<MasterRefreshResult> {
        const liveFrontend = this.configService.get<string>('app.liveFrontendDir')!;
        const liveBackend = this.configService.get<string>('app.liveBackendDir')!;
        const masterFrontend = this.configService.get<string>('app.baseFrontendDir')!;
        const masterBackend = this.configService.get<string>('app.baseBackendDir')!;

        await this.subdomainService.validatePathsExist(liveFrontend, liveBackend, masterFrontend, masterBackend);

        const frontendExcludes = ['node_modules', 'tmp', 'uploads', '.git', '.env'];
        const frontendDiff = await this.fileSyncService.compareDirectories(
            liveFrontend,
            masterFrontend,
            frontendExcludes,
        );

        const backendDistDiff = await this.fileSyncService.compareDirectories(
            path.join(liveBackend, 'dist'),
            path.join(masterBackend, 'dist'),
        );

        const backendDrizzleDiff = await this.fileSyncService.compareDirectories(
            path.join(liveBackend, 'drizzle'),
            path.join(masterBackend, 'drizzle'),
        ).catch(() => ({ added: [], modified: [], deleted: [], unchanged: 0 }));

        const backendRootDiff = await this.fileSyncService.compareSpecificFiles(
            liveBackend,
            masterBackend,
            ['package.json', 'package-lock.json'],
        );

        const backendDiff = this.mergeBackendDiffs(backendDistDiff, backendDrizzleDiff, backendRootDiff);

        return {
            dryRun: true,
            frontend: { diff: frontendDiff },
            backend: { diff: backendDiff },
        };
    }

    async refreshMaster(): Promise<MasterRefreshResult> {
        const frontendResult = await this.refreshMasterFrontend();
        const backendResult = await this.refreshMasterBackend();

        return {
            dryRun: false,
            frontend: frontendResult.frontend,
            backend: backendResult.backend,
        };
    }

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

    async refreshMasterBackend(): Promise<MasterRefreshResult> {
        const liveBackend = this.configService.get<string>('app.liveBackendDir')!;
        const masterBackend = this.configService.get<string>('app.baseBackendDir')!;

        await this.subdomainService.validatePathsExist(liveBackend, masterBackend);

        this.logger.log(`[Master Refresh] Backend: ${liveBackend} → ${masterBackend}`);

        const distDiff = await this.fileSyncService.compareDirectories(
            path.join(liveBackend, 'dist'),
            path.join(masterBackend, 'dist'),
        );

        const drizzleDiff = await this.fileSyncService.compareDirectories(
            path.join(liveBackend, 'drizzle'),
            path.join(masterBackend, 'drizzle'),
        ).catch(() => ({ added: [], modified: [], deleted: [], unchanged: 0 }));

        const rootDiff = await this.fileSyncService.compareSpecificFiles(
            liveBackend,
            masterBackend,
            ['package.json', 'package-lock.json'],
        );

        const mergedDiff = this.mergeBackendDiffs(distDiff, drizzleDiff, rootDiff);

        let sync: SyncResult | undefined;
        const hasChanges = mergedDiff.added.length > 0 || mergedDiff.modified.length > 0;

        if (hasChanges) {
            const startedAt = new Date();
            const copiedFiles: string[] = [];
            const errors: Array<{ file: string; error: string }> = [];

            if (distDiff.added.length > 0 || distDiff.modified.length > 0) {
                this.logger.log(`[Master Refresh] Copying dist files...`);
                const distSync = await this.fileSyncService.syncChanges(
                    path.join(liveBackend, 'dist'),
                    path.join(masterBackend, 'dist'),
                    distDiff,
                );
                copiedFiles.push(...distSync.copiedFiles.map((f) => `dist/${f}`));
                errors.push(...distSync.errors);
            }

            if (drizzleDiff.added.length > 0 || drizzleDiff.modified.length > 0) {
                this.logger.log(`[Master Refresh] Copying Drizzle migrations...`);
                const drizzleSync = await this.fileSyncService.syncChanges(
                    path.join(liveBackend, 'drizzle'),
                    path.join(masterBackend, 'drizzle'),
                    drizzleDiff,
                );
                copiedFiles.push(...drizzleSync.copiedFiles.map((f) => `drizzle/${f}`));
                errors.push(...drizzleSync.errors);
            }

            if (rootDiff.added.length > 0 || rootDiff.modified.length > 0) {
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

        const diff = this.filterLogoFiles(rawDiff);

        let sync: SyncResult | undefined;

        if (diff.added.length > 0 || diff.modified.length > 0) {
            this.logger.log(`[Frontend Sync] Copying ${diff.added.length + diff.modified.length} files...`);
            sync = await this.fileSyncService.syncChanges(
                paths.baseFrontend,
                paths.clientFrontend,
                diff,
            );

            const clientApiUrl = `https://api-${clientName}.systego.net`;
            this.logger.log(`[Frontend Rebuild] Injecting API URL: ${clientApiUrl}`);
            await this.injectApiUrlIntoBundle(paths.clientFrontend, clientApiUrl);

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

    async syncBackend(clientName: string): Promise<UpdateResult> {
        this.subdomainService.validateClientName(clientName);

        const paths = this.resolvePaths(clientName);
        await this.subdomainService.validatePathsExist(
            paths.baseBackend,
            paths.clientBackend,
        );

        this.logger.log(`[Backend Sync] Comparing ${paths.baseBackend} → ${paths.clientBackend}`);

        const distDiff = await this.fileSyncService.compareDirectories(
            path.join(paths.baseBackend, 'dist'),
            path.join(paths.clientBackend, 'dist'),
        );

        const drizzleDiff = await this.fileSyncService.compareDirectories(
            path.join(paths.baseBackend, 'drizzle'),
            path.join(paths.clientBackend, 'drizzle'),
        ).catch(() => ({ added: [], modified: [], deleted: [], unchanged: 0 }));

        const rootDiff = await this.fileSyncService.compareSpecificFiles(
            paths.baseBackend,
            paths.clientBackend,
            ['package.json', 'package-lock.json'],
        );

        const mergedDiff = this.mergeBackendDiffs(distDiff, drizzleDiff, rootDiff);

        let sync: SyncResult | undefined;
        const hasChanges = mergedDiff.added.length > 0 || mergedDiff.modified.length > 0;

        if (hasChanges) {
            const startedAt = new Date();
            const copiedFiles: string[] = [];
            const errors: Array<{ file: string; error: string }> = [];

            // 1. Sync dist/
            if (distDiff.added.length > 0 || distDiff.modified.length > 0) {
                this.logger.log(`[Backend Sync] Copying dist files...`);
                const distSync = await this.fileSyncService.syncChanges(
                    path.join(paths.baseBackend, 'dist'),
                    path.join(paths.clientBackend, 'dist'),
                    distDiff,
                );
                copiedFiles.push(...distSync.copiedFiles.map((f) => `dist/${f}`));
                errors.push(...distSync.errors);
            }

            // 2. Sync drizzle/ migrations
            if (drizzleDiff.added.length > 0 || drizzleDiff.modified.length > 0) {
                this.logger.log(`[Backend Sync] Copying Drizzle migration files...`);
                const drizzleSync = await this.fileSyncService.syncChanges(
                    path.join(paths.baseBackend, 'drizzle'),
                    path.join(paths.clientBackend, 'drizzle'),
                    drizzleDiff,
                );
                copiedFiles.push(...drizzleSync.copiedFiles.map((f) => `drizzle/${f}`));
                errors.push(...drizzleSync.errors);
            }

            // 3. Sync root files
            if (rootDiff.added.length > 0 || rootDiff.modified.length > 0) {
                this.logger.log('[Backend Sync] Copying package files...');
                const rootSync = await this.fileSyncService.syncChanges(
                    paths.baseBackend,
                    paths.clientBackend,
                    rootDiff,
                );
                copiedFiles.push(...rootSync.copiedFiles);
                errors.push(...rootSync.errors);
            }

            // 4. Redeploy & Run Migrations
            const packageChanged = rootDiff.added.length > 0 || rootDiff.modified.length > 0;
            const dbChanged = drizzleDiff.added.length > 0 || drizzleDiff.modified.length > 0;
            
            await this.redeployBackend(clientName, paths.clientBackend, packageChanged, dbChanged);

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

    private resolvePaths(clientName: string) {
        return {
            baseFrontend: this.subdomainService.getBaseFrontendPath(),
            baseBackend: this.subdomainService.getBaseBackendPath(),
            clientFrontend: this.subdomainService.getClientFrontendPath(clientName),
            clientBackend: this.subdomainService.getClientBackendPath(clientName),
        };
    }

    private mergeBackendDiffs(
        distDiff: FileDiffReport,
        drizzleDiff: FileDiffReport,
        rootDiff: FileDiffReport,
    ): FileDiffReport {
        return {
            added: [
                ...distDiff.added.map((f) => `dist/${f}`),
                ...drizzleDiff.added.map((f) => `drizzle/${f}`),
                ...rootDiff.added,
            ],
            modified: [
                ...distDiff.modified.map((f) => `dist/${f}`),
                ...drizzleDiff.modified.map((f) => `drizzle/${f}`),
                ...rootDiff.modified,
            ],
            unchanged: distDiff.unchanged + drizzleDiff.unchanged + rootDiff.unchanged,
            deleted: [
                ...distDiff.deleted.map((f) => `dist/${f}`),
                ...drizzleDiff.deleted.map((f) => `drizzle/${f}`),
                ...rootDiff.deleted,
            ],
        };
    }

    private async redeployBackend(
        clientName: string,
        backendDir: string,
        packageChanged: boolean,
        dbChanged: boolean,
    ): Promise<void> {
        this.logger.log(`[Redeploy] Starting redeployment for api-${clientName}...`);

        try {
            if (packageChanged) {
                this.logger.log('[Redeploy] Package files changed — running npm install --production...');
                const { stdout, stderr } = await execAsync('npm install --production', {
                    cwd: backendDir,
                    timeout: 120000,
                });
                if (stdout) this.logger.log(`[Redeploy] npm: ${stdout.trim()}`);
                if (stderr) this.logger.warn(`[Redeploy] npm stderr: ${stderr.trim()}`);
            }

            // التعديل هنا: تشغيل Drizzle MySQL Migrations
            // تأكد إن عندك سكريبت في الـ package.json اسمه "db:migrate" أو عدل الأمر ده للأمر اللي بتستخدمه
            if (dbChanged || packageChanged) {
                 this.logger.log('[Redeploy] Running Drizzle MySQL Migrations...');
                 try {
                     // يمكنك استبدال "npm run db:migrate" بالأمر الفعلي الذي تستخدمه لتشغيل المايجريشن في السيرفر
                   const { stdout } = await execAsync('npm run migrate-db', { cwd: backendDir });
                     this.logger.log(`[Redeploy] Drizzle Migration success: ${stdout.trim()}`);
                 } catch (err: any) {
                     this.logger.error(`[Redeploy] ❌ Drizzle Migration failed: ${err.message}`);
                     // لا نقوم بعمل throw هنا حتى لا يتوقف باقي التحديث، ولكن يجب مراجعة السجلات
                 }
            }

            await this.fixOwnership(backendDir);
            await this.triggerNodeRestart(backendDir);

            this.logger.log(`[Redeploy] ✅ Redeployment complete for api-${clientName}`);
        } catch (err: any) {
            this.logger.error(`[Redeploy] ❌ Redeployment failed for api-${clientName}: ${err.message}`);
            throw err;
        }
    }

    private async fixOwnership(dir: string): Promise<void> {
        this.logger.log(`[Permissions] Fixing ownership and permissions on ${dir}...`);

        try {
            await execAsync(`chown -R systego:psacln ${dir}`);
            this.logger.log(`[Permissions] ✅ chown -R systego:psacln succeeded`);
        } catch (err: any) {
            this.logger.warn(`[Permissions] ⚠️ chown failed: ${err.message}`);
        }

        try {
            await execAsync(`find ${dir} -type d -exec chmod 755 {} +`);
            await execAsync(`find ${dir} -type f -exec chmod 644 {} +`);
            this.logger.log(`[Permissions] ✅ chmod 755/644 applied successfully`);
        } catch (err: any) {
            this.logger.error(`[Permissions] ❌ chmod failed: ${err.message}`);
        }
    }

    private async triggerNodeRestart(destDir: string): Promise<void> {
        const tmpDir = path.join(destDir, 'tmp');
        
        // التعديل هنا: التأكد من إعطاء مجلد tmp صلاحيات كاملة عشان Plesk يقدر يقرأ ملف الـ restart
        await fs.mkdir(tmpDir, { recursive: true }).catch(() => { });
        try {
            await execAsync(`chmod 777 ${tmpDir}`);
        } catch (e) {
             this.logger.warn(`Could not set 777 on tmp dir: ${e}`);
        }

        const restartFile = path.join(tmpDir, 'restart.txt');
        const time = new Date();

        try {
            await fs.utimes(restartFile, time, time);
        } catch {
            await fs.writeFile(restartFile, 'restart time: ' + time.toISOString());
        }

        // إعطاء صلاحيات للملف نفسه لضمان قراءته بواسطة Passenger
        try {
            await execAsync(`chmod 666 ${restartFile}`);
        } catch (e) {}

        this.logger.log('[Redeploy] Triggered Node.js restart (tmp/restart.txt)');
    }

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

    private async injectApiUrlIntoBundle(dirPath: string, newApiUrl: string): Promise<void> {
        const oldUrlBase = 'https://bcknd.systego.net';

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

                        if (content.toLowerCase().includes(oldUrlBase.toLowerCase())) {
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