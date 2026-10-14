const envKeys = [
  'PORT', 'BASE_PATH', 'DATA_DIR', 'DOWNLOADS_DIR', 'PUBLIC_ORIGIN',
  'ADMIN_EMAIL', 'ADMIN_PASSWORD', 'SESSION_SECRET', 'TURN_SECRET', 'TURN_HOST'
];

module.exports = {
  apps: [{
    name: 'remote',
    script: 'server.js',
    cwd: '/root/remote/app/server',
    interpreter: process.execPath,
    instances: 1,
    exec_mode: 'fork',
    env: {
      NODE_ENV: 'production',
      ...Object.fromEntries(envKeys.flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]]]))
    }
  }]
};
