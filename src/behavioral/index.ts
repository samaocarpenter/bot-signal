import { analyzeBehavioralSamples } from "./scoring.js";
import type {
  BehavioralClientDetector,
  BehavioralClientResult,
  BehavioralDetectorOptions,
  BehavioralSamples,
  ClickSample,
  ExtendedWindow,
  KeySample,
  MouseSample,
  ScrollSample,
  TouchSample,
} from "./types.js";

const DEFAULT_MIN_OBSERVATION_MS = 3_000;
const DEFAULT_SCORE_THRESHOLD = 0.55;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_SAMPLE_WINDOW_MS = 60_000;

/** A click counts as centred when it lands this close to an element's centre. */
const CENTERED_CLICK_TOLERANCE_PX = 1;
/** Smaller elements are too easy to hit dead-centre by chance. */
const CENTERED_CLICK_MIN_TARGET_PX = 16;
/** The target plus its nearest ancestors — automation aims at the located
 * element, which is often the parent of the text or icon actually hit. */
const CENTERED_CLICK_MAX_DEPTH = 4;

type Listener = {
  target: EventTarget;
  type: string;
  handler: EventListener;
};

/** Drops samples older than `cutoff` from the front of a time-ordered stream. */
function pruneStream(stream: Array<{ t: number }>, cutoff: number): void {
  let firstFresh = 0;
  while (firstFresh < stream.length && stream[firstFresh].t < cutoff) {
    firstFresh += 1;
  }
  if (firstFresh > 0) {
    stream.splice(0, firstFresh);
  }
}

/**
 * Whether the click landed on the centre of its target or a near ancestor —
 * where Playwright, Puppeteer, and Selenium aim by default.
 */
function isCenteredOnTarget(event: MouseEvent): boolean {
  let element = event.target as Element | null;

  for (
    let depth = 0;
    element && typeof element.getBoundingClientRect === "function" && depth < CENTERED_CLICK_MAX_DEPTH;
    depth += 1
  ) {
    const rect = element.getBoundingClientRect();
    if (
      rect.width >= CENTERED_CLICK_MIN_TARGET_PX &&
      rect.height >= CENTERED_CLICK_MIN_TARGET_PX &&
      Math.abs(event.clientX - (rect.left + rect.width / 2)) <= CENTERED_CLICK_TOLERANCE_PX &&
      Math.abs(event.clientY - (rect.top + rect.height / 2)) <= CENTERED_CLICK_TOLERANCE_PX
    ) {
      return true;
    }
    element = element.parentElement;
  }

  return false;
}

function createEmptySamples(observationMs = 0): Required<BehavioralSamples> {
  return {
    mouseMoves: [],
    scrolls: [],
    keyPresses: [],
    clicks: [],
    touches: [],
    observationMs,
  };
}

/**
 * Creates a detector that observes mouse, wheel, keyboard, click, and touch
 * events on `options.context` (defaults to `globalThis`) and scores how
 * robotic the interaction looks.
 *
 * Call `observe(ms)` for a one-shot observation, or `start()`/`stop()` +
 * `getResult()` to manage the window yourself. Pass `onUpdate` to receive
 * periodic results while observing.
 *
 * @example
 * const result = await createBehavioralClientDetector({ context: window }).observe(10_000);
 * if (!result.isLegitClient) challenge();
 */
