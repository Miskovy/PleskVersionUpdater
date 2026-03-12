import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { AutoSyncService } from './auto-sync.service';
import { UpdateModule } from '../update/update.module';
import { SubdomainModule } from '../subdomain/subdomain.module';

@Module({
    imports: [
        ScheduleModule.forRoot(),
        UpdateModule,
        SubdomainModule,
    ],
    providers: [AutoSyncService],
})
export class SchedulerModule { }
