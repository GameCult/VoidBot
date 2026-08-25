import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createSignedHealthRecord } = require("./publish-idunn-rudp-health.cjs");

test("VoidBot health uses Idunn's canonical signed provider record", () => {
  const scratch = mkdtempSync(join(tmpdir(), "voidbot-health-"));
  try {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const privateKeyPath = join(scratch, "provider-health-private.pem");
    writeFileSync(privateKeyPath, privateKey.export({ format: "pem", type: "pkcs8" }));

    const signed = createSignedHealthRecord({
      daemonId: "yggdrasil-voidbot",
      healthContract: "voidbot.cultnet-rudp-stack-health",
      sourceRuntimeId: "voidbot-swarm-yggdrasil",
      privateKeyPath,
    }, {
      state: "active",
      detail: "VoidBot swarm publisher is serving its typed Eve surface.",
      observedAt: "2026-08-25T12:00:00.000Z",
    }, "00000000-0000-4000-8000-000000000031", 7);

    assert.deepEqual([...signed.payload.subarray(0, 3)], [0xdc, 0, 17]);
    assert.equal(signed.record.schemaVersion, "idunn.signed_daemon_health.v1");
    assert.equal(signed.record.signerIdentityId.length, 64);
    assert.equal(signed.signature.length, 64);
    assert.equal(verify(null, signed.signingMessage, publicKey, signed.signature), true);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
