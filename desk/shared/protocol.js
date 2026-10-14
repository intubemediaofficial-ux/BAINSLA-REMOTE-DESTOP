export const EVENTS = Object.freeze({
  agentHello: 'agent:hello',
  viewerConnect: 'viewer:connect',
  sessionRequest: 'session:request',
  sessionAnswer: 'session:answer',
  sessionAccepted: 'session:accepted',
  sessionRejected: 'session:rejected',
  signal: 'signal',
  sessionEnd: 'session:end'
});

export const FILE_CHUNK_SIZE = 16 * 1024;

export function socketPath(basePath = '') {
  return `${basePath.replace(/\/+$/, '')}/socket.io` || '/socket.io';
}
