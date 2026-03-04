import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import { FileDiffReport, SyncResult } from '../common/interfaces/sync-result.interface';

/**
 * Core file comparison and synchronization engine.
 * Compares directories by SHA-256 content hashes and copies only changed files.
 */
@Injectable()
export class FileSyncService {
    private readonly logger = new Logger(FileSyncService.name);
    private readonly excludedPaths: string[];

    constructor(private readonly configService: ConfigService) {
        this.excludedPaths = this.configService.get<string[]>('app.excludedPaths') || [];
    }

    // ============================================================================
    // Public API
    // ============================================================================

    /**
     * Compare two directories recursively and return a report of differences.
     * Uses SHA-256 content hashing for accurate comparison.
     */
    async compareDirectories(
        sourceDir: string,
        targetDir: string,
        customExcludes?: string[],
    ): Promise<FileDiffReport> {
        const excludes = customExcludes || this.excludedPaths;

        const sourceFiles = await this.walkDirectory(sourceDir, sourceDir, excludes);
        const targetFiles = await this.walkDirectory(targetDir, targetDir, excludes);

        const sourceMap = new Map(sourceFiles.map((f) => [f.relativePath, f.hash]));
        const targetMap = new Map(targetFiles.map((f) => [f.relativePath, f.hash]));

        const added: string[] = [];
        const modified: string[] = [];
        let unchanged = 0;
        const deleted: string[] = [];

        // Find added and modified files
        for (const [relPath, sourceHash] of sourceMap) {
            const targetHash = targetMap.get(relPath);
            if (!targetHash) {
                added.push(relPath);
            } else if (sourceHash !== targetHash) {
                modified.push(relPath);
            } else {
                unchanged++;
            }
        }

        // Find deleted files (in target but not in source)
        for (const [relPath] of targetMap) {
            if (!sourceMap.has(relPath)) {
                deleted.push(relPath);
            }
        }

        this.logger.log(
            `Comparison: ${added.length} added, ${modified.length} modified, ${unchanged} unchanged, ${deleted.length} deleted`,
        );

        return { added, modified, unchanged, deleted };
    }

    /**
     * Compare specific files between source and target directories.
     * Useful for checking package.json, package-lock.json, etc.
     */
    async compareSpecificFiles(
        sourceDir: string,
        targetDir: string,
        filenames: string[],
    ): Promise<FileDiffReport> {
        const added: string[] = [];
        const modified: string[] = [];
        let unchanged = 0;
        const deleted: string[] = [];

        for (const filename of filenames) {
            const sourcePath = path.join(sourceDir, filename);
            const targetPath = path.join(targetDir, filename);

            const sourceExists = await this.fileExists(sourcePath);
            const targetExists = await this.fileExists(targetPath);

            if (sourceExists && !targetExists) {
                added.push(filename);
            } else if (!sourceExists && targetExists) {
                deleted.push(filename);
            } else if (sourceExists && targetExists) {
                const sourceHash = await this.hashFile(sourcePath);
                const targetHash = await this.hashFile(targetPath);
                if (sourceHash !== targetHash) {
                    modified.push(filename);
                } else {
                    unchanged++;
                }
            }
        }

        return { added, modified, unchanged, deleted };
    }

    /**
     * Copy changed files from source to target directory.
     * Only copies files listed in the diff report (added + modified).
     */
    async syncChanges(
        sourceDir: string,
        targetDir: string,
        diff: FileDiffReport,
    ): Promise<SyncResult> {
        const startedAt = new Date();
        const copiedFiles: string[] = [];
        const errors: Array<{ file: string; error: string }> = [];

        const filesToCopy = [...diff.added, ...diff.modified];

        for (const relPath of filesToCopy) {
            const sourcePath = path.join(sourceDir, relPath);
            const targetPath = path.join(targetDir, relPath);

            try {
                // Ensure target directory exists
                const targetFileDir = path.dirname(targetPath);
                await fs.mkdir(targetFileDir, { recursive: true });

                // Copy the file
                await fs.copyFile(sourcePath, targetPath);
                copiedFiles.push(relPath);
            } catch (err: any) {
                this.logger.error(`Failed to copy ${relPath}: ${err.message}`);
                errors.push({ file: relPath, error: err.message });
            }
        }

        const completedAt = new Date();

        this.logger.log(
            `Sync complete: ${copiedFiles.length} copied, ${errors.length} errors`,
        );

        return {
            success: errors.length === 0,
            copiedFiles,
            errors,
            startedAt,
            completedAt,
        };
    }

    // ============================================================================
    // Private Helpers
    // ============================================================================

    /**
     * Recursively walk a directory and return all files with their relative paths and SHA-256 hashes.
     */
    private async walkDirectory(
        currentDir: string,
        rootDir: string,
        excludes: string[],
    ): Promise<Array<{ relativePath: string; hash: string }>> {
        const results: Array<{ relativePath: string; hash: string }> = [];

        let names: string[];
        try {
            names = await fs.readdir(currentDir);
        } catch (err: any) {
            this.logger.warn(`Cannot read directory ${currentDir}: ${err.message}`);
            return results;
        }

        for (const name of names) {
            // Skip excluded paths
            if (excludes.includes(name)) {
                continue;
            }

            const fullPath = path.join(currentDir, name);
            const stat = await fs.stat(fullPath);

            if (stat.isDirectory()) {
                const subResults = await this.walkDirectory(fullPath, rootDir, excludes);
                results.push(...subResults);
            } else if (stat.isFile()) {
                const relativePath = path.relative(rootDir, fullPath);
                const hash = await this.hashFile(fullPath);
                results.push({ relativePath, hash });
            }
        }

        return results;
    }

    /**
     * Compute SHA-256 hash of a file's contents.
     */
    private async hashFile(filePath: string): Promise<string> {
        const content = await fs.readFile(filePath);
        return crypto.createHash('sha256').update(content).digest('hex');
    }

    /**
     * Check if a file exists.
     */
    private async fileExists(filePath: string): Promise<boolean> {
        try {
            await fs.access(filePath);
            return true;
        } catch {
            return false;
        }
    }
}
