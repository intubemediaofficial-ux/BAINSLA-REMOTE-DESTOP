const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

function userDataDirectory() {
  return process.env.KVDESK_CONFIG_DIR
    ? path.resolve(process.env.KVDESK_CONFIG_DIR)
    : app.getPath('userData');
}

function programDataDirectory() {
  return path.join(process.env.ProgramData || 'C:\\ProgramData', 'Bainsla Remote');
}

function machineConfigAvailable(directory) {
  try {
    fs.accessSync(path.join(directory, 'config.json'), fs.constants.R_OK | fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function machineDirectoryAvailable(directory) {
  try {
    fs.mkdirSync(directory, { recursive: true });
    fs.accessSync(directory, fs.constants.R_OK | fs.constants.W_OK);
    return !fs.existsSync(path.join(directory, 'config.json')) || machineConfigAvailable(directory);
  } catch {
    return false;
  }
}

function configDirectories() {
  const userData = userDataDirectory();
  if (process.env.KVDESK_CONFIG_DIR || process.platform !== 'win32') return [userData];

  const machineData = programDataDirectory();
  if (process.argv.includes('--service')) {
    return machineDirectoryAvailable(machineData) ? [machineData, userData] : [userData];
  }

  return machineConfigAvailable(machineData) ? [machineData, userData] : [userData];
}

function configDirectory() {
  return configDirectories()[0];
}

function configFilePath() {
  return path.join(configDirectory(), 'config.json');
}

function addressBookFilePath() {
  return path.join(userDataDirectory(), 'book.json');
}

function agentHeartbeatFilePath() {
  return path.join(configDirectory(), 'agent.heartbeat');
}

function isMachineWideConfig() {
  return !process.env.KVDESK_CONFIG_DIR
    && process.platform === 'win32'
    && path.resolve(configDirectory()).toLowerCase() === path.resolve(programDataDirectory()).toLowerCase();
}

function isMachineWideConfigDirectory(directory) {
  return !process.env.KVDESK_CONFIG_DIR
    && process.platform === 'win32'
    && path.resolve(directory).toLowerCase() === path.resolve(programDataDirectory()).toLowerCase();
}

module.exports = {
  configDirectories, configDirectory, configFilePath, addressBookFilePath,
  agentHeartbeatFilePath, isMachineWideConfig, isMachineWideConfigDirectory
};
