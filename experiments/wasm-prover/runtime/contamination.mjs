export function createContaminationTracker(threshold) {
  if (!Number.isSafeInteger(threshold) || threshold <= 0) {
    throw new Error("contamination threshold must be a positive integer");
  }
  return {
    threshold,
    consecutive: 0,
    maxConsecutive: 0,
    contaminated: false,
    streakReasons: [],
    confirmedReasons: [],
    observedReasons: [],
  };
}

export function observeContamination(tracker, reasons) {
  const observed = [...new Set((reasons || []).filter(Boolean))];
  tracker.observedReasons.push(...observed);
  if (observed.length === 0) {
    tracker.consecutive = 0;
    tracker.streakReasons = [];
    return tracker;
  }
  tracker.consecutive += 1;
  tracker.maxConsecutive = Math.max(
    tracker.maxConsecutive,
    tracker.consecutive,
  );
  tracker.streakReasons.push(...observed);
  if (tracker.consecutive >= tracker.threshold) {
    tracker.contaminated = true;
    tracker.confirmedReasons.push(...tracker.streakReasons);
  }
  return tracker;
}

export function evaluateContamination(observations, threshold) {
  const tracker = createContaminationTracker(threshold);
  for (const reasons of observations) observeContamination(tracker, reasons);
  return contaminationSnapshot(tracker);
}

export function contaminationSnapshot(tracker) {
  return {
    contaminated: tracker.contaminated,
    consecutive: tracker.consecutive,
    maxConsecutive: tracker.maxConsecutive,
    confirmedReasons: [...new Set(tracker.confirmedReasons)],
    observedReasons: [...new Set(tracker.observedReasons)],
  };
}
