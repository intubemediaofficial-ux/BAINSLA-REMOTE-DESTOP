const envKeys = [
  'PORT', 'BASE_PATH', 'DATA_DIR', 'DOWNLOADS_DIR', 'PUBLIC_ORIGIN',
  'ADMIN_EMAIL', 'ADMIN_PASSWORD', 'SESSION_SECRET', 'TURN_SECRET', 'TURN_HOST', 'BREVO_API_KEY', 'MAIL_FROM'
];

module.exports = {
  apps: [{
    name: 'bainsla-desk',
    script: 'server.js',
    cwd: __dirname,
    interpreter: process.execPath,
    instances: 1,
    exec_mode: 'fork',
    env: {
      NODE_ENV: 'production',
      ...Object.fromEntries(envKeys.flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]]]))
    }
  }]
};
