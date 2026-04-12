import worker from '../src/worker.js';

class MemoryBucket {
  constructor({ failPutKeys = [] } = {}) {
    this.store = new Map();
    this.failPutKeys = new Set(failPutKeys);
  }

  async get(key) {
    if (!this.store.has(key)) return null;

    const textValue = this.store.get(key);
    return {
      async text() {
        return textValue;
      },
      async json() {
        return JSON.parse(textValue);
      },
      body: new Response(textValue).body,
    };
  }

  async put(key, value) {
    if (this.failPutKeys.has(key)) {
      throw new Error(`simulated put failure for ${key}`);
    }

    const textValue = typeof value === 'string' ? value : await new Response(value).text();
    this.store.set(key, textValue);
  }

  async delete(key) {
    this.store.delete(key);
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function flushWaitUntil(waiters) {
  await Promise.all(waiters.splice(0).map(promise => Promise.resolve(promise)));
}

function createCtx() {
  const waiters = [];
  return {
    ctx: {
      waitUntil(promise) {
        waiters.push(promise);
      },
    },
    flush: () => flushWaitUntil(waiters),
  };
}

function getValueForRun(sequence, runIndex, fallback) {
  if (Array.isArray(sequence)) {
    if (sequence.length === 0) return fallback;
    return sequence[Math.min(runIndex, sequence.length - 1)];
  }

  return sequence ?? fallback;
}

function createJsonTextResponse(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return JSON.stringify(data);
    },
  };
}

function createStalledTextResponse(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return new Promise(() => {});
    },
  };
}

function createFetchMock({
  healthStatuses = [503],
  healthErrorsAtRuns = [],
  runtimeStages = ['RUNTIME_ERROR'],
  runtimeStatuses = [200],
  runtimeProbeErrorsAtRuns = [],
  runtimeBodyTimeoutAtRuns = [],
  restartStatuses = [200],
  restartStages = ['BUILDING'],
} = {}) {
  let restartCalls = 0;
  let etymologyHealthChecks = 0;

  const healthErrorRuns = new Set(healthErrorsAtRuns);
  const runtimeProbeErrorRuns = new Set(runtimeProbeErrorsAtRuns);
  const runtimeBodyTimeoutRuns = new Set(runtimeBodyTimeoutAtRuns);

  const currentRun = () => Math.max(0, etymologyHealthChecks - 1);

  const mock = async (url) => {
    if (url === 'https://etymology.luischav.es/health') {
      const runIndex = etymologyHealthChecks;
      etymologyHealthChecks += 1;

      if (healthErrorRuns.has(runIndex)) {
        throw new Error('simulated health fetch failure');
      }

      const status = getValueForRun(healthStatuses, runIndex, 503);
      return new Response(status >= 200 && status < 400 ? 'ok' : 'unhealthy', { status });
    }

    if (url === 'https://tfl.luischav.es/' || url === 'https://api-tfl.luischav.es/latest.json') {
      return new Response('ok', { status: 200 });
    }

    if (url === 'https://huggingface.co/api/spaces/lucharo/etymology/runtime') {
      const runIndex = currentRun();

      if (runtimeProbeErrorRuns.has(runIndex)) {
        throw new Error('simulated runtime probe failure');
      }

      const status = getValueForRun(runtimeStatuses, runIndex, 200);
      const stage = getValueForRun(runtimeStages, runIndex, 'RUNTIME_ERROR');

      if (runtimeBodyTimeoutRuns.has(runIndex)) {
        return createStalledTextResponse({ stage }, status);
      }

      return createJsonTextResponse({ stage }, status);
    }

    if (url === 'https://huggingface.co/api/spaces/lucharo/etymology/restart') {
      restartCalls += 1;

      const runIndex = currentRun();
      const status = getValueForRun(restartStatuses, runIndex, 200);
      if (status < 200 || status >= 300) {
        return new Response('restart failed', { status });
      }

      const stage = getValueForRun(restartStages, runIndex, 'BUILDING');
      return createJsonTextResponse({ stage }, status);
    }

    throw new Error(`Unexpected fetch URL: ${url}`);
  };

  return {
    mock,
    getRestartCalls: () => restartCalls,
  };
}

async function runScheduledTimes(env, count) {
  const { ctx, flush } = createCtx();

  for (let i = 0; i < count; i += 1) {
    await worker.scheduled({}, env, ctx);
    await flush();
  }
}

async function readRecoveryPayload(env) {
  const response = await worker.fetch(new Request('https://status.example/recovery.json'), env, {
    waitUntil() {},
  });
  assert(response.status === 200, `Expected /recovery.json to return 200, got ${response.status}`);
  return response.json();
}

