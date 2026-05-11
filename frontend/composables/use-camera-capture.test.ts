/**
 * Unit tests for the camera-capture composable (TDD: written before implementation).
 *
 * Mocks navigator.mediaDevices to exercise the state machine without a browser.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { nextTick } from "vue";
import { useCameraCapture } from "./use-camera-capture";

/**
 * Build a minimal MediaStreamTrack that supports the capabilities we read.
 */
function fakeTrack(opts: { capabilities?: MediaTrackCapabilities; settings?: MediaTrackSettings }): MediaStreamTrack {
  const listeners = new Map<string, EventListener>();
  return {
    kind: "video",
    enabled: true,
    readyState: "live",
    getCapabilities: () => opts.capabilities ?? {},
    getSettings: () => opts.settings ?? {},
    applyConstraints: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn(),
    addEventListener: (type: string, cb: EventListener) => listeners.set(type, cb),
    removeEventListener: (type: string) => listeners.delete(type),
    // helper for tests to fire 'ended'
    __fire: (type: string) => listeners.get(type)?.(new Event(type)),
  } as unknown as MediaStreamTrack;
}

function fakeStream(track: MediaStreamTrack): MediaStream {
  return {
    getVideoTracks: () => [track],
    getTracks: () => [track],
  } as unknown as MediaStream;
}

const fakeDevices: MediaDeviceInfo[] = [
  {
    deviceId: "front-cam",
    kind: "videoinput",
    label: "Front Camera",
    groupId: "g1",
    toJSON: () => ({}),
  } as MediaDeviceInfo,
  {
    deviceId: "rear-cam",
    kind: "videoinput",
    label: "Rear Camera",
    groupId: "g2",
    toJSON: () => ({}),
  } as MediaDeviceInfo,
];

