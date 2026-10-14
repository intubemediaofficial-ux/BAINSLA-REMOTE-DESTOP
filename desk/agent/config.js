const fs = require('node:fs');
const path = require('node:path');
const {
  configDirectories, configDirectory, addressBookFilePath, isMachineWideConfig, isMachineWideConfigDirectory
} = require('./config-path');

function decodeConfig(data) {
  const config = { ...data, id: data.deviceId || data.id, secret: data.deviceSecret || data.secret };
  if (typeof data.unattendedPassword === 'string') {
    const match = /^scrypt\$([^$]+)\$([0-9a-f]+)$/i.exec(data.unattendedPassword);
    if (match) {
      config.passwordSalt = match[1];
      config.passwordHash = match[2];
    }
  }
  delete config.deviceId;
  delete config.deviceSecret;
  delete config.unattendedPassword;
  return config;
}

function encodeConfig(config) {
  const data = { ...config, deviceId: config.id || '', deviceSecret: config.secret || '' };
  if (config.passwordHash && config.passwordSalt) {
    data.unattendedPassword = `scrypt$${config.passwordSalt}$${config.passwordHash}`;
  } else {
    data.unattendedPassword = '';
  }
  delete data.id;
  delete data.secret;
  delete data.passwordHash;
  delete data.passwordSalt;
  return data;
}

function readConfig() {
  const defaults = {
    serverUrl: process.env.KVDESK_SERVER_URL || 'https://remote.bainslamusic.com',
    deviceName: process.env.COMPUTERNAME || process.env.HOSTNAME || require('node:os').hostname().replace(/\.local$/, '') || 'My Desk',
    allowControl: true, allowClipboard: true, allowFiles: true, autostart: true
  };
  for (const directory of configDirectories()) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(directory, 'config.json'), 'utf8'));
      return { ...defaults, ...(isMachineWideConfigDirectory(directory) ? decodeConfig(data) : data) };
    } catch {}
  }
  return defaults;
}
function writeJson(name, data) {
  const directory = configDirectory();
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, name);
  fs.writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 });
}
function saveConfig(config) {
  writeJson('config.json', isMachineWideConfig() ? encodeConfig(config) : config);
  return config;
}
function readAddressBook() {
  try {
    const book = JSON.parse(fs.readFileSync(addressBookFilePath(), 'utf8'));
    return Array.isArray(book) ? book : [];
  } catch {
    return [];
  }
}
function saveAddressBook(entries) {
  if (!Array.isArray(entries)) throw new TypeError('Address book must be an array');
  fs.mkdirSync(path.dirname(addressBookFilePath()), { recursive: true });
  fs.writeFileSync(addressBookFilePath(), JSON.stringify(entries, null, 2), { mode: 0o600 });
  return entries;
}

module.exports = { configDirectory, readConfig, saveConfig, readAddressBook, saveAddressBook };
