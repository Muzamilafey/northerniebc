// PM2 process file: pm2 start deploy/ecosystem.config.cjs --env production
// Run several API instances (Redis required for Socket.IO fan-out) and one worker instance.
module.exports = {
  apps: [
    {
      name: 'nie-api',
      cwd: './server',
      script: 'dist/index.js',
      node_args: '--env-file=.env',
      instances: 2,
      exec_mode: 'cluster',
      env: { RUN_WORKERS: 'false' },
      max_memory_restart: '768M',
      kill_timeout: 30000,
      listen_timeout: 15000,
      time: true
    },
    {
      name: 'nie-worker',
      cwd: './server',
      script: 'dist/index.js',
      node_args: '--env-file=.env',
      instances: 1,
      env: { RUN_WORKERS: 'true', PORT: '4100' },
      max_memory_restart: '512M',
      kill_timeout: 30000,
      time: true
    }
  ]
};
