/**
 * Unit tests for the periodic CBS re-registration added in v1.7.4.
 *
 * BUG (issue #36, Fix B): _registerWithCbs was only called at initial start()
 * and on FCM reconnect. If Bosch dropped the server-side device registration
 * (TTL / FW upgrade / re-pair) while the MTalk socket stayed healthy, pushes
 * silently stopped. FIX: a setInterval fires every CBS_REREGISTER_INTERVAL_MS
 * (24 h) to keep the CBS registration fresh while the listener is running.
 *
 * Tests use fake IDs only:
 *   cloud-ID: 11111111-2222-3333-4444-555566667777
 *   MAC: aa:bb:cc:dd:ee:ff
 *
 * Framework: Mocha + Chai + Sinon
 */

import { expect } from "chai";
import axios from "axios";
import sinon from "sinon";
import type { ECDH } from "crypto";

import {
    FcmListener,
    CBS_REREGISTER_INTERVAL_MS,
    type FcmDeps,
} from "../../src/lib/fcm";

import { stubAxiosSequence, restoreAxios } from "./helpers/axios-mock";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeFakeEcdh(
    privateKey = Buffer.alloc(32, 0xab),
    publicKey = Buffer.alloc(65, 0x04),
) {
    return {
        getPublicKey: () => publicKey,
        getPrivateKey: () => privateKey,
        setPrivateKey: sinon.stub(),
    } as unknown as ECDH;
}

function makeFakeReg() {
    return {
        acg: { id: BigInt("11111111222233334444"), securityToken: BigInt("5555666677778888") },
        token: "fake-fcm-token-reregister-test",
    };
}

function makeFakeClient(connectResult: Error | undefined = undefined) {
    const handlers: Record<string, Array<(...args: unknown[]) => void>> = {};
    const client = {
        connect: sinon.stub().resolves(connectResult),
        disconnect: sinon.stub().resolves(undefined),
        on: (event: string, cb: (...args: unknown[]) => void) => {
            (handlers[event] ??= []).push(cb);
        },
        _emit: (event: string, ...args: unknown[]) => {
            for (const cb of handlers[event] ?? []) cb(...args);
        },
    };
    return client;
}

function makeDeps(
    overrides: Partial<{
        registerResult: ReturnType<typeof makeFakeReg> | Error;
        fakeClient: ReturnType<typeof makeFakeClient>;
    }> = {},
): { deps: FcmDeps; fakeClient: ReturnType<typeof makeFakeClient> } {
    const fakeClient = overrides.fakeClient ?? makeFakeClient();
    const registerResult = overrides.registerResult ?? makeFakeReg();

    const deps: FcmDeps = {
        registerToFCM: sinon.stub().resolves(registerResult) as unknown as FcmDeps["registerToFCM"],
        createFcmECDH: sinon.stub().returns(makeFakeEcdh()) as unknown as FcmDeps["createFcmECDH"],
        generateFcmAuthSecret: sinon
            .stub()
            .returns(Buffer.alloc(16, 0x11)) as unknown as FcmDeps["generateFcmAuthSecret"],
        FcmClient: sinon.stub().returns(fakeClient) as unknown as FcmDeps["FcmClient"],
    };
    return { deps, fakeClient };
}

function makeListener(
    bearerToken = "test-bearer-token",
    options?: ConstructorParameters<typeof FcmListener>[2],
    deps?: Partial<FcmDeps>,
): FcmListener {
    return new FcmListener(axios.create(), bearerToken, options, deps);
}

// ── CBS_REREGISTER_INTERVAL_MS constant ──────────────────────────────────────

describe("CBS_REREGISTER_INTERVAL_MS constant", () => {
    it("equals 24 hours in milliseconds", () => {
        expect(CBS_REREGISTER_INTERVAL_MS).to.equal(24 * 60 * 60 * 1000);
    });
});

// ── Periodic re-registration — interval fires _registerWithCbs ───────────────

