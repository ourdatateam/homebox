<template>
  <DialogRoot v-model:open="openModel" :modal="true">
    <DialogPortal>
      <DialogOverlay class="fixed inset-0 z-50 bg-black/80" />
      <DialogContent
        class="fixed left-1/2 top-1/2 z-50 w-full max-w-3xl -translate-x-1/2 -translate-y-1/2 gap-3 rounded-lg border bg-background p-6 shadow-lg sm:rounded-lg"
        :class="{ 'h-screen max-w-full': isMobile }"
        @escape-key-down="onCancel"
        @pointer-down-outside.prevent
      >
        <DialogTitle class="text-lg font-semibold">{{ $t("components.item.camera_capture.title") }}</DialogTitle>
        <DialogDescription class="sr-only">
          {{ $t("components.item.camera_capture.subtitle") }}
        </DialogDescription>

        <!-- Error state -->
        <div
          v-if="cap.error.value"
          class="rounded-md border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive"
        >
          {{ errorMessage }}
        </div>

        <!-- Camera selector + hardware controls -->
        <div v-if="!cap.error.value" class="flex flex-wrap items-center gap-2">
          <div v-if="cap.devices.value.length > 1" class="flex items-center gap-2">
            <Label for="camera-device-select" class="text-sm">
              {{ $t("components.item.camera_capture.device") }}
            </Label>
            <select
              id="camera-device-select"
              class="rounded-md border bg-background px-2 py-1 text-sm"
              :value="cap.currentDeviceId.value ?? ''"
              @change="onDeviceChange"
            >
              <option v-for="d in cap.devices.value" :key="d.deviceId" :value="d.deviceId">
                {{ d.label || $t("components.item.camera_capture.unnamed_camera") }}
              </option>
            </select>
          </div>

          <Button
            v-if="cap.hasTorch.value"
            type="button"
            variant="outline"
            size="sm"
            :aria-pressed="torchOn"
            @click="toggleTorch"
          >
            <MdiFlash v-if="torchOn" class="size-4" />
            <MdiFlashOff v-else class="size-4" />
            {{
              torchOn ? $t("components.item.camera_capture.flash_on") : $t("components.item.camera_capture.flash_off")
            }}
          </Button>

          <div v-if="cap.hasZoom.value" class="flex items-center gap-2">
            <Label for="camera-zoom" class="text-sm">
              {{ $t("components.item.camera_capture.zoom") }}
            </Label>
            <input
              id="camera-zoom"
              v-model.number="zoomValue"
              type="range"
              class="w-32"
              :min="cap.capabilities.value.zoom?.min ?? 1"
              :max="cap.capabilities.value.zoom?.max ?? 4"
              :step="cap.capabilities.value.zoom?.step ?? 0.1"
              @input="applyZoom"
            />
            <span class="w-10 text-xs tabular-nums">{{ zoomValue.toFixed(1) }}×</span>
          </div>

          <div v-if="cap.hasExposureCompensation.value" class="flex items-center gap-2">
            <Label for="camera-exposure" class="text-sm">
              {{ $t("components.item.camera_capture.exposure") }}
            </Label>
            <input
              id="camera-exposure"
              v-model.number="exposureValue"
              type="range"
              class="w-32"
              :min="cap.capabilities.value.exposureCompensation?.min ?? -3"
              :max="cap.capabilities.value.exposureCompensation?.max ?? 3"
              :step="cap.capabilities.value.exposureCompensation?.step ?? 0.33"
              @input="applyExposure"
            />
            <span class="w-10 text-xs tabular-nums">{{ exposureValue.toFixed(1) }}</span>
          </div>
        </div>

        <!-- Live preview OR review frame -->
        <div class="relative overflow-hidden rounded-md bg-black">
          <video
            v-show="!isReviewing"
            ref="videoEl"
            autoplay
            muted
            playsinline
            class="block w-full"
            aria-label="Camera preview"
          ></video>
          <img
            v-show="isReviewing && reviewDataURL"
            :src="reviewDataURL"
            class="block w-full"
            :alt="$t('components.item.camera_capture.review_alt')"
          />
          <div
            v-if="cap.isStarting.value && !cap.error.value"
            class="absolute inset-0 flex items-center justify-center bg-black/60 text-white"
          >
            {{ $t("components.item.camera_capture.starting") }}
          </div>
          <canvas ref="canvasEl" class="hidden"></canvas>
        </div>

        <!-- Action buttons depending on mode -->
        <div class="flex flex-wrap items-center justify-center gap-3">
          <template v-if="!isReviewing">
            <Button
              type="button"
              data-testid="snap-button"
              :disabled="!streamReady || snapping"
              size="lg"
              @click="onSnap"
            >
              <MdiCamera class="mr-2 size-5" />
              {{ $t("components.item.camera_capture.snap") }}
            </Button>
          </template>
          <template v-else>
            <Button type="button" variant="outline" @click="onRetake">
              <MdiRefresh class="mr-2 size-4" />
              {{ $t("components.item.camera_capture.retake") }}
            </Button>
            <Button type="button" @click="onKeep">
              <MdiCheck class="mr-2 size-4" />
              {{ $t("components.item.camera_capture.keep") }}
            </Button>
          </template>
        </div>

        <!-- Captured strip -->
        <div v-if="captured.length > 0" data-testid="captured-strip" class="border-t pt-3">
          <p class="mb-2 text-xs text-muted-foreground">
            {{ $t("components.item.camera_capture.captured_count", { n: captured.length }) }}
          </p>
          <div class="flex gap-2 overflow-x-auto">
            <div v-for="(p, index) in captured" :key="index" data-testid="captured-thumbnail" class="relative shrink-0">
              <img
                :src="p.fileBase64"
                class="size-16 rounded border object-cover"
                :alt="$t('components.item.camera_capture.captured_alt', { i: index + 1 })"
              />
              <Button
                type="button"
                size="icon"
                variant="destructive"
                class="absolute -right-2 -top-2 size-5"
                :aria-label="$t('components.item.camera_capture.remove_thumbnail')"
                @click="removeThumbnail(index)"
              >
                <MdiClose class="size-3" />
              </Button>
            </div>
          </div>
        </div>

        <div class="flex justify-end gap-2 pt-2">
          <Button type="button" variant="outline" @click="onCancel">
            {{ $t("global.cancel") }}
          </Button>
          <Button type="button" :disabled="captured.length === 0" @click="onDone">
            {{ $t("components.item.camera_capture.done") }}
          </Button>
        </div>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>

