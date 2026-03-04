import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiOkResponse } from '@nestjs/swagger';
import { Public } from '../common/decorators/public.decorator';
import { HealthResponseDto } from '../update/dto/update-response.dto';

@ApiTags('Health')
@Controller('health')
export class HealthController {
    @Public()
    @Get()
    @ApiOperation({
        summary: 'Health check',
        description: 'Returns the service status. This endpoint is public and does not require an API key.',
    })
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
