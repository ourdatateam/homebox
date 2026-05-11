/**
 * Camera capture composable.
 *
 * Encapsulates the MediaStream lifecycle, capability detection, device selection,
 * and frame capture for the camera-capture dialog. UI components stay thin.
 *
 * Lifecycle rules:
 * - start() may be called multiple times; each call stops the previous stream first.
 * - stop() is idempotent; safe to call from onBeforeUnmount.
 * - If the component unmounts while a getUserMedia promise is in flight, the
 *   in-flight token mismatches and the resolved stream is stopped immediately
 *   (prevents leaking the camera after dialog close).
 */
import { computed, ref, shallowRef, type Ref, type ShallowRef } from "vue";

const PREFERRED_DEVICE_KEY = "homebox.camera.preferredDeviceId";
const DEFAULT_MAX_EDGE = 2048;
const DEFAULT_QUALITY = 0.85;

export type CameraCapabilities = {
  zoom?: { min: number; max: number; step?: number };
  torch?: boolean;
  exposureMode?: string[];
  exposureCompensation?: { min: number; max: number; step?: number };
};

export type SnapOptions = {
  quality?: number; // 0..1, JPEG quality
  maxEdge?: number; // downscale so max(width,height) ≤ maxEdge
};

export type UseCameraCapture = {
  // Reactive state
  stream: ShallowRef<MediaStream | null>;
  devices: ShallowRef<MediaDeviceInfo[]>;
  capabilities: Ref<CameraCapabilities>;
  error: Ref<string | null>;
  isStarting: Ref<boolean>;
  currentDeviceId: Ref<string | null>;
  hasZoom: Ref<boolean>;
  hasTorch: Ref<boolean>;
  hasExposureCompensation: Ref<boolean>;

  // Actions
  start: () => Promise<void>;
  stop: () => void;
  setDevice: (deviceId: string) => Promise<void>;
  setZoom: (zoom: number) => Promise<void>;
  setTorch: (on: boolean) => Promise<void>;
  setExposureCompensation: (value: number) => Promise<void>;
  snap: (video: HTMLVideoElement, canvas: HTMLCanvasElement, opts?: SnapOptions) => string;
  rotateDataURL: (dataURL: string, direction: "cw" | "ccw", quality?: number) => Promise<string>;
};

