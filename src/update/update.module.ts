import { Module } from '@nestjs/common';
import { UpdateController } from './update.controller';
import { UpdateService } from './update.service';
import { SubdomainModule } from '../subdomain/subdomain.module';
import { FileSyncModule } from '../file-sync/file-sync.module';

@Module({
    imports: [SubdomainModule, FileSyncModule],
    controllers: [UpdateController],
    providers: [UpdateService],
})
export class UpdateModule { }
