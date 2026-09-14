import { EventEmitter } from "node:events";
import type { OcppEvent } from "./logParser";

// Per-connector charge session engine. The single source of truth for charge lifecycle:
// a guarded state machine drives the OCPP messages (via the VCP admin API) step by step —
// Authorize, then StartTransaction, then StopTransaction — and pairs every CSMS answer with its
// request by messageId (read from the VCP log). MeterValues can tick automatically with a
// realistic power curve and a smart-charging clamp, or be composed and sent by hand.
// The UI is a pure observer (SSE). Running in Node makes it survive page reloads.

// idle → authorizing → ready (Authorize answered, whatever the result) → starting → charging
//      → finishing → idle. A Start may be forced from idle/ready to test a CSMS on an
// unauthorized tag.
export type SessionState = "idle" | "authorizing" | "ready" | "starting" | "charging" | "finishing";

export interface SessionView {
  connectorId: number;
  state: SessionState;
  idTag: string | null;
  // Authorize outcome: "pending", an OCPP idTagInfo status (Accepted, Invalid…), "NoResponse" or
  // "Error" (CALLERROR). null until an Authorize is sent.
  authStatus: string | null;
  autoMeter: boolean; // tick MeterValues automatically while charging
  transactionId: number | null;
  soc: number;
  voltage: number;
  current: number; // target current (A), from cockpit config
  phases: number;
  powerKw: number;
  energyKwh: number;
  cappedBy: "none" | "smart" | "soc";
  samples: number[]; // recent power samples (kW) for the sparkline
}

export interface Receipt {
  connectorId: number;
  transactionId: number | null;
  durationSec: number;
  energyKwh: number;
  avgKw: number;
  peakKw: number;
  ts: string;
}

// One OCPP 1.6 SampledValue as composed in the UI (empty optional fields are dropped).
export interface SampledValue {
  value: string | number;
  measurand?: string;
  unit?: string;
  phase?: string;
  context?: string;
  location?: string;
  format?: string;
}

type Result = { ok: boolean; reason?: string };

interface Session extends SessionView {
  startedAt: number | null;
  energyWh: number;
  peakKw: number;
  sumKw: number;
  ticks: number;
  timer?: ReturnType<typeof setInterval>; // MeterValues tick loop
  watchdog?: ReturnType<typeof setTimeout>; // waits for the CSMS answer of the current step
}

export interface ChargeConfig {
  adminPort: number;
  voltage: number;
  current: number;
  phases: number;
  connectors: number;
  sessionFullSeconds: number;
}

const TICK_SEC = 5;
const SAMPLE_CAP = 80;
// A step (Authorize, StartTransaction) left unanswered this long is marked as such, so a connector
// can never stay stuck waiting. Staging answers in ~15 s, hence the margin; a later answer is still
// applied (see onAuthorizeResult / onStartResult).
const RESPONSE_TIMEOUT_SEC = 60;
const TRACKED_CALLS_CAP = 200;

// CC/CV-ish curve: full power until 80% SoC, then taper towards ~8%.
function curveFactor(soc: number): number {
  if (soc < 80) return 1;
  return Math.max(0.08, 1 - ((soc - 80) / 20) * 0.92);
}

// Emits: 'session' (SessionView), 'receipt' (Receipt), 'notice' ({kind, message})
export class ChargeSessionManager extends EventEmitter {
  private sessions = new Map<number, Session>();
  private autoMeterPref = new Map<number, boolean>(); // per-connector toggle, survives sessions
  // "Available" StatusNotifications sent by the engine itself and not yet seen in the VCP log, so
  // their echo isn't mistaken for a manual one (which would abandon a freshly started handshake).
  private ownAvailable = new Map<number, number>();
  // Connectors whose Authorize CALL hasn't appeared in the VCP log yet. Authorize carries no
  // connectorId, so its messageId is bound to the oldest waiting connector once it's logged.
  private pendingAuthorize: number[] = [];
  // Outgoing CALLs awaiting an answer, by messageId.
  private calls = new Map<string, { action: "Authorize" | "StartTransaction"; connectorId: number }>();
  private cfg: () => ChargeConfig;

  constructor(cfgGetter: () => ChargeConfig) {
    super();
    this.cfg = cfgGetter;
  }