export function useCameraCapture(): UseCameraCapture {
  const stream = shallowRef<MediaStream | null>(null);
  const devices = shallowRef<MediaDeviceInfo[]>([]);
  const capabilities = ref<CameraCapabilities>({});
  const error = ref<string | null>(null);
  const isStarting = ref(false);
  const currentDeviceId = ref<string | null>(null);

  // Token used to detect orphaned getUserMedia resolutions.
  let activeToken = 0;

  function readCapabilities(track: MediaStreamTrack): CameraCapabilities {
    try {
      // Some browsers throw; some return an empty object; some need the track to be live.
      const caps = (track.getCapabilities?.() ?? {}) as Record<string, unknown>;
      const out: CameraCapabilities = {};
      if (caps.zoom && typeof caps.zoom === "object") {
        out.zoom = caps.zoom as CameraCapabilities["zoom"];
      }
      if (typeof caps.torch === "boolean") {
        out.torch = caps.torch;
      }
      if (Array.isArray(caps.exposureMode)) {
        out.exposureMode = caps.exposureMode as string[];
      }
      if (caps.exposureCompensation && typeof caps.exposureCompensation === "object") {
        out.exposureCompensation = caps.exposureCompensation as CameraCapabilities["exposureCompensation"];
      }
      return out;
    } catch {
      return {};
    }
  }

  async function refreshDevices() {
    try {
      const list = await navigator.mediaDevices.enumerateDevices();
      devices.value = list.filter(d => d.kind === "videoinput");
    } catch {
      devices.value = [];
    }
  }

  function stopTracks(s: MediaStream | null) {
    if (!s) return;
    s.getTracks().forEach(t => {
      try {
        t.stop();
      } catch {
        // ignore
      }
    });
  }

  function buildConstraints(deviceId: string | null): MediaStreamConstraints {
    const video: MediaTrackConstraints = {
      width: { ideal: 1920 },
      height: { ideal: 1080 },
    };
    if (deviceId) {
      video.deviceId = { exact: deviceId };
    } else {
      video.facingMode = { ideal: "environment" };
    }
    return { video, audio: false };
  }

  async function acquire(deviceId: string | null): Promise<MediaStream> {
    return navigator.mediaDevices.getUserMedia(buildConstraints(deviceId));
  }

  async function start() {
    const token = ++activeToken;
    error.value = null;
    isStarting.value = true;

    // Stop any prior stream first.
    stopTracks(stream.value);
    stream.value = null;

    const savedId = typeof localStorage !== "undefined" ? localStorage.getItem(PREFERRED_DEVICE_KEY) : null;

    let acquired: MediaStream;
    try {
      acquired = await acquire(savedId);
    } catch (e) {
      const err = e as DOMException;
      if (savedId && (err?.name === "OverconstrainedError" || err?.name === "NotFoundError")) {
        // Saved device gone — drop it and try defaults.
        try {
          localStorage.removeItem(PREFERRED_DEVICE_KEY);
        } catch {
          // ignore
        }
        try {
          acquired = await acquire(null);
        } catch (e2) {
          if (token === activeToken) {
            error.value = humanizeError(e2 as DOMException);
            isStarting.value = false;
          }
          return;
        }
      } else {
        if (token === activeToken) {
          error.value = humanizeError(err);
          isStarting.value = false;
        }
        return;
      }
    }

    // Orphan check: dialog closed while we were waiting.
    if (token !== activeToken) {
      stopTracks(acquired);
      return;
    }

    stream.value = acquired;
    isStarting.value = false;

    const track = acquired.getVideoTracks()[0];
    if (track) {
      const settings = track.getSettings?.() ?? {};
      currentDeviceId.value = settings.deviceId ?? null;
      capabilities.value = readCapabilities(track);

      track.addEventListener("ended", () => {
        // Camera disappeared mid-session.
        if (stream.value === acquired) {
          stream.value = null;
          error.value = "camera-track-ended";
        }
      });
    }

    // enumerateDevices labels only populated after permission grant.
    await refreshDevices();
  }

  function stop() {
    activeToken++;
    stopTracks(stream.value);
    stream.value = null;
    capabilities.value = {};
    isStarting.value = false;
  }

  async function setDevice(deviceId: string) {
    try {
      localStorage.setItem(PREFERRED_DEVICE_KEY, deviceId);
    } catch {
      // ignore
    }
    // Stop current and restart with new deviceId.
    const token = ++activeToken;
    stopTracks(stream.value);
    stream.value = null;
    isStarting.value = true;
    try {
      const acquired = await acquire(deviceId);
      if (token !== activeToken) {
        stopTracks(acquired);
        return;
      }
      stream.value = acquired;
      const track = acquired.getVideoTracks()[0];
      if (track) {
        currentDeviceId.value = track.getSettings?.().deviceId ?? deviceId;
        capabilities.value = readCapabilities(track);
      }
    } catch (e) {
      if (token === activeToken) {
        error.value = humanizeError(e as DOMException);
      }
    } finally {
      if (token === activeToken) {
        isStarting.value = false;
      }
    }
  }

  function activeTrack(): MediaStreamTrack | null {
    return stream.value?.getVideoTracks()[0] ?? null;
  }

  async function setZoom(zoom: number) {
    const track = activeTrack();
    if (!track) return;
    try {
      await track.applyConstraints({ advanced: [{ zoom }] as unknown as MediaTrackConstraintSet[] });
    } catch {
      // ignore — UI may have lagged behind capability removal
    }
  }

  async function setTorch(on: boolean) {
    const track = activeTrack();
    if (!track) return;
    try {
      await track.applyConstraints({ advanced: [{ torch: on }] as unknown as MediaTrackConstraintSet[] });
    } catch {
      // ignore
    }
  }

  async function setExposureCompensation(value: number) {
    const track = activeTrack();
    if (!track) return;
    try {
      await track.applyConstraints({
        advanced: [{ exposureMode: "manual", exposureCompensation: value }] as unknown as MediaTrackConstraintSet[],
      });
    } catch {
      // ignore
    }
  }

  function snap(video: HTMLVideoElement, canvas: HTMLCanvasElement, opts: SnapOptions = {}): string {
    const quality = opts.quality ?? DEFAULT_QUALITY;
    const maxEdge = opts.maxEdge ?? DEFAULT_MAX_EDGE;

    const srcW = video.videoWidth;
    const srcH = video.videoHeight;
    let dstW = srcW;
    let dstH = srcH;
    const longest = Math.max(srcW, srcH);
    if (longest > maxEdge) {
      const scale = maxEdge / longest;
      dstW = Math.round(srcW * scale);
      dstH = Math.round(srcH * scale);
    }

    canvas.width = dstW;
    canvas.height = dstH;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.drawImage(video, 0, 0, dstW, dstH);
    }
    return canvas.toDataURL("image/jpeg", quality);
  }

  const hasZoom = computed(() => !!capabilities.value.zoom);
  const hasTorch = computed(() => capabilities.value.torch === true);
  const hasExposureCompensation = computed(
    () => !!capabilities.value.exposureCompensation && !!capabilities.value.exposureMode?.includes("manual")
  );

  /**
   * Rotates a JPEG dataURL 90° in the given direction. Returns a fresh
   * JPEG dataURL. Pure helper — does not touch the stream.
   */
  function rotateDataURL(dataURL: string, direction: "cw" | "ccw", quality = DEFAULT_QUALITY): Promise<string> {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement("canvas");
        canvas.width = img.height;
        canvas.height = img.width;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          reject(new Error("canvas-2d-unavailable"));
          return;
        }
        ctx.translate(canvas.width / 2, canvas.height / 2);
        ctx.rotate((direction === "cw" ? 90 : -90) * (Math.PI / 180));
        ctx.drawImage(img, -img.width / 2, -img.height / 2);
        resolve(canvas.toDataURL("image/jpeg", quality));
      };
      img.onerror = () => reject(new Error("image-decode-failed"));
      img.src = dataURL;
    });
  }

  return {
    stream,
    devices,
    capabilities,
    error,
    isStarting,
    currentDeviceId,
    hasZoom,
    hasTorch,
    hasExposureCompensation,
    start,
    stop,
    setDevice,
    setZoom,
    setTorch,
    setExposureCompensation,
    snap,
    rotateDataURL,
  };
}

function humanizeError(err: DOMException | Error): string {
  const name = (err as DOMException)?.name ?? "Error";
  switch (name) {
    case "NotAllowedError":
      return "camera-permission-denied";
    case "NotFoundError":
    case "OverconstrainedError":
      return "camera-not-found";
    case "NotReadableError":
      return "camera-in-use";
    case "AbortError":
      return "camera-aborted";
    default:
      return `camera-error:${name}`;
  }
}
