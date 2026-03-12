import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { UpdateService } from '../update/update.service';
import { SubdomainService } from '../subdomain/subdomain.service';

/**
 * Cron-based scheduler that automatically detects changes in the live
 * Systego directories and syncs them to master-builds (and optionally
 * to all client subdomains).
 *
 * Flow:
 *  1. Compare live systego.net vs master-builds/frontend-latest
 *  2. Compare live bcknd.systego.net vs master-builds/backend-latest
 *  3. If changes found → refresh master-builds
 *  4. If AUTO_SYNC_CLIENTS=true → sync all discovered client subdomains
 */
@Injectable()
export class AutoSyncService implements OnModuleInit {
    private readonly logger = new Logger(AutoSyncService.name);
    private running = false;

    constructor(
        private readonly configService: ConfigService,
        private readonly schedulerRegistry: SchedulerRegistry,
        private readonly updateService: UpdateService,
        private readonly subdomainService: SubdomainService,
    ) { }

    onModuleInit() {
        const enabled = this.configService.get<boolean>('app.autoSyncEnabled');
        const intervalMinutes = this.configService.get<number>('app.autoSyncIntervalMinutes') || 5;

        if (!enabled) {
            this.logger.log('⏸️  Auto-sync is DISABLED. Set AUTO_SYNC_ENABLED=true to enable.');
            return;
        }

        const intervalMs = intervalMinutes * 60 * 1000;
        this.logger.log(`✅ Auto-sync ENABLED — checking every ${intervalMinutes} minute(s)`);

        // Use setInterval for simple periodic polling
        const interval = setInterval(() => this.runAutoSync(), intervalMs);
        this.schedulerRegistry.addInterval('auto-sync', interval);

        // Run immediately on startup (after a short delay for the app to fully boot)
        setTimeout(() => this.runAutoSync(), 5000);
    }

    /**
     * Main auto-sync loop. Checks for changes and syncs if needed.
     * Protected against concurrent runs with a lock.
     */
    private async runAutoSync(): Promise<void> {
        if (this.running) {
            this.logger.warn('⏳ Auto-sync already running, skipping this cycle.');
            return;
        }

        this.running = true;
        const startTime = Date.now();

        try {
            this.logger.log('🔍 Auto-sync: checking for changes...');

            // Step 1: Check if live Systego has changed vs master-builds
            const masterCheck = await this.updateService.checkMasterChanges();

            const frontendChanges =
                (masterCheck.frontend?.diff.added.length || 0) +
                (masterCheck.frontend?.diff.modified.length || 0);
            const backendChanges =
                (masterCheck.backend?.diff.added.length || 0) +
                (masterCheck.backend?.diff.modified.length || 0);

            if (frontendChanges === 0 && backendChanges === 0) {
                this.logger.log('✅ Auto-sync: no changes detected. All up to date.');
                return;
            }

            this.logger.log(
                `📦 Auto-sync: detected ${frontendChanges} frontend + ${backendChanges} backend change(s). Refreshing master-builds...`,
            );

            // Step 2: Refresh master-builds from live deployments
            const refreshResult = await this.updateService.refreshMaster();
            const copiedToMaster =
                (refreshResult.frontend?.sync?.copiedFiles.length || 0) +
                (refreshResult.backend?.sync?.copiedFiles.length || 0);

            this.logger.log(`📦 Auto-sync: refreshed master-builds (${copiedToMaster} files copied).`);

            // Step 3: Optionally auto-sync all client subdomains
            const autoSyncClients = this.configService.get<boolean>('app.autoSyncClients');

            if (autoSyncClients) {
                await this.syncAllClients(frontendChanges > 0, backendChanges > 0);
            } else {
                this.logger.log(
                    '⏭️  Auto-sync: client sync skipped (AUTO_SYNC_CLIENTS=false). ' +
                    'Master-builds updated — use the API to sync individual clients.',
                );
            }
        } catch (err: any) {
            this.logger.error(`❌ Auto-sync failed: ${err.message}`);
        } finally {
            this.running = false;
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
            this.logger.log(`⏱️  Auto-sync cycle completed in ${elapsed}s`);
        }
    }

    /**
     * Discover all provisioned clients and sync them one-by-one.
     */
    private async syncAllClients(hasFrontendChanges: boolean, hasBackendChanges: boolean): Promise<void> {
        const clients = await this.subdomainService.listClientNames();

        if (clients.length === 0) {
            this.logger.log('Auto-sync: no clients discovered, nothing to sync.');
            return;
        }

        this.logger.log(`🔄 Auto-sync: syncing ${clients.length} client(s): ${clients.join(', ')}`);

        let successCount = 0;
        let errorCount = 0;

        for (const clientName of clients) {
            try {
                if (hasFrontendChanges && hasBackendChanges) {
                    await this.updateService.syncAll(clientName);
                } else if (hasFrontendChanges) {
                    await this.updateService.syncFrontend(clientName);
                } else if (hasBackendChanges) {
                    await this.updateService.syncBackend(clientName);
                }
                successCount++;
                this.logger.log(`  ✅ ${clientName} — synced`);
            } catch (err: any) {
                errorCount++;
                this.logger.error(`  ❌ ${clientName} — failed: ${err.message}`);
            }
        }

        this.logger.log(
            `🏁 Auto-sync clients: ${successCount} succeeded, ${errorCount} failed out of ${clients.length} total`,
        );
    }
}