  private blank(connectorId: number): Session {
    const c = this.cfg();
    return {
      connectorId,
      state: "idle",
      idTag: null,
      authStatus: null,
      autoMeter: this.autoMeterPref.get(connectorId) ?? true,
      transactionId: null,
      soc: 0,
      voltage: c.voltage,
      current: c.current,
      phases: c.phases,
      powerKw: 0,
      energyKwh: 0,
      cappedBy: "none",
      samples: [],
      startedAt: null,
      energyWh: 0,
      peakKw: 0,
      sumKw: 0,
      ticks: 0,
    };
  }

  private get(connectorId: number): Session {
    let s = this.sessions.get(connectorId);
    if (!s) {
      s = this.blank(connectorId);
      this.sessions.set(connectorId, s);
    }
    return s;
  }

  private view(s: Session): SessionView {
    const { startedAt, energyWh, peakKw, sumKw, ticks, timer, watchdog, ...view } = s;
    return view;
  }

  private stopTicking(s: Session) {
    if (s.timer) { clearInterval(s.timer); s.timer = undefined; }
  }

  private clearTimers(s: Session) {
    this.stopTicking(s);
    if (s.watchdog) { clearTimeout(s.watchdog); s.watchdog = undefined; }
  }

  private armWatchdog(connectorId: number, waitingIn: SessionState, onTimeout: (s: Session) => void) {
    const s = this.get(connectorId);
    if (s.watchdog) clearTimeout(s.watchdog);
    s.watchdog = setTimeout(() => {
      s.watchdog = undefined;
      const cur = this.sessions.get(connectorId);
      if (cur?.state === waitingIn) onTimeout(cur);
    }, RESPONSE_TIMEOUT_SEC * 1000);
  }

  // Drop every pending correlation for a connector (cancel, failure, timeout).
  private forget(connectorId: number) {
    this.pendingAuthorize = this.pendingAuthorize.filter((c) => c !== connectorId);
    for (const [id, call] of this.calls) if (call.connectorId === connectorId) this.calls.delete(id);
  }

  private emitSession(s: Session) {
    this.emit("session", this.view(s));
  }

  state(): SessionView[] {
    const c = this.cfg();
    for (let i = 1; i <= c.connectors; i++) this.get(i); // ensure idle sessions exist
    return Array.from(this.sessions.values())
      .sort((a, b) => a.connectorId - b.connectorId)
      .map((s) => this.view(s));
  }

