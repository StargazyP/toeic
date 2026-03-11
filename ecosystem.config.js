const os = require("os");

const CPU_COUNT = os.cpus().length;
const MIN_INSTANCES = Math.max(Math.ceil(CPU_COUNT / 2), 2);

module.exports = {
  apps: [
    {
      name: "toeic-api",
      script: "dist/index.js",
      cwd: "./api",
      instances: MIN_INSTANCES,
      exec_mode: "cluster",
      max_memory_restart: "512M",
      env: {
        NODE_ENV: "production",
        PORT: 4000,
      },
      exp_backoff_restart_delay: 100,
      max_restarts: 10,
      min_uptime: "10s",
      listen_timeout: 10000,
      kill_timeout: 5000,
      wait_ready: false,
      merge_logs: true,
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
    },
    {
      name: "toeic-autoscaler",
      script: "dist/autoscaler.js",
      cwd: "./api",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      max_memory_restart: "128M",
      env: {
        PM2_APP_NAME: "toeic-api",
        METRICS_URL: "http://127.0.0.1:4000/api/metrics",
        SCALE_MIN: String(MIN_INSTANCES),
        SCALE_MAX: String(CPU_COUNT),
        SCALE_POLL_MS: "15000",
        SCALE_COOLDOWN_MS: "60000",
      },
      exp_backoff_restart_delay: 500,
      max_restarts: 5,
      min_uptime: "5s",
      merge_logs: true,
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
    },
  ],
};
