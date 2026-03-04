import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs/promises';
import * as path from 'path';

/**
 * Resolves filesystem paths for base and client subdomain directories.
 * Mirrors the path logic from ClientProvisioner.ts in Super-Systego.
 */
@Injectable()
export class SubdomainService {
    private readonly logger = new Logger(SubdomainService.name);

    private readonly vhostsDir: string;
    private readonly baseFrontendDir: string;
    private readonly baseBackendDir: string;

    constructor(private readonly configService: ConfigService) {
        this.vhostsDir = this.configService.get<string>('app.pleskVhostsDir')!;
        this.baseFrontendDir = this.configService.get<string>('app.baseFrontendDir')!;
        this.baseBackendDir = this.configService.get<string>('app.baseBackendDir')!;
    }

    /**
     * Returns the base frontend directory path.
     * e.g., /var/www/vhosts/systego.net/httpdocs
     */
    getBaseFrontendPath(): string {
        return this.baseFrontendDir;
    }

    /**
     * Returns the base backend directory path.
     * e.g., /var/www/vhosts/systego.net/subdomains/bcknd
     */
    getBaseBackendPath(): string {
        return this.baseBackendDir;
    }

    /**
     * Returns the client's frontend directory path.
     * e.g., /var/www/vhosts/systego.net/subdomains/townteam
     */
    getClientFrontendPath(clientName: string): string {
        return path.join(this.vhostsDir, clientName);
    }

    /**
     * Returns the client's backend directory path.
     * e.g., /var/www/vhosts/systego.net/subdomains/api-townteam
     */
    getClientBackendPath(clientName: string): string {
        return path.join(this.vhostsDir, `api-${clientName}`);
    }

    /**
     * Validates that a client name is a valid, safe subdomain prefix.
     * Must be lowercase, alphanumeric + hyphens, 2-63 chars, no leading/trailing hyphens.
     */
    validateClientName(clientName: string): void {
        if (!clientName || typeof clientName !== 'string') {
            throw new BadRequestException('clientName is required');
        }

        const sanitized = clientName.trim().toLowerCase();

        if (sanitized.length < 2 || sanitized.length > 63) {
            throw new BadRequestException('clientName must be between 2 and 63 characters');
        }

        if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(sanitized)) {
            throw new BadRequestException(
                'clientName must be lowercase, alphanumeric with hyphens only, and cannot start/end with a hyphen',
            );
        }
    }

    /**
     * Validates that all provided directory paths exist on disk.
     * Throws BadRequestException if any path is missing.
     */
    async validatePathsExist(...paths: string[]): Promise<void> {
        for (const p of paths) {
            try {
                await fs.access(p);
            } catch {
                throw new BadRequestException(
                    `Directory not found: ${p}. Ensure the client has been provisioned and paths are correct.`,
                );
            }
        }
    }
}