  // biome-ignore lint/suspicious/noExplicitAny: ocpp payload
  private async send(action: string, payload: any): Promise<boolean> {
    try {
      const res = await fetch(`http://localhost:${this.cfg().adminPort}/execute`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, payload }),
        signal: AbortSignal.timeout(2500),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  private async status(connectorId: number, status: string): Promise<boolean> {
    const own = status === "Available";
    if (own) this.ownAvailable.set(connectorId, (this.ownAvailable.get(connectorId) ?? 0) + 1);
    const ok = await this.send("StatusNotification", { connectorId, errorCode: "NoError", status, timestamp: this.nowIso() });
    if (own && !ok) this.consumeOwnAvailable(connectorId); // never logged → no echo to skip
    return ok;
  }

  private consumeOwnAvailable(connectorId: number): boolean {
    const n = this.ownAvailable.get(connectorId) ?? 0;
    if (n === 0) return false;
    this.ownAvailable.set(connectorId, n - 1);
    return true;
  }

  private async smartLimitKw(connectorId: number, voltage: number, phases: number): Promise<number | null> {
    try {
      const res = await fetch(`http://localhost:${this.cfg().adminPort}/chargingprofile`, {
        signal: AbortSignal.timeout(1500),
      });
      const profiles = (await res.json()) as Array<{ connectorId: number; limit: number; unit: string }>;
      const p = profiles.find((x) => x.connectorId === connectorId) ?? profiles.find((x) => x.connectorId === 0);
      if (!p) return null;
      return p.unit === "A" ? (p.limit * voltage * phases) / 1000 : p.limit / 1000;
    } catch {
      return null;
    }
  }

  private nowIso() {
    return new Date().toISOString();
  }

  // ---- step 1: Authorize ----
  async authorize(connectorId: number, idTag: string): Promise<Result> {
    const s = this.get(connectorId);
    if (s.state !== "idle" && s.state !== "ready") return { ok: false, reason: `connecteur ${connectorId} occupé (${s.state})` };
    if (!idTag) return { ok: false, reason: "idTag manquant" };
    this.forget(connectorId); // a late answer to a previous request must not land on this one
    const wasIdle = s.state === "idle";
    if (wasIdle) Object.assign(s, this.blank(connectorId));
    Object.assign(s, { idTag, authStatus: "pending", state: "authorizing" });
    this.emitSession(s);

    // On a real station the cable is plugged first: the connector is Preparing while it authorizes.
    if (wasIdle && !(await this.status(connectorId, "Preparing"))) {
      Object.assign(s, this.blank(connectorId));
      this.emitSession(s);
      return { ok: false, reason: "VCP injoignable" };
    }
    this.pendingAuthorize.push(connectorId); // before sending: the log line can beat the HTTP reply
    if (!(await this.send("Authorize", { idTag }))) {
      this.forget(connectorId);
      Object.assign(s, this.blank(connectorId));
      this.emitSession(s);
      return { ok: false, reason: "Authorize injoignable" };
    }
    this.armWatchdog(connectorId, "authorizing", (cur) => {
      // The call stays tracked: a late answer still lands (onAuthorizeResult accepts "ready").
      Object.assign(cur, { state: "ready", authStatus: "NoResponse" });
      this.emitSession(cur);
      this.emit("notice", { kind: "error", message: `EVSE ${connectorId} : Authorize sans réponse` });
    });
    return { ok: true };
  }

  // ---- step 2: StartTransaction (needs an accepted Authorize unless forced) ----
  async startTransaction(connectorId: number, opts: { idTag?: string; force?: boolean } = {}): Promise<Result> {
    const s = this.get(connectorId);
    if (s.state !== "idle" && s.state !== "ready") return { ok: false, reason: `connecteur ${connectorId} occupé (${s.state})` };
    const accepted = s.state === "ready" && s.authStatus === "Accepted";
    if (!accepted && !opts.force) return { ok: false, reason: "Authorize non accepté — utilise « forcer le Start »" };
    const idTag = s.state === "ready" && s.idTag ? s.idTag : opts.idTag;
    if (!idTag) return { ok: false, reason: "idTag manquant" };

    this.forget(connectorId); // a late answer to a previous request must not land on this one
    const fromIdle = s.state === "idle";
    if (fromIdle) {
      Object.assign(s, this.blank(connectorId), { idTag });
      if (!(await this.status(connectorId, "Preparing"))) return { ok: false, reason: "VCP injoignable" };
    }
    s.state = "starting";
    s.startedAt = Date.now();
    this.emitSession(s);
    if (!(await this.send("StartTransaction", { connectorId, idTag, meterStart: Math.round(s.energyWh), timestamp: this.nowIso() }))) {
      this.forget(connectorId);
      if (fromIdle) Object.assign(s, this.blank(connectorId));
      else s.state = "ready";
      this.emitSession(s);
      return { ok: false, reason: "StartTransaction injoignable" };
    }
    this.armWatchdog(connectorId, "starting", (cur) => {
      // The call stays tracked: a late answer still lands (onStartResult accepts "ready").
      cur.state = "ready";
      this.emitSession(cur);
      this.emit("notice", { kind: "error", message: `EVSE ${connectorId} : StartTransaction sans réponse` });
    });
    return { ok: true };
  }

  // One-click charge that really waits for each CSMS answer:
  // Authorize → Accepted → StartTransaction → transactionId. Stops at the first failure.
  async runFull(connectorId: number, idTag: string): Promise<Result> {
    const auth = await this.authorize(connectorId, idTag);
    if (!auth.ok) return auth;
    const afterAuth = await this.waitFor(connectorId, (v) => v.state !== "authorizing");
    if (afterAuth.state === "idle") return { ok: false, reason: "annulée" };
    if (afterAuth.authStatus !== "Accepted") {
      // One-click charge: don't leave the connector Preparing after a failed step → back to Available.
      await this.stop(connectorId);
      const why = afterAuth.authStatus === "NoResponse" ? "sans réponse" : `refusé (${afterAuth.authStatus})`;
      return { ok: false, reason: `Authorize ${why}` };
    }
    const start = await this.startTransaction(connectorId);
    if (!start.ok) {
      await this.stop(connectorId);
      return start;
    }
    const afterStart = await this.waitFor(connectorId, (v) => v.state !== "starting");
    if (afterStart.state === "charging") return { ok: true };
    await this.stop(connectorId); // unanswered Start left it "ready"; a refused one is already idle (no-op)
    return { ok: false, reason: "StartTransaction refusé ou sans réponse" };
  }

  // Resolves once the connector's session satisfies `done`. Every waiting state has a watchdog,
  // so this always settles.
  private waitFor(connectorId: number, done: (v: SessionView) => boolean): Promise<SessionView> {
    return new Promise((resolve) => {
      const current = this.view(this.get(connectorId));
      if (done(current)) {
        resolve(current);
        return;
      }
      const onSession = (v: SessionView) => {
        if (v.connectorId !== connectorId || !done(v)) return;
        this.off("session", onSession);
        resolve(v);
      };
      this.on("session", onSession);
    });
  }

  // Every OCPP frame seen in the VCP log. Outgoing CALLs register their messageId; the matching
  // CALLRESULT / CALLERROR then drives the step it answers.
  onOcppEvent(ev: OcppEvent) {
    if (ev.direction === "out" && ev.messageType === 2) {
      if (ev.action === "Authorize") {
        const connectorId = this.pendingAuthorize.shift();
        if (connectorId != null) this.track(ev.messageId, "Authorize", connectorId);
      } else if (ev.action === "StartTransaction") {
        const connectorId = Number((ev.payload as { connectorId?: number })?.connectorId);
        if (this.sessions.get(connectorId)?.state === "starting") this.track(ev.messageId, "StartTransaction", connectorId);
      } else if (ev.action === "StatusNotification") {
        // A manual "Available" (Actions tab) on a connector that hasn't started charging abandons the
        // handshake, so the screen shows the real connector status instead of a stale PREPARING.
        // A running transaction is left alone.
        const p = ev.payload as { connectorId?: number; status?: string };
        if (p?.status === "Available" && this.consumeOwnAvailable(Number(p.connectorId))) return; // our own echo
        const s = this.sessions.get(Number(p?.connectorId));
        if (p?.status === "Available" && s && (s.state === "authorizing" || s.state === "ready" || s.state === "starting")) {
          this.clearTimers(s);
          this.forget(s.connectorId);
          Object.assign(s, this.blank(s.connectorId));
          this.emitSession(s);
        }
      }
      return;
    }
    if (ev.direction !== "in" || (ev.messageType !== 3 && ev.messageType !== 4)) return;
    const call = this.calls.get(ev.messageId);
    if (!call) return;
    this.calls.delete(ev.messageId);
    const payload = ev.payload as { idTagInfo?: { status?: string }; transactionId?: number } | undefined;
    // A CALLERROR carries no idTagInfo: the step failed.
    const status = ev.messageType === 3 ? (payload?.idTagInfo?.status ?? "Error") : "Error";
    if (call.action === "Authorize") this.onAuthorizeResult(call.connectorId, status);
    else this.onStartResult(call.connectorId, status, payload?.transactionId);
  }

  private track(messageId: string, action: "Authorize" | "StartTransaction", connectorId: number) {
    this.calls.set(messageId, { action, connectorId });
    if (this.calls.size > TRACKED_CALLS_CAP) this.calls.delete(this.calls.keys().next().value as string);
  }

  private onAuthorizeResult(connectorId: number, status: string) {
    const s = this.sessions.get(connectorId);
    // "ready" here = this request timed out but is still tracked (not cancelled/replaced): apply
    // the late answer so a slow CSMS isn't reported as silent.
    if (!s || (s.state !== "authorizing" && s.state !== "ready")) return;
    const late = s.state === "ready";
    this.clearTimers(s);
    Object.assign(s, { state: "ready", authStatus: status });
    this.emitSession(s);
    const ok = status === "Accepted";
    this.emit("notice", {
      kind: ok ? "info" : "error",
      message: `EVSE ${connectorId} : Authorize ${ok ? "accepté" : `refusé (${status})`}${late ? " (réponse tardive)" : ""}`,
    });
  }

  private onStartResult(connectorId: number, status: string, transactionId: number | undefined) {
    const s = this.sessions.get(connectorId);
    // "ready" here = the Start timed out but is still tracked: a late answer still applies.
    if (!s || (s.state !== "starting" && s.state !== "ready")) return;
    this.clearTimers(s);
    if (status !== "Accepted") {
      Object.assign(s, this.blank(connectorId));
      this.emitSession(s);
      this.emit("notice", { kind: "error", message: `EVSE ${connectorId} : StartTransaction refusé (${status})` });
      this.status(connectorId, "Available");
      return;
    }
    s.transactionId = Number(transactionId);
    s.state = "charging";
    this.emitSession(s);
    this.status(connectorId, "Charging");
    if (s.autoMeter) this.beginTicking(connectorId);
  }

  // ---- MeterValues ----
  setAutoMeter(connectorId: number, on: boolean): Result {
    this.autoMeterPref.set(connectorId, on);
    const s = this.get(connectorId);
    s.autoMeter = on;
    if (s.state === "charging") {
      if (on) this.beginTicking(connectorId);
      else this.stopTicking(s);
    }
    this.emitSession(s);
    return { ok: true };
  }

  // Manual MeterValues: the rows composed in the UI, sent as one meterValue sample. Energy, power
  // and SoC rows also update the local session so the curve, receipt and meterStop stay consistent.
  async sendMeterValues(
    connectorId: number,
    input: { transactionId?: number | null; sampledValue: SampledValue[] },
  ): Promise<Result> {
    const sampledValue = (input.sampledValue ?? [])
      .filter((r) => r && String(r.value ?? "").trim() !== "")
      .map((r) => {
        const out: Record<string, string> = { value: String(r.value).trim() };
        for (const k of ["measurand", "unit", "phase", "context", "location", "format"] as const) {
          if (r[k]) out[k] = String(r[k]);
        }
        return out;
      });
    if (sampledValue.length === 0) return { ok: false, reason: "aucune valeur à envoyer" };
    const s = this.get(connectorId);
    const transactionId = input.transactionId ?? s.transactionId;
    const ok = await this.send("MeterValues", {
      connectorId,
      transactionId: transactionId ?? undefined,
      meterValue: [{ timestamp: this.nowIso(), sampledValue }],
    });
    if (!ok) return { ok: false, reason: "refusé par la borne (payload invalide ?) ou borne injoignable" };
    this.applyManualSample(s, sampledValue);
    return { ok: true };
  }

  private applyManualSample(s: Session, rows: Array<Record<string, string>>) {
    for (const r of rows) {
      const v = Number.parseFloat(r.value);
      if (!Number.isFinite(v)) continue;
      const measurand = r.measurand ?? "Energy.Active.Import.Register"; // OCPP default measurand
      if (measurand === "Energy.Active.Import.Register") {
        s.energyWh = r.unit === "kWh" ? v * 1000 : v;
        s.energyKwh = s.energyWh / 1000;
      } else if (measurand === "Power.Active.Import" && !r.phase) {
        s.powerKw = r.unit === "kW" ? v : v / 1000;
        s.peakKw = Math.max(s.peakKw, s.powerKw);
        s.samples.push(Number(s.powerKw.toFixed(2)));
        if (s.samples.length > SAMPLE_CAP) s.samples.shift();
      } else if (measurand === "SoC") {
        s.soc = Math.min(100, Math.max(0, v));
      }
    }
    this.emitSession(s);
  }

  private beginTicking(connectorId: number) {
    const s = this.get(connectorId);
    this.stopTicking(s);
    s.timer = setInterval(() => this.tick(connectorId).catch(() => {}), TICK_SEC * 1000);
    this.tick(connectorId).catch(() => {}); // immediate first sample
  }

  private async tick(connectorId: number) {
    const s = this.sessions.get(connectorId);
    if (!s || s.state !== "charging") return;
    const c = this.cfg();

    // advance SoC on a demo timescale, derive power from live V/A + curve + smart-charging clamp
    s.soc = Math.min(100, s.soc + (TICK_SEC / c.sessionFullSeconds) * 100);
    const targetKw = (s.phases * s.voltage * s.current) / 1000;
    const curveKw = targetKw * curveFactor(s.soc);
    const limitKw = await this.smartLimitKw(connectorId, s.voltage, s.phases);
    let powerKw = curveKw;
    s.cappedBy = curveFactor(s.soc) < 1 ? "soc" : "none";
    if (limitKw != null && limitKw < powerKw) {
      powerKw = limitKw;
      s.cappedBy = "smart";
    }
    s.powerKw = Math.max(0, powerKw);
    s.energyWh += s.powerKw * 1000 * (TICK_SEC / 3600);
    s.energyKwh = s.energyWh / 1000;
    s.peakKw = Math.max(s.peakKw, s.powerKw);
    s.sumKw += s.powerKw;
    s.ticks += 1;
    s.samples.push(Number(s.powerKw.toFixed(2)));
    if (s.samples.length > SAMPLE_CAP) s.samples.shift();

    const ampPerPhase = (s.current * curveFactor(s.soc)).toFixed(1);
    await this.send("MeterValues", {
      connectorId,
      transactionId: s.transactionId ?? undefined,
      meterValue: [{
        timestamp: this.nowIso(),
        sampledValue: [
          { value: String(Math.round(s.energyWh)), measurand: "Energy.Active.Import.Register", unit: "Wh" },
          { value: String(Math.round(s.powerKw * 1000)), measurand: "Power.Active.Import", unit: "W" },
          { value: ampPerPhase, measurand: "Current.Import", unit: "A", phase: "L1" },
          { value: ampPerPhase, measurand: "Current.Import", unit: "A", phase: "L2" },
          { value: ampPerPhase, measurand: "Current.Import", unit: "A", phase: "L3" },
          { value: String(Math.round(s.voltage)), measurand: "Voltage", unit: "V" },
          { value: String(Math.round(s.soc)), measurand: "SoC", unit: "Percent" },
        ],
      }],
    });
    this.emitSession(s);

    if (s.soc >= 100) await this.stop(connectorId); // auto-stop at full
  }

  // ---- step 3: Stop ----
  // Stop a connector from ANY active state: a real charge (charging/finishing) is closed with a
  // StopTransaction + receipt; an unfinished handshake (authorizing/ready/starting) is cancelled.
  // Always reachable so a connector can never stay stuck.
  // `silent`: the VCP already emitted StopTransaction + StatusNotification (remote stop from the
  // CSMS), so close the local session and produce a receipt WITHOUT re-sending any OCPP message.
  async stop(connectorId: number, opts: { silent?: boolean } = {}): Promise<Result> {
    const s = this.sessions.get(connectorId);
    if (!s || s.state === "idle") return { ok: false, reason: "aucune charge en cours" };
    const hadTransaction = s.state === "charging" || s.state === "finishing";
    this.clearTimers(s);
    this.forget(connectorId);
    s.state = "finishing";
    this.emitSession(s);

    let receipt: Receipt | null = null;
    if (hadTransaction) {
      if (!opts.silent) {
        await this.send("StopTransaction", {
          transactionId: s.transactionId ?? 0, idTag: s.idTag ?? undefined,
          meterStop: Math.round(s.energyWh), timestamp: this.nowIso(),
        });
      }
      receipt = {
        connectorId,
        transactionId: s.transactionId,
        durationSec: s.startedAt ? Math.round((Date.now() - s.startedAt) / 1000) : 0,
        energyKwh: Number(s.energyKwh.toFixed(3)),
        avgKw: s.ticks ? Number((s.sumKw / s.ticks).toFixed(2)) : 0,
        peakKw: Number(s.peakKw.toFixed(2)),
        ts: this.nowIso(),
      };
      if (!opts.silent) await this.status(connectorId, "Finishing");
    }
    if (!opts.silent) await this.status(connectorId, "Available");

    Object.assign(s, this.blank(connectorId));
    this.emitSession(s);
    if (receipt) this.emit("receipt", receipt);
    return { ok: true };
  }

  // A CSMS RemoteStopTransaction (v16) / RequestStopTransaction (v201) reached the VCP, which
  // closes the transaction on its side. Stop the matching local session SILENTLY so the tick loop
  // halts and a receipt is produced — without re-emitting StopTransaction (the VCP already did).
  async remoteStopped(transactionId: string | number | null | undefined): Promise<{ ok: boolean }> {
    const active = Array.from(this.sessions.values()).filter(
      (s) => s.state === "charging" || s.state === "finishing",
    );
    if (active.length === 0) return { ok: false };
    let target =
      transactionId != null
        ? active.find((s) => s.transactionId != null && String(s.transactionId) === String(transactionId))
        : undefined;
    // Fallback: a single active charge is unambiguously the one being stopped.
    if (!target && active.length === 1) target = active[0];
    if (!target) return { ok: false };
    return this.stop(target.connectorId, { silent: true });
  }

  // Stop every connector that is in any active state — the "Stop" safety net so the
  // button always halts the running charge even if the UI's selected connector drifted.
  async stopActive(): Promise<{ ok: boolean; stopped: number[] }> {
    const active = Array.from(this.sessions.values())
      .filter((s) => s.state !== "idle")
      .map((s) => s.connectorId);
    for (const c of active) await this.stop(c);
    return { ok: active.length > 0, stopped: active };
  }

  stopAll() {
    for (const s of this.sessions.values()) this.clearTimers(s);
  }
}
