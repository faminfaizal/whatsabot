// PM2: pm2 start ecosystem.config.js   (from this folder), then pm2 save
module.exports = {
  apps: [{
    name: 'parking-permit',
    script: 'server.js',
    cwd: __dirname,
    autorestart: true,
    max_restarts: 50,
    restart_delay: 5000,
    // One process only: it owns one WhatsApp session and one SQLite file
    instances: 1,
    exec_mode: 'fork',
  }],
};
