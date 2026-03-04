import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/**
 * Decorator to mark a route as public (bypasses API key guard).
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
