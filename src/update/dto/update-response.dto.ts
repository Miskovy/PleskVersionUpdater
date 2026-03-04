import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class FileDiffReportDto {
    @ApiProperty({ description: 'Files present in source but not in target', example: ['assets/new-logo.png'] })
    added: string[];

    @ApiProperty({ description: 'Files that differ between source and target', example: ['index.html'] })
    modified: string[];

    @ApiProperty({ description: 'Number of files that are identical', example: 42 })
    unchanged: number;

    @ApiProperty({ description: 'Files present in target but not in source', example: [] })
    deleted: string[];
}

export class SyncErrorDto {
    @ApiProperty({ description: 'Relative path of the file that failed', example: 'dist/main.js' })
    file: string;

    @ApiProperty({ description: 'Error message', example: 'EACCES: permission denied' })
    error: string;
}

export class SyncResultDto {
    @ApiProperty({ description: 'Whether all files were copied without errors', example: true })
    success: boolean;

    @ApiProperty({ description: 'List of files that were successfully copied', example: ['index.html', 'assets/new-logo.png'] })
    copiedFiles: string[];

    @ApiProperty({ description: 'List of files that failed to copy', type: [SyncErrorDto] })
    errors: SyncErrorDto[];

    @ApiProperty({ description: 'Timestamp when sync started', example: '2026-03-04T19:00:00.000Z' })
    startedAt: Date;

    @ApiProperty({ description: 'Timestamp when sync completed', example: '2026-03-04T19:00:05.000Z' })
    completedAt: Date;
}

export class SyncSectionDto {
    @ApiProperty({ description: 'File difference report', type: FileDiffReportDto })
    diff: FileDiffReportDto;

    @ApiPropertyOptional({ description: 'Sync result (only present when files were copied)', type: SyncResultDto })
    sync?: SyncResultDto;
}

export class UpdateDataDto {
    @ApiProperty({ description: 'Client subdomain name', example: 'townteam' })
    clientName: string;

    @ApiProperty({ description: 'Whether this was a dry-run (no files copied)', example: false })
    dryRun: boolean;

    @ApiPropertyOptional({ description: 'Frontend sync details', type: SyncSectionDto })
    frontend?: SyncSectionDto;

    @ApiPropertyOptional({ description: 'Backend sync details', type: SyncSectionDto })
    backend?: SyncSectionDto;
}

export class UpdateResultDto {
    @ApiProperty({ description: 'Whether the operation was successful', example: true })
    success: boolean;

    @ApiProperty({ description: 'Update result data', type: UpdateDataDto })
    data: UpdateDataDto;
}

export class HealthResponseDto {
    @ApiProperty({ example: 'ok' })
    status: string;

    @ApiProperty({ example: 'plesk-version-updater' })
    service: string;

    @ApiProperty({ example: '1.0.0' })
    version: string;

    @ApiProperty({ example: '2026-03-04T19:00:00.000Z' })
    timestamp: string;
}