export function createBehavioralClientDetector(
  options: BehavioralDetectorOptions = {},
): BehavioralClientDetector {
  const context = options.context ?? (globalThis as unknown as ExtendedWindow);
  const minObservationMs = options.minObservationMs ?? DEFAULT_MIN_OBSERVATION_MS;
  const scoreThreshold = options.scoreThreshold ?? DEFAULT_SCORE_THRESHOLD;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const sampleWindowMs = options.sampleWindowMs ?? DEFAULT_SAMPLE_WINDOW_MS;

  let samples = createEmptySamples();
  let startedAt: number | undefined;
  let listeners: Listener[] = [];
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let isActive = false;
  let observeTimer: ReturnType<typeof setTimeout> | undefined;
  let observeResolve: ((result: BehavioralClientResult) => void) | undefined;
  // Event timestamps, not Date.now(): a scripted press and release land well
  // inside one millisecond.
  let pressStartedAt: number | undefined;
  let lastPressMs: number | undefined;
  let lastPointerPosition: { x: number; y: number } | undefined;

  const pruneRetainedSamples = (now = Date.now()): void => {
    if (!Number.isFinite(sampleWindowMs)) {
      return;
    }

    const cutoff = now - sampleWindowMs;
    pruneStream(samples.mouseMoves, cutoff);
    pruneStream(samples.scrolls, cutoff);
    pruneStream(samples.keyPresses, cutoff);
    pruneStream(samples.clicks, cutoff);
    pruneStream(samples.touches, cutoff);
  };

  const record = <T extends { t: number }>(stream: T[], sample: T): void => {
    stream.push(sample);
    pruneRetainedSamples(sample.t);
  };

  const getObservationMs = (): number => {
    if (startedAt === undefined) {
      return samples.observationMs;
    }

    return samples.observationMs + (Date.now() - startedAt);
  };

  const evaluate = (): BehavioralClientResult => {
    if (isActive) {
      pruneRetainedSamples();
    }

    return analyzeBehavioralSamples(
      {
        ...samples,
        observationMs: getObservationMs(),
      },
      scoreThreshold,
    );
  };

  const addListener = (
    target: EventTarget,
    type: string,
    handler: EventListener,
  ): void => {
    target.addEventListener(type, handler, { passive: true });
    listeners.push({ target, type, handler });
  };

  // Chromium fires `pointermove` just before each `mousemove`, carrying the
  // fractional position that `MouseEvent.clientX/Y` truncates away.
  const onPointerMove = (event: Event): void => {
    const pointerEvent = event as PointerEvent;
    lastPointerPosition =
      pointerEvent.pointerType === "mouse"
        ? { x: pointerEvent.clientX, y: pointerEvent.clientY }
        : undefined;
  };

  const onMouseMove = (event: Event): void => {
    const mouseEvent = event as MouseEvent;
    const pointer = lastPointerPosition;
    lastPointerPosition = undefined;
    const precise =
      pointer &&
      Math.abs(pointer.x - mouseEvent.clientX) < 1 &&
      Math.abs(pointer.y - mouseEvent.clientY) < 1
        ? { preciseX: pointer.x, preciseY: pointer.y }
        : {};
    record<MouseSample>(samples.mouseMoves, {
      x: mouseEvent.clientX,
      y: mouseEvent.clientY,
      ...precise,
      movementX: mouseEvent.movementX,
      movementY: mouseEvent.movementY,
      pageX: mouseEvent.pageX,
      pageY: mouseEvent.pageY,
      screenX: mouseEvent.screenX,
      screenY: mouseEvent.screenY,
      isFullscreen: context.outerHeight - context.innerHeight <= 1,
      t: Date.now(),
      isTrusted: mouseEvent.isTrusted,
    });
  };

  const onWheel = (event: Event): void => {
    const wheelEvent = event as WheelEvent;
    record<ScrollSample>(samples.scrolls, {
      deltaY: wheelEvent.deltaY,
      t: Date.now(),
      isTrusted: wheelEvent.isTrusted,
    });
  };

  const onKeyDown = (event: Event): void => {
    const keyboardEvent = event as KeyboardEvent;
    record<KeySample>(samples.keyPresses, {
      t: Date.now(),
      isTrusted: keyboardEvent.isTrusted,
      repeat: keyboardEvent.repeat,
    });
  };

  const onMouseDown = (event: Event): void => {
    pressStartedAt = event.timeStamp;
    lastPressMs = undefined;
  };

  const onMouseUp = (event: Event): void => {
    lastPressMs =
      pressStartedAt === undefined ? undefined : event.timeStamp - pressStartedAt;
    pressStartedAt = undefined;
  };

  const onClick = (event: Event): void => {
    const mouseEvent = event as MouseEvent;
    const pressMs = lastPressMs;
    lastPressMs = undefined;
    record<ClickSample>(samples.clicks, {
      ...(pressMs === undefined ? {} : { pressMs }),
      isTargetCentered: isCenteredOnTarget(mouseEvent),
      x: mouseEvent.clientX,
      y: mouseEvent.clientY,
      t: Date.now(),
      isTrusted: mouseEvent.isTrusted,
      detail: mouseEvent.detail,
      pageX: mouseEvent.pageX,
      pageY: mouseEvent.pageY,
      screenX: mouseEvent.screenX,
      screenY: mouseEvent.screenY,
      isFullscreen: context.outerHeight - context.innerHeight <= 1,
    });
  };

  /**
   * Every touch is recorded, so tap-driven clicks stay exempt and untrusted
   * events still count as synthetic. Coordinates are attached only for
   * single-finger activity: pinch and rotate interleave contacts from several
   * fingers, which would read as one point jumping between them. Samples
   * without coordinates are skipped by the gesture heuristics.
   */
  const recordTouch = (event: Event, kind: "start" | "move"): void => {
    const touchEvent = event as TouchEvent;
    const point =
      touchEvent.touches?.length === 1
        ? touchEvent.changedTouches?.[0]
        : undefined;
    record<TouchSample>(samples.touches, {
      t: Date.now(),
      isTrusted: touchEvent.isTrusted,
      kind,
      ...(point ? { x: point.clientX, y: point.clientY } : {}),
    });
  };

  const onTouchStart = (event: Event): void => {
    recordTouch(event, "start");
  };

  const onTouchMove = (event: Event): void => {
    recordTouch(event, "move");
  };

  const start = (): void => {
    if (isActive) {
      return;
    }

    isActive = true;
    startedAt = Date.now();
    addListener(context, "pointermove", onPointerMove);
    addListener(context, "mousemove", onMouseMove);
    addListener(context, "wheel", onWheel);
    addListener(context, "keydown", onKeyDown);
    addListener(context, "mousedown", onMouseDown);
    addListener(context, "mouseup", onMouseUp);
    addListener(context, "click", onClick);
    addListener(context, "touchstart", onTouchStart);
    addListener(context, "touchmove", onTouchMove);

    if (options.onUpdate) {
      pollTimer = setInterval(() => {
        options.onUpdate?.(evaluate());
      }, pollIntervalMs);
    }
  };

  const settleObservation = (): void => {
    if (!observeResolve) {
      return;
    }

    const resolve = observeResolve;
    observeResolve = undefined;

    if (observeTimer !== undefined) {
      clearTimeout(observeTimer);
      observeTimer = undefined;
    }

    resolve(evaluate());
  };

  const stop = (): void => {
    if (!isActive) {
      return;
    }

    pruneRetainedSamples();
    isActive = false;
    samples.observationMs = getObservationMs();
    startedAt = undefined;

    for (const listener of listeners) {
      listener.target.removeEventListener(listener.type, listener.handler);
    }

    listeners = [];

    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = undefined;
    }

    settleObservation();
  };

  const reset = (): void => {
    stop();
    samples = createEmptySamples();
    startedAt = undefined;
  };

  const getResult = (): BehavioralClientResult => evaluate();

  const observe = (
    durationMs = minObservationMs,
  ): Promise<BehavioralClientResult> => {
    if (observeResolve) {
      return Promise.reject(
        new Error(
          "createBehavioralClientDetector: an observation is already in progress",
        ),
      );
    }

    start();

    return new Promise<BehavioralClientResult>((resolve) => {
      observeResolve = resolve;
      observeTimer = setTimeout(stop, durationMs);
    });
  };

  return {
    start,
    stop,
    reset,
    getResult,
    observe,
  };
}

export {
  aggregateSuspicionScore,
  analyzeBehavioralSamples,
  resolveConfidence,
} from "./scoring.js";
export {
  buildBehavioralSignals,
  hasCdpInputCoordinateLeak,
  hasCenteredClicks,
  hasClickWithoutMouseMovement,
  hasInstantClickPress,
  hasInterpolatedMouseMovement,
  hasLinearMouseMovement,
  hasLinearScroll,
  hasLinearTapRhythm,
  hasLinearTouchMovement,
  hasLinearTyping,
  hasNoMouseActivity,
  hasSyntheticEvents,
  hasTeleportMouse,
  hasTeleportTouch,
  hasZeroMouseMovementDeltas,
} from "./analysis.js";
