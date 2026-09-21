/**
 * pm2 alternative to launchd (any OS):
 *   npm i -g pm2
 *   pm2 start ops/pm2.config.cjs        # start + auto-restart
 *   pm2 logs vnedge                     # tail stdout/stderr (also data/logs/vnedge.log, rotated by the app)
 *   pm2 restart vnedge | pm2 stop vnedge | pm2 delete vnedge
 *   pm2 save && pm2 startup             # re-create the process list at boot
 * Environment variables (PORT, HOST, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, LOG_FORMAT, VNEDGE_DATA_DIR)
 * can be set in the shell before `pm2 start` or under `env` below.
 */
const path = require('node:path');
const root = path.resolve(__dirname, '..');

module.exports = {
  apps: [
    {
      name: 'vnedge',
      cwd: root,
      script: 'server/src/index.ts',
      interpreter: 'node',
      interpreter_args: '--no-warnings=ExperimentalWarning',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      // crash-loop protection: at most 10 restarts, each after a growing delay
      max_restarts: 10,
      min_uptime: '20s',
      exp_backoff_restart_delay: 1000,
      restart_delay: 2000,
      // SIGTERM → graceful shutdown; pm2 waits this long before SIGKILL (ops.shutdownTimeoutMs + margin)
      kill_timeout: 45_000,
      wait_ready: false,
      max_memory_restart: '2G',
      out_file: path.join(root, 'data', 'logs', 'pm2.out.log'),
      error_file: path.join(root, 'data', 'logs', 'pm2.err.log'),
      merge_logs: true,
      time: true,
      env: {
        NODE_ENV: 'production',
        PORT: process.env.PORT || '8787',
        HOST: process.env.HOST || '127.0.0.1',
        LOG_FORMAT: process.env.LOG_FORMAT || 'text',
      },
    },
  ],
};
