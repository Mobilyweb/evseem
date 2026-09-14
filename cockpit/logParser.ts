// Parse the VCP child stdout (winston Console + colorize) into structured OCPP events
// and a derived "borne" state. Non-invasive: we never touch the OCPP code, we read its logs.

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI color codes
const ANSI = /\x1B\[[0-9;]*m/g;

const OUT_MARKERS = ["Sending message ➡️", "Responding with ➡️"];
const IN_MARKER = "Receive message ⬅️";

export type OcppDirection = "out" | "in";

export interface OcppEvent {
  direction: OcppDirection;
  messageType: number; // 2 = CALL, 3 = CALLRESULT, 4 = CALLERROR
  messageId: string;
  action?: string; // present for CALL (type 2)
  payload: unknown;
  raw: string;
  ts: string;
}

export interface ConnectorState {
  status: string; // last connector status (Available/Charging/Faulted/...)
  charging: boolean;
}

export interface BorneState {
  status: string; // last status seen (any connector) — kept for backward compat / fallback
  connectorId: number | null;
  transactionId: string | number | null;
  charging: boolean;
  powerKw: number | null;
  energyKwh: number | null;
  lastBoot: string | null;
  lastReset: string | null;
  lastUpdate: string | null;
  connectors: Record<number, ConnectorState>; // per-PDC status (multi-connector aware)
  // Internal bookkeeping (not meant for UI consumption) to attribute a StopTransaction — which
  // carries no connectorId, only a transactionId — back to the right connector when several are
  // charging at once. messageId -> connectorId while a StartTransaction is in flight, then
  // transactionId -> connectorId once the CALLRESULT assigns the real transaction id.
  pendingStartByMsgId: Record<string, number>;
  connectorByTransaction: Record<string, number>;
}

export function initialBorneState(): BorneState {
  return {
    status: "Unknown",
    connectorId: null,
    transactionId: null,
    charging: false,
    powerKw: null,
    energyKwh: null,
    lastBoot: null,
    lastReset: null,
    lastUpdate: null,
    connectors: {},
    pendingStartByMsgId: {},
    connectorByTransaction: {},
  };
}

// Extract the JSON OCPP array from a log line, if any. Returns null otherwise.
function extractOcppArray(line: string): unknown[] | null {
  const clean = line.replace(ANSI, "");
  const start = clean.indexOf("[");
  if (start === -1) return null;
  const slice = clean.slice(start);
  try {
    const parsed = JSON.parse(slice);
    if (Array.isArray(parsed) && typeof parsed[0] === "number") return parsed;
  } catch {
    // not a complete JSON array on this line
  }
  return null;
}

// Parse a single stdout line into an OcppEvent (or null if not an OCPP message line).
export function parseLine(line: string, ts: string): OcppEvent | null {
  const clean = line.replace(ANSI, "");
  const isOut = OUT_MARKERS.some((m) => clean.includes(m));
  const isIn = clean.includes(IN_MARKER);
  if (!isOut && !isIn) return null;

  const arr = extractOcppArray(clean);
  if (!arr) return null;

  const messageType = arr[0] as number;
  if (messageType === 2) {
    return {
      direction: isOut ? "out" : "in",
      messageType,
      messageId: String(arr[1]),
      action: String(arr[2]),
      payload: arr[3],
      raw: JSON.stringify(arr),
      ts,
    };
  }
  // CALLRESULT (3) / CALLERROR (4): [type, messageId, payload...]
  return {
    direction: isOut ? "out" : "in",
    messageType,
    messageId: String(arr[1]),
    payload: arr[2],
    raw: JSON.stringify(arr),
    ts,
  };
}

function num(v: unknown): number | null {
  const n = typeof v === "string" ? Number.parseFloat(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
}

// Pull power (kW) and energy (kWh) out of an OCPP MeterValues / TransactionEvent payload.
function readMeter(payload: any): { powerKw: number | null; energyKwh: number | null } {
  let powerKw: number | null = null;
  let energyKwh: number | null = null;
  const meterValues = payload?.meterValue ?? [];
  for (const mv of meterValues) {
    for (const sv of mv?.sampledValue ?? []) {
      const measurand = sv?.measurand ?? "Energy.Active.Import.Register";
      const unit = (sv?.unit ?? sv?.unitOfMeasure?.unit ?? "").toString().toLowerCase();
      const value = num(sv?.value);
      if (value === null) continue;
      if (measurand === "Power.Active.Import") {
        powerKw = unit === "w" ? value / 1000 : value; // assume kW unless W
      } else if (measurand === "Energy.Active.Import.Register") {
        energyKwh = unit === "wh" ? value / 1000 : value; // assume kWh unless Wh
      }
    }
  }
  return { powerKw, energyKwh };
}

// Mutate borne state from an OCPP event. Handles both v1.6 and v2.0.1 shapes.
// Record a status against a specific connector (and mirror it to the global fields).
function setConnectorStatus(state: BorneState, connectorId: number | null | undefined, status: string) {
  state.status = status;
  state.charging = status === "Charging" || status === "Occupied";
  if (connectorId != null) {
    state.connectorId = connectorId;
    state.connectors[connectorId] = { status, charging: state.charging };
  }
}

export function applyToBorne(state: BorneState, ev: OcppEvent): BorneState {
  state.lastUpdate = ev.ts;
  const p = ev.payload as any;

  if (ev.messageType === 2 && ev.action) {
    switch (ev.action) {
      case "BootNotification":
        state.lastBoot = ev.ts;
        break;
      case "Reset": {
        // Soft/hard reset from the CSMS is charge-point-wide (no connectorId) — flag every PDC.
        state.lastReset = ev.ts;
        for (const id of Object.keys(state.connectors)) {
          state.connectors[Number(id)] = { status: "Unavailable", charging: false };
        }
        state.status = "Unavailable";
        state.charging = false;
        break;
      }
      case "StatusNotification": {
        // v16: {connectorId, status}; v201: {evseId, connectorId, connectorStatus}
        const status = p?.status ?? p?.connectorStatus;
        // v201 models each cockpit connector as its own EVSE (connectorId is always 1), so the
        // EVSE id wins when present.
        if (status) setConnectorStatus(state, p?.evseId ?? p?.connectorId, status);
        break;
      }
      case "StartTransaction": {
        setConnectorStatus(state, p?.connectorId, "Charging");
        // Remember which connector this in-flight request is for, so the eventual CALLRESULT
        // (which only carries a transactionId) can be traced back to it.
        if (p?.connectorId != null) state.pendingStartByMsgId[ev.messageId] = p.connectorId;
        break;
      }
      case "StopTransaction": {
        state.transactionId = null;
        state.powerKw = 0;
        // StopTransaction carries no connectorId, only a transactionId. Resolve it via the
        // StartTransaction correlation above; only fall back to clearing every charging
        // connector when we genuinely can't tell which one stopped (e.g. mid-transition state).
        const connectorId = p?.transactionId != null ? state.connectorByTransaction[String(p.transactionId)] : undefined;
        if (connectorId != null) {
          state.connectors[connectorId] = { status: "Available", charging: false };
          delete state.connectorByTransaction[String(p.transactionId)];
        } else {
          for (const id of Object.keys(state.connectors)) {
            if (state.connectors[Number(id)].charging) state.connectors[Number(id)] = { status: "Available", charging: false };
          }
        }
        // Global fields stay "last known" for backward compat; reflect whether anything else is
        // still charging on another connector.
        state.charging = Object.values(state.connectors).some((c) => c.charging);
        state.status = state.charging ? state.status : "Available";
        break;
      }
      case "MeterValues": {
        const m = readMeter(p);
        if (m.powerKw !== null) state.powerKw = m.powerKw;
        if (m.energyKwh !== null) state.energyKwh = m.energyKwh;
        if (p?.transactionId != null) state.transactionId = p.transactionId;
        break;
      }
      case "TransactionEvent": {
        // v201 consolidated event
        const evType = p?.eventType;
        if (p?.transactionInfo?.transactionId != null) {
          state.transactionId = p.transactionInfo.transactionId;
        }
        const evseId = p?.evse?.id ?? null;
        if (evType === "Started") {
          setConnectorStatus(state, evseId, "Charging");
        } else if (evType === "Ended") {
          setConnectorStatus(state, evseId, "Available");
          state.transactionId = null;
          state.powerKw = 0;
        } else if (evseId != null) {
          state.connectorId = evseId;
        }
        const m = readMeter(p);
        if (m.powerKw !== null) state.powerKw = m.powerKw;
        if (m.energyKwh !== null) state.energyKwh = m.energyKwh;
        break;
      }
    }
  }

  // CALLRESULT to a StartTransaction gives us the transactionId (v16). Complete the
  // messageId -> connectorId -> transactionId correlation used by StopTransaction above.
  if (ev.messageType === 3 && p && typeof p === "object" && "transactionId" in p) {
    state.transactionId = (p as any).transactionId;
    const connectorId = state.pendingStartByMsgId[ev.messageId];
    if (connectorId != null) {
      state.connectorByTransaction[String((p as any).transactionId)] = connectorId;
      delete state.pendingStartByMsgId[ev.messageId];
    }
  }
  return state;
}