<script setup lang="ts">
  import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
  import { useI18n } from "vue-i18n";
  import { DialogContent, DialogDescription, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from "reka-ui";
  import { Button } from "@/components/ui/button";
  import { Label } from "@/components/ui/label";
  import { useCameraCapture } from "~/composables/use-camera-capture";
  import MdiCamera from "~icons/mdi/camera";
  import MdiCheck from "~icons/mdi/check";
  import MdiClose from "~icons/mdi/close";
  import MdiFlash from "~icons/mdi/flash";
  import MdiFlashOff from "~icons/mdi/flash-off";
  import MdiRefresh from "~icons/mdi/refresh";

  type CapturedPhoto = { photoName: string; fileBase64: string; file: File };

  const props = defineProps<{ open: boolean }>();
  const emit = defineEmits<{
    "update:open": [boolean];
    capture: [CapturedPhoto[]];
  }>();

  const { t } = useI18n();

  const openModel = computed({
    get: () => props.open,
    set: v => emit("update:open", v),
  });

  const videoEl = ref<HTMLVideoElement | null>(null);
  const canvasEl = ref<HTMLCanvasElement | null>(null);
  const isReviewing = ref(false);
  const reviewDataURL = ref<string>("");
  const captured = ref<CapturedPhoto[]>([]);
  const snapping = ref(false);
  const torchOn = ref(false);
  const zoomValue = ref(1);
  const exposureValue = ref(0);

  const cap = useCameraCapture();

  const isMobile = computed(() => {
    if (typeof window === "undefined") return false;
    return window.innerWidth < 640;
  });

  const streamReady = computed(() => cap.stream.value !== null && !cap.isStarting.value);

  const errorMessage = computed(() => {
    const key = cap.error.value;
    if (!key) return "";
    const messages: Record<string, string> = {
      "camera-permission-denied": t("components.item.camera_capture.errors.permission_denied"),
      "camera-not-found": t("components.item.camera_capture.errors.not_found"),
      "camera-in-use": t("components.item.camera_capture.errors.in_use"),
      "camera-aborted": t("components.item.camera_capture.errors.aborted"),
      "camera-track-ended": t("components.item.camera_capture.errors.disconnected"),
    };
    return messages[key] ?? t("components.item.camera_capture.errors.generic");
  });

  // Open: start the stream once the dialog is visible.
  watch(
    () => props.open,
    async open => {
      if (open) {
        resetSessionState();
        await nextTick();
        await cap.start();
        attachStream();
      } else {
        teardown();
      }
    }
  );

  watch(
    () => cap.stream.value,
    () => {
      attachStream();
    }
  );

  function resetSessionState() {
    captured.value = [];
    isReviewing.value = false;
    reviewDataURL.value = "";
    snapping.value = false;
    torchOn.value = false;
    zoomValue.value = 1;
    exposureValue.value = 0;
  }

  function attachStream() {
    if (videoEl.value && cap.stream.value) {
      videoEl.value.srcObject = cap.stream.value;
    }
  }

  async function onSnap() {
    if (!videoEl.value || !canvasEl.value || !streamReady.value) return;
    if (videoEl.value.readyState < 2) return;
    snapping.value = true;
    try {
      const dataURL = cap.snap(videoEl.value, canvasEl.value, { quality: 0.85, maxEdge: 2048 });
      reviewDataURL.value = dataURL;
      isReviewing.value = true;
    } finally {
      setTimeout(() => (snapping.value = false), 100);
    }
  }

  function onRetake() {
    reviewDataURL.value = "";
    isReviewing.value = false;
  }

  function onKeep() {
    if (!reviewDataURL.value) return;
    const photoName = `camera_capture_${Date.now()}.jpg`;
    captured.value.push({
      photoName,
      fileBase64: reviewDataURL.value,
      file: dataURLtoFile(reviewDataURL.value, photoName),
    });
    reviewDataURL.value = "";
    isReviewing.value = false;
  }

  function removeThumbnail(index: number) {
    captured.value.splice(index, 1);
  }

  function onDone() {
    if (captured.value.length === 0) {
      onCancel();
      return;
    }
    emit("capture", [...captured.value]);
    emit("update:open", false);
  }

  function onCancel() {
    emit("update:open", false);
  }

  function teardown() {
    cap.stop();
    if (videoEl.value) {
      videoEl.value.srcObject = null;
    }
    resetSessionState();
  }

  async function onDeviceChange(event: Event) {
    const id = (event.target as HTMLSelectElement).value;
    if (id) {
      await cap.setDevice(id);
      attachStream();
    }
  }

  async function toggleTorch() {
    torchOn.value = !torchOn.value;
    await cap.setTorch(torchOn.value);
  }

  async function applyZoom() {
    await cap.setZoom(zoomValue.value);
  }

  async function applyExposure() {
    await cap.setExposureCompensation(exposureValue.value);
  }

  onBeforeUnmount(() => {
    cap.stop();
  });

  function dataURLtoFile(dataURL: string, fileName: string): File {
    const arr = dataURL.split(",");
    const mimeMatch = arr[0]!.match(/:(.*?);/);
    const mime = mimeMatch?.[1] ?? "image/jpeg";
    const bstr = atob(arr[1]!);
    const u8 = new Uint8Array(bstr.length);
    for (let i = 0; i < bstr.length; i++) {
      u8[i] = bstr.charCodeAt(i);
    }
    return new File([u8], fileName, { type: mime });
  }
</script>