describe("useCameraCapture composable", () => {
  let getUserMediaMock: ReturnType<typeof vi.fn>;
  let enumerateDevicesMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    getUserMediaMock = vi.fn();
    enumerateDevicesMock = vi.fn().mockResolvedValue(fakeDevices);

    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      writable: true,
      value: {
        mediaDevices: {
          getUserMedia: getUserMediaMock,
          enumerateDevices: enumerateDevicesMock,
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
        },
      },
    });

    // localStorage mock
    const store = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => {
          store.set(k, v);
        },
        removeItem: (k: string) => {
          store.delete(k);
        },
      },
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  test("start() acquires a stream and exposes it reactively", async () => {
    const track = fakeTrack({});
    const stream = fakeStream(track);
    getUserMediaMock.mockResolvedValue(stream);

    const cap = useCameraCapture();
    expect(cap.stream.value).toBeNull();

    await cap.start();

    expect(getUserMediaMock).toHaveBeenCalled();
    expect(cap.stream.value).toBe(stream);
    expect(cap.error.value).toBeNull();
  });

  test("stop() releases all tracks and clears the stream", async () => {
    const track = fakeTrack({});
    const stream = fakeStream(track);
    getUserMediaMock.mockResolvedValue(stream);

    const cap = useCameraCapture();
    await cap.start();
    cap.stop();

    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(cap.stream.value).toBeNull();
  });

  test("permission denied surfaces a typed error and leaves stream null", async () => {
    getUserMediaMock.mockRejectedValue(Object.assign(new Error("Permission denied"), { name: "NotAllowedError" }));

    const cap = useCameraCapture();
    await cap.start();

    expect(cap.error.value).toMatch(/permission|denied/i);
    expect(cap.stream.value).toBeNull();
  });

  test("OverconstrainedError on saved deviceId falls back to default device", async () => {
    // First call: fail with OverconstrainedError (saved deviceId stale)
    // Second call: succeed with default
    const track = fakeTrack({});
    const stream = fakeStream(track);
    getUserMediaMock
      .mockRejectedValueOnce(Object.assign(new Error("Device gone"), { name: "OverconstrainedError" }))
      .mockResolvedValueOnce(stream);

    localStorage.setItem("homebox.camera.preferredDeviceId", "nonexistent");

    const cap = useCameraCapture();
    await cap.start();

    expect(getUserMediaMock).toHaveBeenCalledTimes(2);
    expect(cap.stream.value).toBe(stream);
  });

  test("setDevice() restarts the stream with the chosen deviceId and persists it", async () => {
    const trackA = fakeTrack({});
    const trackB = fakeTrack({});
    getUserMediaMock.mockResolvedValueOnce(fakeStream(trackA)).mockResolvedValueOnce(fakeStream(trackB));

    const cap = useCameraCapture();
    await cap.start();
    await cap.setDevice("rear-cam");

    expect(trackA.stop).toHaveBeenCalled();
    expect(getUserMediaMock.mock.calls[1]?.[0]).toMatchObject({
      video: expect.objectContaining({ deviceId: { exact: "rear-cam" } }),
    });
    expect(localStorage.getItem("homebox.camera.preferredDeviceId")).toBe("rear-cam");
  });

  test("capabilities expose zoom/torch/exposure when supported by the track", async () => {
    const track = fakeTrack({
      capabilities: {
        zoom: { min: 1, max: 4, step: 0.1 },
        torch: true,
        exposureMode: ["continuous", "manual"],
        exposureCompensation: { min: -3, max: 3, step: 0.33 },
      } as unknown as MediaTrackCapabilities,
    });
    getUserMediaMock.mockResolvedValue(fakeStream(track));

    const cap = useCameraCapture();
    await cap.start();
    await nextTick();

    expect(cap.capabilities.value.zoom).toEqual({ min: 1, max: 4, step: 0.1 });
    expect(cap.capabilities.value.torch).toBe(true);
    expect(cap.capabilities.value.exposureCompensation).toEqual({ min: -3, max: 3, step: 0.33 });
  });

  test("setZoom() applies advanced constraint on the track", async () => {
    const track = fakeTrack({
      capabilities: { zoom: { min: 1, max: 4, step: 0.1 } } as unknown as MediaTrackCapabilities,
    });
    getUserMediaMock.mockResolvedValue(fakeStream(track));

    const cap = useCameraCapture();
    await cap.start();
    await cap.setZoom(2);

    expect(track.applyConstraints).toHaveBeenCalledWith(expect.objectContaining({ advanced: [{ zoom: 2 }] }));
  });

  test("setTorch(true) applies advanced constraint on the track", async () => {
    const track = fakeTrack({
      capabilities: { torch: true } as unknown as MediaTrackCapabilities,
    });
    getUserMediaMock.mockResolvedValue(fakeStream(track));

    const cap = useCameraCapture();
    await cap.start();
    await cap.setTorch(true);

    expect(track.applyConstraints).toHaveBeenCalledWith(expect.objectContaining({ advanced: [{ torch: true }] }));
  });

  test("setExposureCompensation() applies advanced constraint with manual exposureMode", async () => {
    const track = fakeTrack({
      capabilities: {
        exposureMode: ["continuous", "manual"],
        exposureCompensation: { min: -3, max: 3, step: 0.33 },
      } as unknown as MediaTrackCapabilities,
    });
    getUserMediaMock.mockResolvedValue(fakeStream(track));

    const cap = useCameraCapture();
    await cap.start();
    await cap.setExposureCompensation(1.5);

    expect(track.applyConstraints).toHaveBeenCalledWith(
      expect.objectContaining({
        advanced: [{ exposureMode: "manual", exposureCompensation: 1.5 }],
      })
    );
  });

  test("snap() returns a dataURL JPEG from the canvas", async () => {
    const track = fakeTrack({});
    const stream = fakeStream(track);
    getUserMediaMock.mockResolvedValue(stream);

    // Stub canvas + drawImage chain via a faked HTMLCanvasElement that toDataURL returns a known string.
    const toDataURL = vi.fn().mockReturnValue("data:image/jpeg;base64,FAKEDATA");
    const fakeCanvas = {
      width: 0,
      height: 0,
      getContext: () => ({ drawImage: vi.fn() }),
      toDataURL,
    } as unknown as HTMLCanvasElement;

    const fakeVideo = {
      videoWidth: 1280,
      videoHeight: 720,
    } as HTMLVideoElement;

    const cap = useCameraCapture();
    await cap.start();
    const dataURL = cap.snap(fakeVideo, fakeCanvas, { quality: 0.85 });

    expect(toDataURL).toHaveBeenCalledWith("image/jpeg", 0.85);
    expect(dataURL).toBe("data:image/jpeg;base64,FAKEDATA");
    expect(fakeCanvas.width).toBe(1280);
    expect(fakeCanvas.height).toBe(720);
  });

  test("snap() downscales when source exceeds max-edge", async () => {
    const track = fakeTrack({});
    getUserMediaMock.mockResolvedValue(fakeStream(track));

    const toDataURL = vi.fn().mockReturnValue("data:image/jpeg;base64,X");
    const fakeCanvas = {
      width: 0,
      height: 0,
      getContext: () => ({ drawImage: vi.fn() }),
      toDataURL,
    } as unknown as HTMLCanvasElement;
    // 4000x3000 source, max-edge 2048 → scale by 2048/4000 = 0.512 → 2048x1536
    const fakeVideo = {
      videoWidth: 4000,
      videoHeight: 3000,
    } as HTMLVideoElement;

    const cap = useCameraCapture();
    await cap.start();
    cap.snap(fakeVideo, fakeCanvas, { quality: 0.85, maxEdge: 2048 });

    expect(fakeCanvas.width).toBe(2048);
    expect(fakeCanvas.height).toBe(1536);
  });
});
