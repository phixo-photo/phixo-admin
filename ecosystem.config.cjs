/**
 * PM2 process file for phixo-admin (lives next to server.js in this repo).
 * Secrets and DATABASE_URL belong in .env (gitignored). After changing .env:
 *   pm2 restart phixo-admin
 *
 * Start / refresh:
 *   pm2 start ecosystem.config.cjs
 *   pm2 save
 */
module.exports = {
  apps: [
    {
      name: 'phixo-admin',
      script: 'server.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '700M',
      env: {
        NODE_ENV: 'production',
        PORT: 3000,
      },
    },
  ],
};
