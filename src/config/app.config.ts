import { registerAs } from '@nestjs/config';

export default registerAs('app', () => ({
    port: parseInt(process.env.PORT || '3500', 10),
    pleskVhostsDir: process.env.PLESK_VHOSTS_DIR || '/var/www/vhosts/systego.net/subdomains',
    baseFrontendDir: process.env.BASE_FRONTEND_DIR || '/var/www/vhosts/systego.net/master-builds/frontend-latest',
    baseBackendDir: process.env.BASE_BACKEND_DIR || '/var/www/vhosts/systego.net/master-builds/backend-latest',
    liveFrontendDir: process.env.LIVE_FRONTEND_DIR || '/var/www/vhosts/systego.net/httpdocs',
    liveBackendDir: process.env.LIVE_BACKEND_DIR || '/var/www/vhosts/systego.net/subdomains/bcknd',
    apiKey: process.env.API_KEY || '',
    excludedPaths: (process.env.EXCLUDED_PATHS || 'node_modules,.env,.git,.htaccess,uploads,tmp,logs,startup-error.log,app.js,.vite,dist_cache')
        .split(',')
        .map((p) => p.trim()),
    // Scheduler config
    autoSyncEnabled: process.env.AUTO_SYNC_ENABLED === 'true',
    autoSyncIntervalMinutes: parseInt(process.env.AUTO_SYNC_INTERVAL_MINUTES || '5', 10),
    autoSyncClients: process.env.AUTO_SYNC_CLIENTS === 'true',
}));
