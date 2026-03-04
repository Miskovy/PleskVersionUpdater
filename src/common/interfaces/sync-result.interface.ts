/**
 * Represents a single file difference between source and target.
 */
export interface FileDiff {
    /** Relative path from the root directory */
    relativePath: string;
    /** Type of change */
    type: 'added' | 'modified' | 'deleted';
    /** File size in bytes (source) */
    sourceSize?: number;
    /** File size in bytes (target, if exists) */
    targetSize?: number;
}

/**
 * Report of all file differences between source and target directories.
 */
export interface FileDiffReport {
    added: string[];
    modified: string[];
    unchanged: number;
    deleted: string[];
}

/**
 * Result of a sync (copy) operation.
 */
export interface SyncResult {
    success: boolean;
    copiedFiles: string[];
    errors: Array<{ file: string; error: string }>;
    startedAt: Date;
    completedAt: Date;
}

/**
 * Full update result combining frontend and backend sync reports.
 */
export interface UpdateResult {
    clientName: string;
    dryRun: boolean;
    frontend?: {
        diff: FileDiffReport;
        sync?: SyncResult;
    };
    backend?: {
        diff: FileDiffReport;
        sync?: SyncResult;
    };
}
