import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';

async function bootstrap() {
    const logger = new Logger('Bootstrap');
    const app = await NestFactory.create(AppModule);

    // Global pipes
    app.useGlobalPipes(
        new ValidationPipe({
            whitelist: true,
            forbidNonWhitelisted: true,
            transform: true,
        }),
    );

    // Global filters
    app.useGlobalFilters(new HttpExceptionFilter());

    // CORS — allow the Super Admin panel to call this service
    app.enableCors({ origin: '*' });

    // Swagger / OpenAPI documentation
    const swaggerConfig = new DocumentBuilder()
        .setTitle('Plesk Version Updater')
        .setDescription(
            'NestJS microservice that syncs file changes from the base Systego installation to client subdomain directories on Plesk. '
            + 'Uses SHA-256 content hashing to detect changed files and copies only what is different.',
        )
        .setVersion('1.0.0')
        .addApiKey(
            { type: 'apiKey', name: 'x-api-key', in: 'header', description: 'Plesk API key for authentication' },
            'x-api-key',
        )
        .build();

    const document = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup('api/docs', app, document);

    // Get port from config
    const configService = app.get(ConfigService);
    const port = configService.get<number>('app.port') || 3500;

    await app.listen(port);
    logger.log(`🚀 Plesk Version Updater running on port ${port}`);
    logger.log(`   Health check: http://localhost:${port}/health`);
    logger.log(`   Update API:   http://localhost:${port}/api/update/*`);
    logger.log(`   API Docs:     http://localhost:${port}/api/docs`);
}

bootstrap();
