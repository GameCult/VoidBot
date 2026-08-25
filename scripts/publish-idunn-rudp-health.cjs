"use strict";

const dgram = require("dgram");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const cultLibRoot = process.env.VOIDBOT_CULTLIB_ROOT
  ? path.resolve(process.env.VOIDBOT_CULTLIB_ROOT)
  : path.resolve(__dirname, "..", "..", "CultLib");
const cultLibPackages = path.join(cultLibRoot, "packages");
process.env.NODE_PATH = [cultLibPackages, process.env.NODE_PATH || ""].filter(Boolean).join(path.delimiter);
require("module").Module._initPaths();

const {
  CultNetRudpSession,
  decodeRudpPacket,
  encodeCultNetMessageForWire,
  encodeRudpPacket,
} = require("cultnet-ts");

const cultNetMsgpack = path.join(cultLibPackages, "cultnet-ts", "node_modules", "@msgpack", "msgpack");
const rootMsgpack = path.join(cultLibRoot, "node_modules", "@msgpack", "msgpack");
const { encode } = require(fs.existsSync(cultNetMsgpack) ? cultNetMsgpack : rootMsgpack);

const CULTNET_RUDP_PROTOCOL_ID = "cultnet.transport.rudp.v0";
const IDUNN_HEALTH_RUDP_CONNECTION_ID = 0x1d0d0001;
const SIGNED_HEALTH_SCHEMA = "idunn.signed_daemon_health.v1";
const PROVIDER_HEALTH_ID_DOMAIN = Buffer.from("gamecult.provider-health.identity.v1\0", "utf8");
const PROVIDER_HEALTH_SIGNATURE_DOMAIN = Buffer.from("gamecult.provider-health.signature.v1\0", "utf8");
const SIGNED_HEALTH_PURPOSE = Buffer.from(SIGNED_HEALTH_SCHEMA, "utf8");
const publisherIncarnationId = crypto.randomUUID();
let publisherSequence = 0;
const signerCache = new Map();

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const endpointValue = options.endpoint || process.env.VOIDBOT_IDUNN_RUDP_HEALTH;
  if (!endpointValue || !String(endpointValue).trim()) {
    throw new Error("VoidBot Idunn health publication requires --endpoint or VOIDBOT_IDUNN_RUDP_HEALTH; no localhost default is assumed.");
  }
  const endpoint = parseEndpoint(endpointValue);
  const daemonId = options.daemon || process.env.VOIDBOT_IDUNN_DAEMON || "voidbot";
  const healthContract = options.contract || process.env.VOIDBOT_IDUNN_HEALTH_CONTRACT || "voidbot.cultnet-rudp-stack-health";
  const state = options.state || "active";
  const observedAt = options.observedAt || new Date().toISOString();
  const detail = options.detail || "VoidBot swarm publisher is serving its typed Eve surface.";

  await publishIdunnRudpHealth({
    endpoint,
    daemonId,
    healthContract,
    sourceRuntimeId: process.env.VOIDBOT_IDUNN_SOURCE_RUNTIME || "voidbot-swarm-yggdrasil",
    privateKeyPath: process.env.VOIDBOT_IDUNN_HEALTH_PRIVATE_KEY,
  }, { state, detail, observedAt });
}

async function publishIdunnRudpHealth(publisher, health) {
  const socket = dgram.createSocket(endpointFamily(publisher.endpoint.host));
  await bindSocket(socket, publisher.endpoint);
  const receiver = createPacketReceiver(socket);
  const session = new CultNetRudpSession({
    connectionId: IDUNN_HEALTH_RUDP_CONNECTION_ID,
    initialSequence: 1,
    resendDelayMs: 100,
  });

  try {
    const connect = session.createConnect(Date.now(), new Uint8Array());
    await sendPacket(socket, publisher.endpoint, connect);
    await receiveUntil(
      receiver,
      session,
      publisher.endpoint,
      (packet) => packet.packetType === "accept",
      5000,
      "accept",
    );

    publisherSequence += 1;
    const signed = createSignedHealthRecord(
      publisher,
      health,
      publisherIncarnationId,
      publisherSequence,
    );
    const message = {
      schemaVersion: "cultnet.document_put_raw.v0",
      messageId: `voidbot-signed-health:${publisher.daemonId}:${publisherIncarnationId}:${publisherSequence}`,
      document: {
        schemaId: SIGNED_HEALTH_SCHEMA,
        recordKey: publisher.daemonId,
        storedAt: signed.record.observedAt,
        payloadEncoding: "messagepack",
        payload: signed.payload,
        sourceRuntimeId: signed.record.sourceRuntimeId,
        sourceAgentId: signed.record.signerIdentityId,
        sourceRole: "daemon-health-publisher",
        tags: [CULTNET_RUDP_PROTOCOL_ID],
      },
    };
    const wirePayload = encode(encodeCultNetMessageForWire(message, "cultnet.schema.v0"));
    const dataPackets = session.sendMany("schema", wirePayload, {
      reliable: true,
      ordered: true,
      nowMs: Date.now(),
    });
    const ack = receiveUntil(receiver, session, publisher.endpoint, (packet) => packet.packetType === "ack", 500, "ack")
      .catch(() => undefined);
    for (const packet of dataPackets) {
      await sendPacket(socket, publisher.endpoint, packet);
    }
    await ack;
  } finally {
    receiver.close();
    try {
      socket.unref();
    } catch {}
    await closeSocket(socket);
  }
}

