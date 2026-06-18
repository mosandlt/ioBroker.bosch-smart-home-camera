/**
 * Item: iOB-S1 — Daily event counts bucket by the event's LOCAL date
 * Migration-concept: port HA v13.7.2 fix (issue #34) for events_today/
 *   movement_count/audio_count. Bosch timestamps are OFFSET-bearing
 *   ("2026-06-18T06:06:30.499+02:00[Europe/Berlin]"), NOT Z-suffix UTC. The
 *   old code compared the raw string's local-date PREFIX against a UTC "today"
 *   → mis-bucketed events in the hours around midnight. Counts are now bucketed
 *   against the LOCAL calendar date of each event's true instant (offset honored
 *   after stripping the [zone] suffix), mirroring HA's as_local sensors so the
 *   counters roll over at local midnight.
 * Layer: adapter backend (main.ts — _countDailyEvents, derived from /v11/events)
 *
 * The static helper is pulled off the real adapter class (built main.js) and
 * called with an injected clock. process.env.TZ is pinned per-describe so the
 * local-date assertions are deterministic regardless of the CI runner's zone.
 */

import { expect } from "chai";
import sinon from "sinon";
import * as path from "path";

import type { MockDatabase } from "@iobroker/testing/build/tests/unit/mocks/mockDatabase";
import type { MockAdapter } from "@iobroker/testing/build/tests/unit/mocks/mockAdapter";

// eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
const { MockDatabase: MockDatabaseCtor } =
    require("@iobroker/testing/build/tests/unit/mocks/mockDatabase") as {
        MockDatabase: new () => MockDatabase;
    };
// eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
const { mockAdapterCore: mockAdapterCoreFn } =
    require("@iobroker/testing/build/tests/unit/mocks/mockAdapterCore") as {
        mockAdapterCore: (
            db: MockDatabase,
            opts?: { onAdapterCreated?: (a: MockAdapter) => void },
        ) => unknown;
    };

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const MAIN_JS_PATH = path.join(REPO_ROOT, "build", "main.js");
const ADAPTER_CORE_PATH = require.resolve("@iobroker/adapter-core");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function loadAdapter(): any {
    const db = new MockDatabaseCtor();
    let captured: MockAdapter | null = null;
    const core = mockAdapterCoreFn(db, {
        onAdapterCreated: (a) => {
            captured = a;
        },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (require.cache as any)[ADAPTER_CORE_PATH] = {
        id: ADAPTER_CORE_PATH,
        filename: ADAPTER_CORE_PATH,
        loaded: true,
        parent: module,
        children: [],
        path: path.dirname(ADAPTER_CORE_PATH),
        paths: [],
        exports: core,
    };
    delete require.cache[MAIN_JS_PATH];
    // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
    const factory = require(MAIN_JS_PATH) as (opts: Record<string, unknown>) => MockAdapter;
    factory({ config: { redirect_url: "", region: "EU", startup_snapshot: true } });
    if (!captured) {
        throw new Error("adapter not captured");
    }
    return captured;
}

describe("iOB-S1 — _countDailyEvents (local-day bucketing, TZ=UTC)", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let count: (events: Array<Record<string, unknown>>, nowMs?: number) => any;
    let origTz: string | undefined;
    // Under TZ=UTC local date == UTC date, so Z timestamps are unambiguous.
    const NOON = Date.parse("2026-06-18T12:00:00Z");

    before(() => {
        origTz = process.env.TZ;
        process.env.TZ = "UTC";
        const adapter = loadAdapter();
        count = adapter.constructor._countDailyEvents;
    });

    after(() => {
        if (origTz === undefined) {
            delete process.env.TZ;
        } else {
            process.env.TZ = origTz;
        }
    });

    it("classifies movement / audio / total for today (raw eventType)", () => {
        const r = count(
            [
                { timestamp: "2026-06-18T08:00:00Z", eventType: "MOVEMENT" },
                { timestamp: "2026-06-18T09:00:00Z", eventType: "MOVEMENT", eventTags: ["PERSON"] },
                { timestamp: "2026-06-18T10:00:00Z", eventType: "AUDIO_ALARM" },
                { timestamp: "2026-06-18T11:00:00Z", eventType: "TROUBLE_DISCONNECT" },
            ],
            NOON,
        );
        // person-tagged movement still counts as MOVEMENT (raw type); trouble
        // counts toward today's total but not movement/audio.
        expect(r).to.deep.equal({ today: 4, movement: 2, audio: 1 });
    });

    it("excludes events from other days", () => {
        const r = count(
            [
                { timestamp: "2026-06-17T23:59:59Z", eventType: "MOVEMENT" }, // yesterday
                { timestamp: "2026-06-18T00:00:00Z", eventType: "MOVEMENT" }, // today start
                { timestamp: "2026-06-19T00:00:00Z", eventType: "MOVEMENT" }, // tomorrow
            ],
            NOON,
        );
        expect(r).to.deep.equal({ today: 1, movement: 1, audio: 0 });
    });

    it("empty list → all zero", () => {
        expect(count([], NOON)).to.deep.equal({ today: 0, movement: 0, audio: 0 });
    });

    it("falls back to createdAt when timestamp is absent; ignores undated events", () => {
        const r = count(
            [
                { createdAt: "2026-06-18T06:00:00Z", eventType: "MOVEMENT" },
                { eventType: "MOVEMENT" }, // no date → ignored
            ],
            NOON,
        );
        expect(r).to.deep.equal({ today: 1, movement: 1, audio: 0 });
    });
});

// The real Bosch format carries an explicit offset + IANA zone suffix. Pin that
// the offset is honored and the event is bucketed by its LOCAL date. Forcing
// TZ=Europe/Berlin makes this deterministic: an event at 00:30+02:00 is local
// "today" even though its UTC instant (22:30Z) is the previous UTC day — the
// old UTC-prefix code mis-counted exactly this window.
describe("iOB-S1 — _countDailyEvents offset format + local midnight (TZ=Europe/Berlin)", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let count: (events: Array<Record<string, unknown>>, nowMs?: number) => any;
    let origTz: string | undefined;

    before(() => {
        origTz = process.env.TZ;
        process.env.TZ = "Europe/Berlin"; // UTC+2 in June
        const adapter = loadAdapter();
        count = adapter.constructor._countDailyEvents;
    });

    after(() => {
        if (origTz === undefined) {
            delete process.env.TZ;
        } else {
            process.env.TZ = origTz;
        }
    });

    it("honors +02:00[Europe/Berlin] and buckets by local date across UTC midnight", () => {
        // Local now = 2026-06-18 01:00 Berlin (= 2026-06-17 23:00Z).
        const nowMs = Date.parse("2026-06-18T01:00:00+02:00");
        const r = count(
            [
                // local-today (06-18 00:30 Berlin = 06-17 22:30Z) → counts
                { timestamp: "2026-06-18T00:30:00.000+02:00[Europe/Berlin]", eventType: "MOVEMENT" },
                // local-yesterday (06-17 23:00 Berlin = 06-17 21:00Z) → excluded
                { timestamp: "2026-06-17T23:00:00.000+02:00[Europe/Berlin]", eventType: "AUDIO_ALARM" },
            ],
            nowMs,
        );
        expect(r).to.deep.equal({ today: 1, movement: 1, audio: 0 });
    });
});

