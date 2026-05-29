/**
 * Coverage supplement for src/lib/fcm.ts
 *
 * FILE_PARTITION: exclusive owner of these describe blocks.
 * Targets the 6 uncovered lines / branches remaining after fcm.spec.ts:
 *
 *   stop()     — catch branch when client.disconnect() throws
 *   _tryStart  — registerToFCM returns Error with no .response and no .message
 *                → detail = "(empty error from @aracna/fcm — likely network/DNS issue)"
 *   _tryStart  — registerToFCM returns Error with .response.status populated
 *                → apiMsg / url detail lines (already partially covered, branch confirmed)
 *   _tryStart  — connectResult instanceof Error → throw connectResult
 *   _tryStart  — caught non-Error value → `new Error(String(err))` wrapping
 *   _parseNotification — camelCase field aliases (cameraId / cameraName / eventType / eventTags)
 *
 * Framework: Mocha + Chai + Sinon
 * Mirrors mock patterns from test/unit/fcm.spec.ts
 */

import { expect } from "chai";
import axios from "axios";
import sinon from "sinon";
import type { ECDH } from "crypto";

import {
    FcmListener,
    FcmRegistrationError,
    type FcmDeps,
} from "../../src/lib/fcm";

import { stubAxiosSequence, restoreAxios } from "./helpers/axios-mock";

// ── Helpers (mirrors fcm.spec.ts) ─────────────────────────────────────────────

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
        acg: { id: BigInt("4658368044210161110"), securityToken: BigInt("6632001525114872722") },
        token: "fake-fcm-token-xyz",
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

// ── stop() disconnect throws ──────────────────────────────────────────────────

describe("FcmListener.stop() — disconnect throws (coverage)", () => {
    afterEach(() => {
        restoreAxios();
    });

    it("swallows disconnect error and still emits 'disconnect'", async () => {
        const fakeClient = makeFakeClient();
        // Make disconnect() reject — the catch block in stop() should swallow it
        fakeClient.disconnect = sinon.stub().rejects(new Error("TLS socket already closed"));

        const { deps } = makeDeps({ fakeClient });
        stubAxiosSequence([{ status: 204, data: "" }]);

        const listener = makeListener("tok", { mode: "android" }, deps);
        await listener.start();

        const disconnectSpy = sinon.spy();
        listener.on("disconnect", disconnectSpy);

        // Must not throw even though client.disconnect() rejects
        await listener.stop();

        expect(disconnectSpy.calledOnce).to.be.true;
        expect(listener.isHealthy()).to.be.false;
    });
});

// ── _tryStart: registerToFCM error branches ───────────────────────────────────

describe("FcmListener._tryStart() FCM registration error detail (coverage)", () => {
    afterEach(() => {
        restoreAxios();
    });

    it("mode-failed event carries empty-error detail when err has no .response and no .message", async () => {
        // Error with empty message — triggers the `detail = "(empty error …)"` branch
        // The detail ends up in the mode-failed event (not in the thrown FcmRegistrationError,
        // which always says "Android registration failed").
        const emptyErr = new Error("");
        delete (emptyErr as unknown as Record<string, unknown>).response;

        const { deps } = makeDeps({ registerResult: emptyErr });
        const listener = makeListener("tok", { mode: "android" }, deps);
        const modeFailedSpy = sinon.spy();
        listener.on("mode-failed", modeFailedSpy);

        try {
            await listener.start();
            expect.fail("should have thrown");
        } catch (err: unknown) {
            expect(err).to.be.instanceOf(FcmRegistrationError);
        }

        expect(modeFailedSpy.calledOnce).to.be.true;
        const { error } = modeFailedSpy.firstCall.args[0] as { error: Error };
        // The FcmRegistrationError wraps the detail string in its message
        expect(error.message).to.include("empty error from @aracna/fcm");
    });

    it("mode-failed event carries HTTP detail when err has .response.status", async () => {
        // Simulate the FetchError-like object @aracna/fcm returns on HTTP failures.
        // The HTTP detail (status, url, apiMsg) is in the FcmRegistrationError that
        // _tryStart throws internally — caught, becomes mode-failed payload.
        const httpErr = Object.assign(new Error("fetch failed"), {
            response: {
                status: 403,
                statusText: "Forbidden",
                url: "https://fcm.googleapis.com/fcm/register",
                data: { error: { message: "Sender ID mismatch", status: "PERMISSION_DENIED" } },
            },
        });

        const { deps } = makeDeps({ registerResult: httpErr });
        const listener = makeListener("tok", { mode: "android" }, deps);
        const modeFailedSpy = sinon.spy();
        listener.on("mode-failed", modeFailedSpy);

        try {
            await listener.start();
            expect.fail("should have thrown");
        } catch (err: unknown) {
            expect(err).to.be.instanceOf(FcmRegistrationError);
        }

        expect(modeFailedSpy.calledOnce).to.be.true;
        const { error } = modeFailedSpy.firstCall.args[0] as { error: Error };
        expect(error.message).to.include("HTTP 403");
        expect(error.message).to.include("Sender ID mismatch");
    });

    it("mode-failed carries statusText fallback when data.error.message absent", async () => {
        const httpErr = Object.assign(new Error("fetch failed"), {
            response: {
                status: 400,
                statusText: "Bad Request",
                url: "https://fcm.googleapis.com/fcm/send",
                data: {},
            },
        });

        const { deps } = makeDeps({ registerResult: httpErr });
        const listener = makeListener("tok", { mode: "android" }, deps);
        const modeFailedSpy = sinon.spy();
        listener.on("mode-failed", modeFailedSpy);

        try {
            await listener.start();
            expect.fail("should have thrown");
        } catch (err: unknown) {
            expect(err).to.be.instanceOf(FcmRegistrationError);
        }

        expect(modeFailedSpy.calledOnce).to.be.true;
        const { error } = modeFailedSpy.firstCall.args[0] as { error: Error };
        expect(error.message).to.include("HTTP 400");
        expect(error.message).to.include("Bad Request");
    });

    it("mode-failed carries '(unknown URL)' fallback when resp.url absent", async () => {
        const httpErr = Object.assign(new Error("fetch failed"), {
            response: {
                status: 401,
                statusText: "Unauthorized",
                // No url field
                data: { error: { message: "token expired" } },
            },
        });

        const { deps } = makeDeps({ registerResult: httpErr });
        const listener = makeListener("tok", { mode: "android" }, deps);
        const modeFailedSpy = sinon.spy();
        listener.on("mode-failed", modeFailedSpy);

        try {
            await listener.start();
            expect.fail("should have thrown");
        } catch (err: unknown) {
            expect(err).to.be.instanceOf(FcmRegistrationError);
        }

        expect(modeFailedSpy.calledOnce).to.be.true;
        const { error } = modeFailedSpy.firstCall.args[0] as { error: Error };
        expect(error.message).to.include("(unknown URL)");
    });

    it("wraps non-Error thrown value into Error via String(err) in mode-failed event", async () => {
        // Make registerToFCM reject with a non-Error (plain string) — exercises
        // the `err instanceof Error ? err : new Error(String(err))` branch
        const { deps } = makeDeps();
        (deps.registerToFCM as sinon.SinonStub).rejects("plain string rejection");

        const listener = makeListener("tok", { mode: "android" }, deps);
        const modeFailedSpy = sinon.spy();
        listener.on("mode-failed", modeFailedSpy);

        try {
            await listener.start();
        } catch {
            // FcmRegistrationError expected — we just need mode-failed to fire
        }

        expect(modeFailedSpy.calledOnce).to.be.true;
        const { error } = modeFailedSpy.firstCall.args[0] as { error: Error };
        expect(error).to.be.instanceOf(Error);
    });
});

