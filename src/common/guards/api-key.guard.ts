import {
    CanActivate,
    ExecutionContext,
    Injectable,
    UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';

/**
 * Guard that validates the `x-api-key` header against the configured API_KEY.
 * Routes decorated with @Public() bypass this guard.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
    constructor(
        private readonly configService: ConfigService,
        private readonly reflector: Reflector,
    ) { }

    canActivate(context: ExecutionContext): boolean {
        // Check if route is marked as public
        const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
            context.getHandler(),
            context.getClass(),
        ]);
        if (isPublic) return true;

        const request = context.switchToHttp().getRequest();
        const apiKey = request.headers['x-api-key'];
        const validKey = this.configService.get<string>('app.apiKey');

        if (!validKey) {
            throw new UnauthorizedException('API key not configured on server');
        }

        if (!apiKey || apiKey !== validKey) {
            throw new UnauthorizedException('Invalid or missing API key');
        }

        return true;
    }
}
