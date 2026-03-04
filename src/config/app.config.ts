import { registerAs } from '@nestjs/config';

export default registerAs('app', () => ({
    port: parseInt(process.env.PORT || '3500', 10),
    pleskVhostsDir: process.env.PLESK_VHOSTS_DIR || '/var/www/vhosts/systego.net/subdomains',
    baseFrontendDir: process.env.BASE_FRONTEND_DIR || '/var/www/vhosts/systego.net/master-builds/frontend-latest',
    baseBackendDir: process.env.BASE_BACKEND_DIR || '/var/www/vhosts/systego.net/master-builds/backend-latest',
    apiKey: process.env.API_KEY || '',
    excludedPaths: (process.env.EXCLUDED_PATHS || 'node_modules,.env,.git,.htaccess,uploads,tmp,logs,startup-error.log,app.js,.vite,dist_cache')
        .split(',')
        .map((p) => p.trim()),
}));
