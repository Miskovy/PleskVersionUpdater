import { Controller, Post, Body, Logger } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiOkResponse, ApiUnauthorizedResponse, ApiBadRequestResponse, ApiSecurity } from '@nestjs/swagger';
import { UpdateService } from './update.service';
import { UpdateRequestDto } from './dto/update-request.dto';
import { UpdateResultDto, MasterRefreshResultDto } from './dto/update-response.dto';

@ApiTags('Update')
@ApiSecurity('x-api-key')
@ApiUnauthorizedResponse({ description: 'Invalid or missing API key' })
@Controller('api/update')
export class UpdateController {
    private readonly logger = new Logger(UpdateController.name);

    constructor(private readonly updateService: UpdateService) { }

    // ============================================================================
    // Client Update Endpoints
    // ============================================================================

    /**
     * POST /api/update/check
     * Dry-run: compare master-builds vs client directories and return a diff report.
     */
    @Post('check')
    @ApiOperation({
        summary: 'Check for changes (dry run)',
        description: 'Compares master-builds with the client subdomain directories using SHA-256 content hashing. Returns a diff report without copying any files.',
    })
    @ApiBadRequestResponse({ description: 'Invalid client name or directory not found' })
    @ApiOkResponse({ description: 'Diff report returned successfully', type: UpdateResultDto })
    async checkForChanges(@Body() dto: UpdateRequestDto) {
        this.logger.log(`Checking for changes: ${dto.clientName}`);
        const result = await this.updateService.checkForChanges(dto.clientName);
        return { success: true, data: result };
    }

    /**
     * POST /api/update/sync
     * Compare and copy all changes (frontend + backend) to client directories.
     */
    @Post('sync')
    @ApiOperation({
        summary: 'Sync all changes (frontend + backend)',
        description: 'Compares and copies all changed files from master-builds to the client subdomain. Includes frontend files (with logo preservation + API URL injection), backend dist/, package.json, and triggers a backend redeploy.',
    })
    @ApiBadRequestResponse({ description: 'Invalid client name or directory not found' })
    @ApiOkResponse({ description: 'Full sync completed successfully', type: UpdateResultDto })
    async syncAll(@Body() dto: UpdateRequestDto) {
        this.logger.log(`Full sync requested: ${dto.clientName}`);
        const result = await this.updateService.syncAll(dto.clientName);
        return { success: true, data: result };
    }

    /**
     * POST /api/update/sync-frontend
     * Sync only frontend changes to {client}.systego.net.
     */
    @Post('sync-frontend')
    @ApiOperation({
        summary: 'Sync frontend only',
        description: 'Copies changed frontend files from master-builds/frontend-latest to the client subdomain. Preserves the client logo (logo-*.png), injects the client API URL (https://api-{client}.systego.net), and fixes file ownership.',
    })
    @ApiBadRequestResponse({ description: 'Invalid client name or directory not found' })
    @ApiOkResponse({ description: 'Frontend sync completed successfully', type: UpdateResultDto })
    async syncFrontend(@Body() dto: UpdateRequestDto) {
        this.logger.log(`Frontend sync requested: ${dto.clientName}`);
        const result = await this.updateService.syncFrontend(dto.clientName);
        return { success: true, data: result };
    }

    /**
     * POST /api/update/sync-backend
     * Sync only backend changes (dist/, package*.json) and redeploy.
     */
    @Post('sync-backend')
    @ApiOperation({
        summary: 'Sync backend only + redeploy',
        description: 'Copies changed backend files (dist/, package.json, package-lock.json) from master-builds/backend-latest to api-{client}.systego.net. Runs npm install --production if package files changed, fixes ownership (chown), and triggers a Passenger restart.',
    })
    @ApiBadRequestResponse({ description: 'Invalid client name or directory not found' })
    @ApiOkResponse({ description: 'Backend sync and redeploy completed successfully', type: UpdateResultDto })
    async syncBackend(@Body() dto: UpdateRequestDto) {
        this.logger.log(`Backend sync requested: ${dto.clientName}`);
        const result = await this.updateService.syncBackend(dto.clientName);
        return { success: true, data: result };
    }

    // ============================================================================
    // Master Builds Refresh Endpoints (live Systego → master-builds)
    // ============================================================================

    /**
     * POST /api/update/check-master
     * Dry-run: compare live systego.net & bcknd.systego.net vs master-builds.
     */
    @Post('check-master')
    @ApiOperation({
        summary: 'Check master-builds for updates (dry run)',
        description: 'Compares the live systego.net (httpdocs) and bcknd.systego.net against master-builds directories. Returns a diff report showing what would be updated. Frontend excludes: node_modules, tmp, uploads. Backend checks: dist/, package.json, package-lock.json only.',
    })
    @ApiOkResponse({ description: 'Master diff report returned', type: MasterRefreshResultDto })
    async checkMasterChanges() {
        this.logger.log('Checking master-builds for changes from live Systego...');
        const result = await this.updateService.checkMasterChanges();
        return { success: true, data: result };
    }

    /**
     * POST /api/update/refresh-master
     * Sync all changes from live Systego deployments into master-builds (FE + BE).
     */
    @Post('refresh-master')
    @ApiOperation({
        summary: 'Refresh master-builds (frontend + backend)',
        description: 'Syncs both frontend and backend from the live Systego deployments into the master-builds template directories. Frontend: all files except node_modules/tmp/uploads. Backend: dist/, package.json, package-lock.json.',
    })
    @ApiOkResponse({ description: 'Master refresh completed', type: MasterRefreshResultDto })
    async refreshMaster() {
        this.logger.log('Full master refresh requested...');
        const result = await this.updateService.refreshMaster();
        return { success: true, data: result };
    }

    /**
     * POST /api/update/refresh-master-frontend
     * Sync only frontend from live systego.net → master-builds/frontend-latest.
     */
    @Post('refresh-master-frontend')
    @ApiOperation({
        summary: 'Refresh master frontend only',
        description: 'Copies changed files from systego.net/httpdocs to master-builds/frontend-latest. Excludes node_modules, tmp, uploads, .git, .env.',
    })
    @ApiOkResponse({ description: 'Master frontend refresh completed', type: MasterRefreshResultDto })
    async refreshMasterFrontend() {
        this.logger.log('Master frontend refresh requested...');
        const result = await this.updateService.refreshMasterFrontend();
        return { success: true, data: result };
    }

    /**
     * POST /api/update/refresh-master-backend
     * Sync only backend from live bcknd.systego.net → master-builds/backend-latest.
     */
    @Post('refresh-master-backend')
    @ApiOperation({
        summary: 'Refresh master backend only',
        description: 'Copies changed backend files (dist/, package.json, package-lock.json) from bcknd.systego.net to master-builds/backend-latest.',
    })
    @ApiOkResponse({ description: 'Master backend refresh completed', type: MasterRefreshResultDto })
    async refreshMasterBackend() {
        this.logger.log('Master backend refresh requested...');
        const result = await this.updateService.refreshMasterBackend();
        return { success: true, data: result };
    }
}
