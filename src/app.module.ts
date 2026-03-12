import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import appConfig from './config/app.config';
import { ApiKeyGuard } from './common/guards/api-key.guard';
import { HealthModule } from './health/health.module';
import { SubdomainModule } from './subdomain/subdomain.module';
import { FileSyncModule } from './file-sync/file-sync.module';
import { UpdateModule } from './update/update.module';
import { SchedulerModule } from './scheduler/scheduler.module';

@Module({
    imports: [
        ConfigModule.forRoot({
            isGlobal: true,
            load: [appConfig],
            envFilePath: '.env',
        }),
        HealthModule,
        SubdomainModule,
        FileSyncModule,
        UpdateModule,
        SchedulerModule,
    ],
    providers: [
        // Apply API key guard globally — routes decorated with @Public() skip it
        {
            provide: APP_GUARD,
            useClass: ApiKeyGuard,
        },
    ],
})
export class AppModule { }