// ── _tryStart: connectResult instanceof Error ─────────────────────────────────

describe("FcmListener._tryStart() connectResult is Error (coverage)", () => {
    afterEach(() => {
        restoreAxios();
    });

    it("throws FcmRegistrationError when FcmClient.connect() returns an Error object", async () => {
        const connectErr = new Error("MTalk TLS handshake failed");
        const fakeClient = makeFakeClient(connectErr);
        const { deps } = makeDeps({ fakeClient });
        stubAxiosSequence([{ status: 204, data: "" }]);

        const listener = makeListener("tok", { mode: "android" }, deps);
        const modeFailedSpy = sinon.spy();
        listener.on("mode-failed", modeFailedSpy);

        try {
            await listener.start();
            expect.fail("should have thrown");
        } catch (err: unknown) {
            expect(err).to.be.instanceOf(FcmRegistrationError);
        }

        // mode-failed must carry the original connect error as cause
        expect(modeFailedSpy.calledOnce).to.be.true;
        const { error } = modeFailedSpy.firstCall.args[0] as { error: Error };
        expect(error.message).to.equal("MTalk TLS handshake failed");
    });
});

// ── _parseNotification — camelCase alias fields ───────────────────────────────

describe("FcmListener._parseNotification() camelCase alias fields (coverage)", () => {
    it("reads cameraId / cameraName / eventType / eventTags (camelCase aliases)", () => {
        const listener = makeListener();
        const result = listener._parseNotification({
            cameraId: "0A0B0C0D",
            cameraName: "Terrasse",
            timestamp: "2026-05-29T10:00:00Z",
            eventType: "MOVEMENT",
            eventTags: ["PERSON"],
        });
        expect(result).to.not.be.null;
        expect(result!.cameraId).to.equal("0A0B0C0D");
        expect(result!.cameraName).to.equal("Terrasse");
        expect(result!.eventType).to.equal("person");
    });

    it("reads camelCase imageUrl and eventId", () => {
        const listener = makeListener();
        const result = listener._parseNotification({
            cameraId: "CAM1",
            cameraName: "Garden",
            timestamp: "2026-05-29T10:00:00Z",
            eventType: "AUDIO_ALARM",
            imageUrl: "https://cdn.bosch.com/img.jpg",
            eventId: "evt-abc",
        });
        expect(result).to.not.be.null;
        expect(result!.imageUrl).to.equal("https://cdn.bosch.com/img.jpg");
        expect(result!.eventId).to.equal("evt-abc");
    });

    it("returns null for empty event_type (falsy rawType → no match)", () => {
        const listener = makeListener();
        const result = listener._parseNotification({
            camera_id: "CAM1",
            camera_name: "Test",
            timestamp: "",
            event_type: "",
        });
        expect(result).to.be.null;
    });
});
