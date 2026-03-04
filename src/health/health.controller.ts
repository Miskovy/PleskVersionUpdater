import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiOkResponse } from '@nestjs/swagger';
import { Public } from '../common/decorators/public.decorator';
import { HealthResponseDto } from '../update/dto/update-response.dto';

@ApiTags('Health')
@Controller('health')
export class HealthController {
    @Public()
    @Get()
    @ApiOperation({ summary: 'Health check', description: 'Public endpoint — no API key required. Returns service status, version, and timestamp.' })
    @ApiOkResponse({ description: 'Service is healthy', type: HealthResponseDto })
    check() {
        return {
            status: 'ok',
            service: 'plesk-version-updater',
            version: '1.0.0',
            timestamp: new Date().toISOString(),
        };
    }
}