async function validateRestartSuccess() {
  const env = {
    HF_TOKEN: 'fake-token',
    STATUS_BUCKET: new MemoryBucket(),
  };
  const { mock, getRestartCalls } = createFetchMock({
    healthStatuses: [503, 503, 503],
    runtimeStages: ['RUNTIME_ERROR', 'RUNTIME_ERROR', 'RUNTIME_ERROR'],
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mock;

  try {
    await runScheduledTimes(env, 3);
    const recovery = await readRecoveryPayload(env);

    assert(getRestartCalls() === 1, `Expected 1 restart attempt, got ${getRestartCalls()}`);
    assert(recovery.state.etymology.lastAttemptAt, 'Expected recovery state to record lastAttemptAt');
    assert(recovery.state.etymology.lastRestartStage === 'BUILDING', 'Expected restart stage BUILDING');
    assert(recovery.events[0]?.action === 'restart_succeeded', 'Expected latest recovery event to be restart_succeeded');
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function validateSleeping500RestartSuccess() {
  const env = {
    HF_TOKEN: 'fake-token',
    STATUS_BUCKET: new MemoryBucket(),
  };
  const { mock, getRestartCalls } = createFetchMock({
    healthStatuses: [500, 500, 500, 500],
    runtimeStages: ['SLEEPING', 'SLEEPING', 'SLEEPING', 'SLEEPING'],
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mock;

  try {
    await runScheduledTimes(env, 3);
    let recovery = await readRecoveryPayload(env);

    assert(getRestartCalls() === 0, `Expected 0 restart attempts before wake-up window ends, got ${getRestartCalls()}`);
    assert(recovery.state.etymology.matchedTriggerFailures === 2, 'Expected matched trigger failures to accumulate for 500 + SLEEPING');

    await runScheduledTimes(env, 1);
    recovery = await readRecoveryPayload(env);

    assert(getRestartCalls() === 1, `Expected 1 restart attempt for 500 + SLEEPING, got ${getRestartCalls()}`);
    assert(recovery.state.etymology.lastAttemptAt, 'Expected recovery state to record lastAttemptAt for 500 + SLEEPING');
    assert(recovery.state.etymology.lastKnownRuntimeStage === 'SLEEPING', 'Expected lastKnownRuntimeStage SLEEPING');
    assert(recovery.events[0]?.action === 'restart_succeeded', 'Expected latest recovery event to be restart_succeeded for 500 + SLEEPING');
    assert(!('matchedTriggerFailures' in recovery.state.etymology), 'Did not expect matched trigger tracking after restart');
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function validateSleeping500RecoveryClearsPendingState() {
  const env = {
    HF_TOKEN: 'fake-token',
    STATUS_BUCKET: new MemoryBucket(),
  };
  const { mock, getRestartCalls } = createFetchMock({
    healthStatuses: [500, 500, 200],
    runtimeStages: ['SLEEPING', 'SLEEPING', 'SLEEPING'],
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mock;

  try {
    await runScheduledTimes(env, 3);
    const recovery = await readRecoveryPayload(env);

    assert(getRestartCalls() === 0, `Expected 0 restart attempts when service recovers during wake-up window, got ${getRestartCalls()}`);
    assert(!('matchedTriggerFailures' in (recovery.state.etymology || {})), 'Expected pending trigger tracking to be cleared after recovery');
    assert(!('lastMatchedTriggerKey' in (recovery.state.etymology || {})), 'Expected matched trigger key to be cleared after recovery');
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function validateSleeping503DoesNotRestart() {
  const env = {
    HF_TOKEN: 'fake-token',
    STATUS_BUCKET: new MemoryBucket(),
  };
  const { mock, getRestartCalls } = createFetchMock({
    healthStatuses: [503, 503, 503],
    runtimeStages: ['SLEEPING', 'SLEEPING', 'SLEEPING'],
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mock;

  try {
    await runScheduledTimes(env, 3);
    const recovery = await readRecoveryPayload(env);

    assert(getRestartCalls() === 0, `Expected 0 restart attempts for 503 + SLEEPING, got ${getRestartCalls()}`);
    assert(!recovery.state.etymology, 'Did not expect recovery state for 503 + SLEEPING');
    assert(recovery.events.length === 0, 'Did not expect recovery events for 503 + SLEEPING');
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function validateEligibleFailuresDoNotCountEarlierTimeouts() {
  const env = {
    HF_TOKEN: 'fake-token',
    STATUS_BUCKET: new MemoryBucket(),
  };
  const { mock, getRestartCalls } = createFetchMock({
    healthStatuses: [503, 503, 503, 503],
    healthErrorsAtRuns: [0, 1],
    runtimeStages: ['RUNTIME_ERROR', 'RUNTIME_ERROR', 'RUNTIME_ERROR', 'RUNTIME_ERROR'],
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mock;

  try {
    await runScheduledTimes(env, 3);
    let recovery = await readRecoveryPayload(env);

    assert(getRestartCalls() === 0, `Expected 0 restart attempts after the first eligible 503, got ${getRestartCalls()}`);
    assert(recovery.state.etymology.matchedTriggerFailures === 1, 'Expected only one matched 503 + RUNTIME_ERROR failure after prior timeouts');

    await runScheduledTimes(env, 1);
    recovery = await readRecoveryPayload(env);

    assert(getRestartCalls() === 1, `Expected restart after two trigger-eligible 503 failures, got ${getRestartCalls()}`);
    assert(recovery.events[0]?.action === 'restart_succeeded', 'Expected restart_succeeded after two trigger-eligible 503 failures');
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function validateProbeFailureDoesNotBurnCooldown() {
  const env = {
    HF_TOKEN: 'fake-token',
    STATUS_BUCKET: new MemoryBucket(),
  };
  const { mock, getRestartCalls } = createFetchMock({
    healthStatuses: [503, 503],
    runtimeProbeErrorsAtRuns: [1],
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mock;

  try {
    await runScheduledTimes(env, 2);
    const recovery = await readRecoveryPayload(env);

    assert(getRestartCalls() === 0, `Expected 0 restart attempts, got ${getRestartCalls()}`);
    assert(recovery.state.etymology.lastProbeFailureAt, 'Expected probe failure timestamp to be recorded');
    assert(!recovery.state.etymology.lastAttemptAt, 'Did not expect lastAttemptAt after a probe failure');
    assert(recovery.events[0]?.action === 'runtime_probe_failed', 'Expected latest recovery event to be runtime_probe_failed');
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function validateRuntimeJsonTimeoutDoesNotBurnCooldown() {
  const env = {
    HF_TOKEN: 'fake-token',
    STATUS_BUCKET: new MemoryBucket(),
  };
  const { mock, getRestartCalls } = createFetchMock({
    healthStatuses: [503, 503],
    runtimeBodyTimeoutAtRuns: [1],
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mock;

  try {
    await runScheduledTimes(env, 2);
    const recovery = await readRecoveryPayload(env);

    assert(getRestartCalls() === 0, `Expected 0 restart attempts after runtime body timeout, got ${getRestartCalls()}`);
    assert(recovery.state.etymology.lastProbeFailureAt, 'Expected probe failure timestamp to be recorded after runtime body timeout');
    assert(recovery.state.etymology.lastError.includes('timed out while reading response body'), 'Expected lastError to describe runtime body timeout');
    assert(recovery.events[0]?.action === 'runtime_probe_failed', 'Expected latest recovery event to be runtime_probe_failed after runtime body timeout');
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function validateRestartFailurePersistsState() {
  const env = {
    HF_TOKEN: 'fake-token',
    STATUS_BUCKET: new MemoryBucket(),
  };
  const { mock, getRestartCalls } = createFetchMock({
    healthStatuses: [503, 503, 503],
    runtimeStages: ['RUNTIME_ERROR', 'RUNTIME_ERROR', 'RUNTIME_ERROR'],
    restartStatuses: [500],
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mock;

  try {
    await runScheduledTimes(env, 3);
    const recovery = await readRecoveryPayload(env);

    assert(getRestartCalls() === 1, `Expected 1 restart attempt with restart failure, got ${getRestartCalls()}`);
    assert(recovery.state.etymology.lastAttemptAt, 'Expected lastAttemptAt to persist after restart failure');
    assert(recovery.state.etymology.lastError.includes('HF restart HTTP 500'), 'Expected lastError to persist restart failure details');
    assert(recovery.events[0]?.action === 'restart_failed', 'Expected latest recovery event to be restart_failed');
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function validateEventLogFailureDoesNotBlockState() {
  const env = {
    HF_TOKEN: 'fake-token',
    STATUS_BUCKET: new MemoryBucket({ failPutKeys: ['recovery-events.json'] }),
  };
  const { mock, getRestartCalls } = createFetchMock({
    healthStatuses: [503, 503, 503],
    runtimeStages: ['RUNTIME_ERROR', 'RUNTIME_ERROR', 'RUNTIME_ERROR'],
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mock;

  try {
    await runScheduledTimes(env, 3);
    const recovery = await readRecoveryPayload(env);

    assert(getRestartCalls() === 1, `Expected 1 restart attempt even when event logging fails, got ${getRestartCalls()}`);
    assert(recovery.state.etymology.lastAttemptAt, 'Expected recovery state to persist even when recovery-events.json write fails');
    assert(recovery.events.length === 0, 'Expected no recovery events when event logging fails');
  } finally {
    globalThis.fetch = originalFetch;
  }
}

await validateRestartSuccess();
await validateSleeping500RestartSuccess();
await validateSleeping500RecoveryClearsPendingState();
await validateSleeping503DoesNotRestart();
await validateEligibleFailuresDoNotCountEarlierTimeouts();
await validateProbeFailureDoesNotBurnCooldown();
await validateRuntimeJsonTimeoutDoesNotBurnCooldown();
await validateRestartFailurePersistsState();
await validateEventLogFailureDoesNotBlockState();

console.log('Recovery validation passed.');
