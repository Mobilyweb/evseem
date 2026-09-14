require("dotenv").config();

import { OcppVersion } from "./src/ocppVersion";
import { registerVcp } from "./src/close";
import { bootNotificationOcppOutgoing } from "./src/v201/messages/bootNotification";
import { statusNotificationOcppOutgoing } from "./src/v201/messages/statusNotification";
import { VCP } from "./src/vcp";

async function main(): Promise<VCP> {
  const vcp = new VCP({
    endpoint: process.env.WS_URL ?? "ws://localhost:3000",
    chargePointId: process.env.CP_ID ?? "123456",
    ocppVersion: OcppVersion.OCPP_2_0_1,
    basicAuthPassword: process.env.PASSWORD ?? undefined,
    adminPort: Number.parseInt(process.env.ADMIN_PORT ?? "9999"),
  });
  await vcp.connect();
  vcp.send(
    bootNotificationOcppOutgoing.request({
      reason: "PowerUp",
      chargingStation: {
        model: "VirtualChargePoint",
        vendorName: "Solidstudio",
      },
    }),
  );
  // Announce every configured connector/EVSE to the CS at boot. A connector the CS never saw a
  // StatusNotification for is a connector it doesn't know exists — the cockpit
  // (cockpit/services.ts) passes CONNECTORS from its "Connecteurs" config so a multi-connector
  // station (e.g. 2 EVSEs) is actually recognised as such, not just connector 1.
  const connectors = Number.parseInt(process.env.CONNECTORS ?? "1", 10) || 1;
  for (let connectorId = 1; connectorId <= connectors; connectorId++) {
    vcp.send(
      statusNotificationOcppOutgoing.request({
        evseId: connectorId,
        connectorId,
        connectorStatus: "Available",
        timestamp: new Date().toISOString(),
      }),
    );
  }
  return vcp;
}

main().then((vcp) => registerVcp(vcp, main));
