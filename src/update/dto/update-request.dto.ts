import { IsString, IsNotEmpty } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class UpdateRequestDto {
    @ApiProperty({
        description: 'Client subdomain name (e.g. "townteam" for townteam.systego.net)',
        example: 'townteam',
    })
    @IsString()
    @IsNotEmpty()
    clientName: string;
}