// Wiring: the counters must be written to the per-camera DPs on EVERY successful
// poll — including an empty list and a duplicate-newest event — so they roll over
// to 0 at local midnight without needing a fresh event.
describe("iOB-S1 — fetchAndProcessEvents writes counters every poll", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let fetchEvents: (...a: any[]) => Promise<void>;
    const CAM = "11111111-2222-3333-4444-555555555555";

    before(() => {
        const adapter = loadAdapter();
        fetchEvents = adapter.fetchAndProcessEvents;
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    function stub(data: unknown, lastSeen?: string): any {
        return {
            _currentAccessToken: "tok",
            _cameras: new Map<string, unknown>([[CAM, {}]]),
            _httpClient: { get: sinon.stub().resolves({ status: 200, data }) },
            _lastSeenEventId: lastSeen ? { [CAM]: lastSeen } : {},
            _lastEventFetchAt: -Infinity,
            upsertState: sinon.stub().resolves(),
            setStateAsync: sinon.stub().resolves(),
            log: { debug: sinon.stub(), info: sinon.stub(), silly: sinon.stub() },
        };
    }

    function counterCalls(upsert: sinon.SinonStub): Record<string, unknown> {
        const out: Record<string, unknown> = {};
        for (const c of upsert.getCalls()) {
            const id = c.args[0] as string;
            for (const dp of ["events_today", "movement_count", "audio_count"]) {
                if (id === `cameras.${CAM}.${dp}`) {
                    out[dp] = c.args[1];
                }
            }
        }
        return out;
    }

    it("empty list → writes 0/0/0 (midnight rollover with no new event)", async () => {
        const s = stub([]);
        await fetchEvents.call(s);
        expect(counterCalls(s.upsertState)).to.deep.equal({
            events_today: 0,
            movement_count: 0,
            audio_count: 0,
        });
    });

    it("duplicate-newest event still refreshes the counters (before the dedup skip)", async () => {
        const todayIso = new Date().toISOString(); // real now → always local-today
        const s = stub([{ id: "evt1", timestamp: todayIso, eventType: "MOVEMENT" }], "evt1");
        await fetchEvents.call(s);
        const c = counterCalls(s.upsertState);
        expect(c.events_today, "today counted despite duplicate").to.equal(1);
        expect(c.movement_count).to.equal(1);
        expect(c.audio_count).to.equal(0);
        // dedup still skipped the motion side-effects (same id as last seen)
        expect(
            s.setStateAsync.getCalls().some((x) => String(x.args[0]).endsWith(".last_motion_at")),
            "no motion side-effect on duplicate",
        ).to.equal(false);
    });
});
