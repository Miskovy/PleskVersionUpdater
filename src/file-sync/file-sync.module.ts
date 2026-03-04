import { Module } from '@nestjs/common';
import { FileSyncService } from './file-sync.service';

@Module({
    providers: [FileSyncService],
    exports: [FileSyncService],
})
export class FileSyncModule { }
