import { Module } from '@nestjs/common';
import { SubdomainService } from './subdomain.service';

@Module({
    providers: [SubdomainService],
    exports: [SubdomainService],
})
export class SubdomainModule { }