function createSignedHealthRecord(publisher, health, incarnationId, sequence) {
  if (!publisher.privateKeyPath) {
    throw new Error("VoidBot signed Idunn health requires VOIDBOT_IDUNN_HEALTH_PRIVATE_KEY.");
  }
  if (!Number.isSafeInteger(sequence) || sequence <= 0) {
    throw new Error("VoidBot signed Idunn health sequence must be a positive safe integer.");
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(incarnationId)) {
    throw new Error("VoidBot signed Idunn health incarnation must be a UUID.");
  }
  if (!["active", "warming", "degraded", "failed"].includes(health.state)) {
    throw new Error(`Unsupported signed Idunn health state: ${health.state}`);
  }
  if (typeof health.detail !== "string" || health.detail.length > 512 || /[\u0000-\u001f\u007f]/.test(health.detail)) {
    throw new Error("VoidBot signed Idunn health detail is oversized or contains control characters.");
  }
  const observedAtUnixMillis = Date.parse(health.observedAt);
  if (!Number.isSafeInteger(observedAtUnixMillis) || observedAtUnixMillis <= 0) {
    throw new Error(`VoidBot signed Idunn health observation time is invalid: ${health.observedAt}`);
  }

  const signer = loadHealthSigner(publisher.privateKeyPath);
  const record = {
    schemaVersion: SIGNED_HEALTH_SCHEMA,
    daemonId: requiredIdentifier(publisher.daemonId, "daemon id"),
    healthContract: requiredIdentifier(publisher.healthContract, "health contract"),
    sourceRuntimeId: requiredIdentifier(publisher.sourceRuntimeId, "source runtime id"),
    state: health.state,
    detail: health.detail,
    signerIdentityId: signer.identityId,
    publisherIncarnationId: incarnationId,
    publisherSequence: sequence,
    observedAtUnixMillis,
    observedAt: new Date(observedAtUnixMillis).toISOString(),
    signatureAlgorithm: "ed25519",
  };
  const unsignedPayload = encodeSignedHealth(record, Buffer.alloc(0));
  const signingMessage = healthSigningMessage(unsignedPayload);
  const signature = crypto.sign(null, signingMessage, signer.privateKey);
  if (signature.length !== 64) {
    throw new Error(`VoidBot signed Idunn health produced ${signature.length} signature bytes, expected 64.`);
  }
  return {
    record,
    payload: encodeSignedHealth(record, signature),
    unsignedPayload,
    signingMessage,
    signature,
    publicKey: signer.publicKey,
  };
}

function encodeSignedHealth(record, signature) {
  return Buffer.from(encode([
    record.schemaVersion,
    record.daemonId,
    record.healthContract,
    record.sourceRuntimeId,
    record.state,
    record.detail,
    record.signerIdentityId,
    record.publisherIncarnationId,
    record.publisherSequence,
    record.observedAtUnixMillis,
    null,
    null,
    null,
    null,
    record.signatureAlgorithm,
    signature,
    false,
  ]));
}

function healthSigningMessage(payload) {
  const purposeLength = Buffer.alloc(8);
  purposeLength.writeBigUInt64BE(BigInt(SIGNED_HEALTH_PURPOSE.length));
  const payloadLength = Buffer.alloc(8);
  payloadLength.writeBigUInt64BE(BigInt(payload.length));
  return Buffer.concat([
    PROVIDER_HEALTH_SIGNATURE_DOMAIN,
    purposeLength,
    SIGNED_HEALTH_PURPOSE,
    payloadLength,
    payload,
  ]);
}

function loadHealthSigner(privateKeyPath) {
  const resolved = path.resolve(privateKeyPath);
  const cached = signerCache.get(resolved);
  if (cached) return cached;
  const privateKey = crypto.createPrivateKey(fs.readFileSync(resolved));
  if (privateKey.asymmetricKeyType !== "ed25519") {
    throw new Error(`VoidBot Idunn health key at ${resolved} is not Ed25519.`);
  }
  const publicKeyObject = crypto.createPublicKey(privateKey);
  const spki = Buffer.from(publicKeyObject.export({ format: "der", type: "spki" }));
  const ed25519SpkiPrefix = Buffer.from("302a300506032b6570032100", "hex");
  if (spki.length !== ed25519SpkiPrefix.length + 32 || !spki.subarray(0, ed25519SpkiPrefix.length).equals(ed25519SpkiPrefix)) {
    throw new Error(`VoidBot Idunn health key at ${resolved} has an unexpected Ed25519 public encoding.`);
  }
  const publicKey = spki.subarray(ed25519SpkiPrefix.length);
  const identityId = crypto.createHash("sha256")
    .update(PROVIDER_HEALTH_ID_DOMAIN)
    .update(publicKey)
    .digest("hex");
  const signer = { identityId, privateKey, publicKey, publicKeyObject };
  signerCache.set(resolved, signer);
  return signer;
}