describe("FcmListener — periodic CBS re-registration (Fix B, issue #36)", () => {
    let clock: sinon.SinonFakeTimers;

    beforeEach(() => {
        clock = sinon.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    });

    afterEach(() => {
        clock.restore();
        restoreAxios();
    });

    it("calls _registerWithCbs again after one interval tick while running", async () => {
        const { deps } = makeDeps();
        // First call: initial start() CBS registration (HTTP 204)
        // Second call: periodic re-registration (HTTP 204)
        stubAxiosSequence([
            { status: 204, data: "" },
            { status: 204, data: "" },
        ]);

        const listener = makeListener("tok", { mode: "android" }, deps);
        const registerSpy = sinon.spy(listener, "_registerWithCbs");

        await listener.start();
        expect(registerSpy.callCount).to.equal(1); // called once at start

        // Advance fake time by exactly one re-register interval
        await clock.tickAsync(CBS_REREGISTER_INTERVAL_MS);

        expect(registerSpy.callCount).to.equal(2); // called again by interval
        registerSpy.restore();

        await listener.stop();
    });

    it("calls _registerWithCbs multiple times over multiple intervals", async () => {
        const { deps } = makeDeps();
        stubAxiosSequence([
            { status: 204, data: "" }, // start
            { status: 204, data: "" }, // 1st re-register
            { status: 204, data: "" }, // 2nd re-register
        ]);

        const listener = makeListener("tok", { mode: "android" }, deps);
        const registerSpy = sinon.spy(listener, "_registerWithCbs");

        await listener.start();

        await clock.tickAsync(CBS_REREGISTER_INTERVAL_MS * 2 + 1000);

        expect(registerSpy.callCount).to.be.at.least(3); // start + 2 intervals
        registerSpy.restore();

        await listener.stop();
    });

    it("interval is cleared on stop() — no further calls after stop", async () => {
        const { deps } = makeDeps();
        stubAxiosSequence([
            { status: 204, data: "" }, // start
        ]);

        const listener = makeListener("tok", { mode: "android" }, deps);
        const registerSpy = sinon.spy(listener, "_registerWithCbs");

        await listener.start();
        expect(registerSpy.callCount).to.equal(1);

        await listener.stop();

        // Advance well past one interval — should NOT call again
        await clock.tickAsync(CBS_REREGISTER_INTERVAL_MS * 2);

        expect(registerSpy.callCount).to.equal(1); // no extra calls after stop
        registerSpy.restore();
    });

    it("interval callback is a no-op when _running is false (defensive guard)", async () => {
        const { deps } = makeDeps();
        stubAxiosSequence([
            { status: 204, data: "" }, // start
        ]);

        const listener = makeListener("tok", { mode: "android" }, deps);
        const registerSpy = sinon.spy(listener, "_registerWithCbs");

        await listener.start();

        // Forcibly set _running to false WITHOUT calling stop() (simulates
        // an unexpected state where the interval fires while the listener has
        // been torn down but the timer wasn't cleared yet)
        (listener as unknown as { _running: boolean })._running = false;

        await clock.tickAsync(CBS_REREGISTER_INTERVAL_MS);

        // Still only 1 call (from start) — the guard prevented the re-register
        expect(registerSpy.callCount).to.equal(1);
        registerSpy.restore();

        // Clean up: manually clear the timer (since we bypassed stop())
        (listener as unknown as { _reregisterTimer: ReturnType<typeof setInterval> | null })
            ._reregisterTimer !== null &&
            clearInterval(
                (listener as unknown as { _reregisterTimer: ReturnType<typeof setInterval> })
                    ._reregisterTimer,
            );
    });

    it("interval callback is a no-op when _fcmToken is null (defensive guard)", async () => {
        const { deps } = makeDeps();
        stubAxiosSequence([
            { status: 204, data: "" }, // start
        ]);

        const listener = makeListener("tok", { mode: "android" }, deps);
        const registerSpy = sinon.spy(listener, "_registerWithCbs");

        await listener.start();

        // Simulate FCM token being cleared mid-flight (e.g. stop() cleared it
        // but the timer fired just before clearInterval was called)
        (listener as unknown as { _fcmToken: string | null })._fcmToken = null;

        await clock.tickAsync(CBS_REREGISTER_INTERVAL_MS);

        expect(registerSpy.callCount).to.equal(1); // no extra call
        registerSpy.restore();

        await listener.stop();
    });

    it("interval error is caught and emitted as 'error-logged', does not crash the listener", async () => {
        const { deps } = makeDeps();
        stubAxiosSequence([
            { status: 204, data: "" }, // start
        ]);

        const listener = makeListener("tok", { mode: "android" }, deps);

        // Stub _registerWithCbs to succeed on start, fail on re-register
        const registerStub = sinon
            .stub(listener, "_registerWithCbs")
            .onFirstCall()
            .resolves()
            .onSecondCall()
            .rejects(new Error("CBS /v11/devices HTTP 503: Service Unavailable"));

        const errorLoggedSpy = sinon.spy();
        listener.on("error-logged", errorLoggedSpy);

        await listener.start();

        await clock.tickAsync(CBS_REREGISTER_INTERVAL_MS);

        // Listener must still be healthy
        expect(listener.isHealthy()).to.be.true;
        // Error must have been emitted on 'error-logged', not propagated
        expect(errorLoggedSpy.calledOnce).to.be.true;
        const msg = errorLoggedSpy.firstCall.args[0] as string;
        expect(msg).to.include("CBS periodic re-register failed");
        expect(msg).to.include("503");

        registerStub.restore();
        await listener.stop();
    });

    it("no duplicate timer on repeated stop+start cycles", async () => {
        const { deps } = makeDeps();
        stubAxiosSequence([
            { status: 204, data: "" }, // 1st start
            { status: 204, data: "" }, // 2nd start
            { status: 204, data: "" }, // 1st interval from 2nd start
        ]);

        const listener = makeListener("tok", { mode: "android" }, deps);
        const registerSpy = sinon.spy(listener, "_registerWithCbs");

        await listener.start();
        await listener.stop();
        await listener.start(); // second start — must create exactly one new timer

        await clock.tickAsync(CBS_REREGISTER_INTERVAL_MS);

        // Calls: 2 from start() calls + 1 interval tick = 3
        expect(registerSpy.callCount).to.equal(3);
        registerSpy.restore();

        await listener.stop();
    });
});
