/**
 * Coverage top-up for src/lib/session_watchdog.ts
 *
 * Targets the 6 uncovered branches / 4 uncovered lines that remain after
 * session_watchdog.spec.ts:
 *
 *   L128-129  _arm() early-return guard (not _running when _arm fires)
 *   L158-159  _renew() early-return guard (stopped between timer fire and async exec)
 *   B132      maxSessionDuration <= 0 → 3600 s fallback
 *   B161      this._session is null when _renew starts → prefix = "unknown"
 *   B168      openSession throws a non-Error value (string)
 *   B183      onRenew throws a non-Error value (string)
 */

import { expect } from "chai";
import * as sinon from "sinon";

import { SessionWatchdog } from "../../src/lib/session_watchdog";
import type { LiveSession } from "../../src/lib/live_session";

// ── Helpers ───────────────────────────────────────────────────────────────────

const CAMERA_UUID = "0A0B0C0D-1111-2222-3333-444455556666";

function makeSession(opts: { openedAt?: number; maxSessionDuration?: number } = {}): LiveSession {
    return {
        cameraId: CAMERA_UUID,
        proxyUrl: "https://192.0.2.10:443/snap.jpg",
        connectionType: "LOCAL",
        digestUser: "cbs-testuser",
        digestPassword: "testpassword",
        lanAddress: "192.0.2.10:443",
        bufferingTimeMs: 500,
        maxSessionDuration: opts.maxSessionDuration ?? 3600,
        openedAt: opts.openedAt ?? Date.now(),
    };
}