function requiredIdentifier(value, label) {
  const text = String(value || "");
  if (!text.trim() || text.length > 256 || /[\u0000-\u001f\u007f]/.test(text)) {
    throw new Error(`VoidBot signed Idunn health ${label} is empty, oversized, or contains control characters.`);
  }
  return text;
}

async function bindSocket(socket, endpoint) {
  await new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.bind(0, endpoint.host.includes(":") ? "::" : "0.0.0.0", () => {
      socket.off("error", reject);
      resolve();
    });
  });
}

function parseArgs(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--endpoint":
        parsed.endpoint = args[++index];
        break;
      case "--daemon":
        parsed.daemon = args[++index];
        break;
      case "--contract":
        parsed.contract = args[++index];
        break;
      case "--state":
        parsed.state = args[++index];
        break;
      case "--detail":
        parsed.detail = args[++index];
        break;
      case "--observed-at":
        parsed.observedAt = args[++index];
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return parsed;
}

function parseEndpoint(value) {
  const text = String(value || "").trim();
  const ipv6 = text.match(/^\[([^\]]+)\]:(\d+)$/);
  if (ipv6) return { host: ipv6[1], port: parsePort(ipv6[2]) };
  const index = text.lastIndexOf(":");
  if (index <= 0) {
    throw new Error(`Idunn RUDP endpoint must be host:port, got "${value}".`);
  }
  return { host: text.slice(0, index), port: parsePort(text.slice(index + 1)) };
}

function parsePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Idunn RUDP endpoint port is invalid: ${value}`);
  }
  return port;
}

function endpointFamily(host) {
  return host.includes(":") ? "udp6" : "udp4";
}

async function receiveUntil(receiver, session, endpoint, predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const packet = await receiver.next(Math.min(100, deadline - Date.now()), label);
      const result = session.receive(packet, Date.now());
      if (result.reply) {
        throw new Error("VoidBot RUDP health publisher received an unexpected reply-required packet.");
      }
      if (predicate(packet)) return;
    } catch (error) {
      if (error.code !== "ETIMEDOUT") throw error;
    }
    for (const packet of session.dueResends(Date.now())) {
      await sendPacket(receiver.socket, endpoint, packet);
    }
  }
  throw new Error(`timed out waiting for Idunn RUDP ${label} response after ${timeoutMs}ms`);
}

function createPacketReceiver(socket) {
  const packets = [];
  const waiters = [];
  const errors = [];

  const resolveNext = () => {
    while (waiters.length > 0 && (packets.length > 0 || errors.length > 0)) {
      const waiter = waiters.shift();
      clearTimeout(waiter.timer);
      if (errors.length > 0) waiter.reject(errors.shift());
      else waiter.resolve(packets.shift());
    }
  };
  const onMessage = (wire) => {
    try {
      packets.push(decodeRudpPacket(wire));
    } catch (error) {
      errors.push(error);
    }
    resolveNext();
  };
  const onError = (error) => {
    errors.push(error);
    resolveNext();
  };

  socket.on("message", onMessage);
  socket.on("error", onError);

  return {
    socket,
    next(timeoutMs, label = "packet") {
      if (packets.length > 0) return Promise.resolve(packets.shift());
      if (errors.length > 0) return Promise.reject(errors.shift());
      return new Promise((resolve, reject) => {
        const waiter = {
          resolve,
          reject,
          timer: setTimeout(() => {
            const index = waiters.indexOf(waiter);
            if (index >= 0) waiters.splice(index, 1);
            const error = new Error(`timed out waiting for Idunn RUDP ${label}`);
            error.code = "ETIMEDOUT";
            reject(error);
          }, Math.max(1, timeoutMs)),
        };
        waiters.push(waiter);
      });
    },
    close() {
      socket.off("message", onMessage);
      socket.off("error", onError);
      while (waiters.length > 0) {
        const waiter = waiters.shift();
        clearTimeout(waiter.timer);
        const error = new Error("VoidBot RUDP health publisher closed.");
        error.code = "ECLOSED";
        waiter.reject(error);
      }
    },
  };
}

async function sendPacket(socket, endpoint, packet) {
  const wire = encodeRudpPacket(packet);
  await new Promise((resolve, reject) => {
    socket.send(wire, endpoint.port, endpoint.host, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function closeSocket(socket) {
  await new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    socket.once("close", finish);
    try {
      socket.close(finish);
    } catch {
      finish();
    }
  });
}

module.exports = { createSignedHealthRecord, publishIdunnRudpHealth, parseEndpoint };

if (require.main === module) {
  main().catch((error) => {
    console.error(error?.stack || String(error));
    process.exit(1);
  });
}
