/**
 * NEXUS - LAN discovery via UDP broadcast.
 *
 * - startBeacon(): periodically broadcasts a JSON beacon (hub or agent) to the LAN.
 * - startScanner(): listens for beacons and reports new/updated/removed peers.
 * - Multi-computer friendly: any machine may run a hub; agents discover ALL hubs
 *   on the subnet and connect to every one of them (full mesh).
 */
const dgram = require('dgram');
const os = require('os');

const DISCOVERY_PORT = 8889;
const BEACON_INTERVAL = 3000;
const STALE_MS = 12000;
const PROTO = 'nexus-1';

function lanInterfaces() {
  const list = [];
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const i of ifaces) {
      if (!i.internal && i.family === 'IPv4') list.push(i);
    }
  }
  return list;
}

function lanIP() {
  const ifaces = lanInterfaces();
  return ifaces.length ? ifaces[0].address : '127.0.0.1';
}

function localPeerIds() {
  const names = new Set([os.hostname().toLowerCase()]);
  const ips = new Set(['127.0.0.1', 'localhost']);

  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const i of ifaces || []) {
      if (i.internal) continue;
      if (i.family === 'IPv4') {
        ips.add(i.address);
        if (i.address) names.add(i.address);
      }
    }
  }

  return { names, ips };
}

function isOwnPeer(peer) {
  if (!peer) return false;
  const { names, ips } = localPeerIds();
  const host = String(peer.hostname || '').toLowerCase();
  const ip = String(peer.ip || '');
  return !!((host && names.has(host)) || (ip && ips.has(ip)));
}

function subnetBroadcasts() {
  const out = [];
  for (const i of lanInterfaces()) {
    const ip = i.address.split('.').map(Number);
    const mask = i.netmask.split('.').map(Number);
    out.push(ip.map((oct, idx) => (oct | (~mask[idx] & 255))).join('.'));
  }
  return out;
}

function buildBeacon(role, name, port) {
  return {
    proto: PROTO,
    role,
    name,
    hostname: os.hostname(),
    ip: lanIP(),
    port,
    id: `${os.hostname().toLowerCase()}:${role}:${port}`,
    t: Date.now()
  };
}

/**
 * Broadcasts this machine's presence as `role` on `port`.
 * Returns an object with a close() function and the socket.
 */
function startBeacon({ role, name, port }) {
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  let timer = null;

  socket.bind(DISCOVERY_PORT, () => {
    socket.setBroadcast(true);
    const beacon = buildBeacon(role, name, port);
    const msg = Buffer.from(JSON.stringify(beacon));
    const send = () => {
      const targets = ['255.255.255.255', ...subnetBroadcasts()];
      for (const addr of new Set(targets)) {
        try { socket.send(msg, 0, msg.length, DISCOVERY_PORT, addr); } catch {}
      }
    };
    send();
    timer = setInterval(send, BEACON_INTERVAL);
  });

  return {
    socket,
    close() { if (timer) clearInterval(timer); try { socket.close(); } catch {} }
  };
}

/**
 * Listens for beacons and invokes onPeer(peer) for every message.
 * Returns { socket, close() }.
 */
function startScanner(onPeer) {
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  socket.on('message', (msg, rinfo) => {
    try {
      const p = JSON.parse(msg.toString());
      if (!p || p.proto !== PROTO) return;
      onPeer({ ...p, src: rinfo.address, lastSeen: Date.now() });
    } catch {}
  });
  socket.bind(DISCOVERY_PORT, () => socket.setBroadcast(true));
  return { socket, close() { try { socket.close(); } catch {} } };
}

/**
 * Keeps a set of peers seen via the scanner, expires stale ones, and calls
 * onChange({ type: 'add'|'update'|'remove', peer }). Filter by role via opts.roles.
 */
function trackPeers(onChange, { roles = ['hub', 'agent'] } = {}) {
  const peers = new Map();
  const prune = setInterval(() => {
    const now = Date.now();
    for (const [id, p] of peers) {
      if (now - p.lastSeen > STALE_MS) {
        peers.delete(id);
        onChange({ type: 'remove', peer: p });
      }
    }
  }, 2000);

  const handle = (peer) => {
    if (!peer || !roles.includes(peer.role)) return;
    if (isOwnPeer(peer)) return;
    const prev = peers.get(peer.id);
    peers.set(peer.id, peer);
    onChange({ type: prev ? 'update' : 'add', peer });
  };

  const scanner = startScanner(handle);
  return {
    get all() { return [...peers.values()]; },
    close() { clearInterval(prune); scanner.close(); }
  };
}

module.exports = { DISCOVERY_PORT, startBeacon, startScanner, trackPeers, lanIP };