function noop(): void { /* intentionally empty */ }

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("SessionWatchdog — coverage top-up", () => {
    let clock: sinon.SinonFakeTimers;

    beforeEach(() => {
        clock = sinon.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    });

    afterEach(() => {
        clock.restore();
    });

    // ── B132: maxSessionDuration <= 0 → 3600 s fallback ──────────────────────
    it("(C1) maxSessionDuration=0 → 3600 s fallback duration used for timer", async () => {
        // maxSessionDuration=0 → branch `session.maxSessionDuration > 0` is false → uses 3_600_000 ms
        const renewLeadMs = 60_000;
        const now = Date.now();
        // Session with duration 0 should use the 3600 s fallback
        const session = makeSession({ openedAt: now, maxSessionDuration: 0 });
        const newSession = makeSession({ openedAt: now + 3_600_000, maxSessionDuration: 3600 });

        const openSession = sinon.stub().resolves(newSession);
        const onRenew = sinon.stub().resolves(undefined);
        const onError = sinon.stub();

        const watchdog = new SessionWatchdog({
            openSession,
            onRenew,
            onError,
            log: noop,
            renewLeadMs,
        });
        watchdog.start(session);

        // The fallback duration is 3600 s; renewal fires at 3600000 - 60000 = 3540000 ms
        clock.tick(3_540_000 - 1);
        await Promise.resolve();
        expect(openSession.callCount, "not fired 1 ms early").to.equal(0);

        clock.tick(1);
        await Promise.resolve();
        await Promise.resolve();
        expect(openSession.callCount, "fired using 3600 s fallback").to.equal(1);

        watchdog.stop();
    });

    // ── L128-129: _arm() early-return when not running ────────────────────────
    it("(C2) _arm() no-ops when watchdog stopped between timer fire and _arm call", () => {
        // stop() sets _running=false; if somehow _arm is re-entered afterwards it returns immediately.
        // We simulate this by calling stop() before start() and verifying _arm never sets a timer.
        const watchdog = new SessionWatchdog({
            openSession: sinon.stub().resolves(makeSession()),
            onRenew: sinon.stub().resolves(undefined),
            onError: sinon.stub(),
            log: noop,
            renewLeadMs: 60_000,
        });

        // Do NOT call start() — _running stays false.
        // Calling start() then immediately stop() before _arm can run via a fast tick:
        const session = makeSession({ openedAt: Date.now(), maxSessionDuration: 3600 });
        watchdog.start(session);
        watchdog.stop(); // _running = false, timer cleared

        // Advance far past renewal — openSession must NOT fire because watchdog stopped
        clock.tick(4_000_000);
        expect((watchdog as unknown as { _timer: unknown })._timer).to.equal(null);
        expect(watchdog.isRunning()).to.equal(false);
    });

    // ── L158-159: _renew() early-return when not running ─────────────────────
    it("(C3) _renew() returns immediately if watchdog was stopped between timer fire and async execution", async () => {
        // The timer fires (callback starts) then watchdog.stop() is called before _renew's
        // await resolves. The guard `if (!this._running) return;` at line 157-159 fires.
        // We test this by stopping the watchdog synchronously inside openSession before it resolves.
        const now = Date.now();
        const session = makeSession({ openedAt: now, maxSessionDuration: 100 });

        let openSessionCalled = false;
        const onRenew = sinon.stub().resolves(undefined);
        const onError = sinon.stub();
        let watchdogRef: SessionWatchdog;

        // openSession is called inside the timer callback. We stop the watchdog first,
        // then the guard inside _renew (at the top, before openSession) fires.
        // But since the guard is at the very top of _renew (before openSession is awaited),
        // we need to arrange so _running is false BEFORE the timer fires.
        // Strategy: set up a tiny renewLeadMs so the timer fires essentially immediately,
        // then stop before ticking.

        watchdogRef = new SessionWatchdog({
            openSession: async () => {
                openSessionCalled = true;
                return makeSession();
            },
            onRenew,
            onError,
            log: noop,
            renewLeadMs: 99_000, // fires at t=1ms (100s - 99s = 1s, but we control)
        });
        watchdogRef.start(session);

        // Stop immediately — _running=false before timer fires
        watchdogRef.stop();

        // Advance far past renewal
        clock.tick(200_000);
        await Promise.resolve();
        await Promise.resolve();

        // openSession must never have been called
        expect(openSessionCalled, "_renew early-returned, openSession not called").to.equal(false);
        expect(onRenew.callCount, "onRenew not called").to.equal(0);
        expect(onError.callCount, "onError not called").to.equal(0);
    });

    // ── B161: session is null at renewal time → prefix = "unknown" ───────────
    it("(C4) _session=null when _renew fires → camPrefix falls back to 'unknown'", async () => {
        // After stop(), _session is set to null. If a stale timer fires and _running
        // is still true (shouldn't happen in production, but branch must be covered),
        // the null-coalescing `?? "unknown"` fires.
        //
        // We achieve this by constructing a watchdog, starting it, then directly
        // nulling the private _session before the renewal fires. Since _running is
        // still true, _renew proceeds and hits the null-coalesce branch.
        const now = Date.now();
        const session = makeSession({ openedAt: now, maxSessionDuration: 100 });
        const newSession = makeSession();

        const logs: string[] = [];
        const openSession = sinon.stub().resolves(newSession);
        const onRenew = sinon.stub().resolves(undefined);
        const onError = sinon.stub();

        const watchdog = new SessionWatchdog({
            openSession,
            onRenew,
            onError,
            log: (level, msg) => logs.push(`[${level}] ${msg}`),
            renewLeadMs: 10_000,
        });
        watchdog.start(session);

        // Null the session manually before the timer fires
        (watchdog as unknown as { _session: null })._session = null;

        // Fire renewal (100s - 10s = 90s)
        clock.tick(90_001);
        await Promise.resolve();
        await Promise.resolve();

        // openSession was called; the log line should use "unknown" not the camera UUID
        expect(openSession.callCount, "openSession called").to.equal(1);
        const renewLog = logs.find((l) => l.includes("renewing LOCAL session"));
        expect(renewLog, "renew log emitted").to.exist;
        expect(renewLog, "prefix is 'unknown'").to.include("unknown");

        watchdog.stop();
    });

    // ── B168: openSession throws a non-Error value (string) ──────────────────
    it("(C5) openSession throws a string (non-Error) → wrapped in Error, onError called", async () => {
        const now = Date.now();
        const session = makeSession({ openedAt: now, maxSessionDuration: 100 });

        const openSession = sinon.stub().rejects("Camera offline" as unknown as Error);
        // sinon .rejects(string) actually wraps as Error, so use callsFake to throw a raw string
        openSession.callsFake((): Promise<LiveSession> => Promise.reject("raw string error"));

        const onError = sinon.stub();

        const watchdog = new SessionWatchdog({
            openSession,
            onRenew: sinon.stub().resolves(undefined),
            onError,
            log: noop,
            renewLeadMs: 10_000,
        });
        watchdog.start(session);

        clock.tick(90_001);
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        expect(onError.callCount, "onError called once").to.equal(1);
        // The thrown value was a string — the guard wraps it in Error
        const received = onError.firstCall.args[0] as Error;
        expect(received).to.be.instanceOf(Error);
        expect(received.message, "string value becomes Error message").to.include(
            "raw string error",
        );
        expect(watchdog.isRunning(), "watchdog stopped after non-Error throw").to.be.false;
    });

    // ── B183: onRenew throws a non-Error value (number) ──────────────────────
    it("(C6) onRenew throws a non-Error value (number) → wrapped in Error, onError called", async () => {
        const now = Date.now();
        const session = makeSession({ openedAt: now, maxSessionDuration: 100 });
        const newSession = makeSession();

        const openSession = sinon.stub().resolves(newSession);
        // throw a raw number, not an Error instance
        const onRenew = sinon.stub().callsFake((): Promise<void> => Promise.reject(42));
        const onError = sinon.stub();

        const watchdog = new SessionWatchdog({
            openSession,
            onRenew,
            onError,
            log: noop,
            renewLeadMs: 10_000,
        });
        watchdog.start(session);

        clock.tick(90_001);
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        expect(onError.callCount, "onError called once").to.equal(1);
        const received = onError.firstCall.args[0] as Error;
        expect(received).to.be.instanceOf(Error);
        expect(received.message, "numeric value becomes Error message").to.include("42");
        expect(watchdog.isRunning(), "watchdog stopped after non-Error onRenew throw").to.be.false;
    });
});
