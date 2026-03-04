import { Controller, Post, Body, Logger } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiOkResponse, ApiUnauthorizedResponse, ApiBadRequestResponse, ApiSecurity } from '@nestjs/swagger';
import { UpdateService } from './update.service';
import { UpdateRequestDto } from './dto/update-request.dto';
import { UpdateResultDto } from './dto/update-response.dto';

@ApiTags('Update')
@ApiSecurity('x-api-key')
@ApiUnauthorizedResponse({ description: 'Invalid or missing API key' })
@ApiBadRequestResponse({ description: 'Invalid client name or directory not found' })
@Controller('api/update')
export class UpdateController {
    private readonly logger = new Logger(UpdateController.name);

    constructor(private readonly updateService: UpdateService) { }

    /**
     * POST /api/update/check
     * Dry-run: compare base vs client directories and return a diff report.
     * Does NOT copy any files.
     */
    @Post('check')
    @ApiOperation({
        summary: 'Check for changes (dry run)',
        description: 'Compares base Systego installation with the client subdomain directories using SHA-256 content hashing. Returns a diff report without copying any files.',
    })
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
        description: 'Compares and copies all changed files from the base Systego installation to the client subdomain. Includes frontend files, backend dist/, package.json, and triggers a backend redeploy.',
    })
    @ApiOkResponse({ description: 'Full sync completed successfully', type: UpdateResultDto })
    async syncAll(@Body() dto: UpdateRequestDto) {
        this.logger.log(`Full sync requested: ${dto.clientName}`);
        const result = await this.updateService.syncAll(dto.clientName);
        return { success: true, data: result };
    }

    /**
     * POST /api/update/sync-frontend
     * Sync only frontend changes from systego.net to {client}.systego.net.
     */
    @Post('sync-frontend')
    @ApiOperation({
        summary: 'Sync frontend only',
        description: 'Copies changed frontend files from systego.net (httpdocs) to the client subdomain directory. Fixes file ownership after copying.',
    })
    @ApiOkResponse({ description: 'Frontend sync completed successfully', type: UpdateResultDto })
    async syncFrontend(@Body() dto: UpdateRequestDto) {
        this.logger.log(`Frontend sync requested: ${dto.clientName}`);
        const result = await this.updateService.syncFrontend(dto.clientName);
        return { success: true, data: result };
    }

    /**
     * POST /api/update/sync-backend
     * Sync only backend changes (dist/, package.json, package-lock.json) and redeploy.
     */
    @Post('sync-backend')
    @ApiOperation({
        summary: 'Sync backend only',
        description: 'Copies changed backend files (dist/, package.json, package-lock.json) from bcknd.systego.net to api-{client}.systego.net. Runs npm install if package files changed and triggers a Passenger restart.',
    })
    @ApiOkResponse({ description: 'Backend sync completed successfully', type: UpdateResultDto })
    async syncBackend(@Body() dto: UpdateRequestDto) {
        this.logger.log(`Backend sync requested: ${dto.clientName}`);
        const result = await this.updateService.syncBackend(dto.clientName);
        return { success: true, data: result };
    }
}
