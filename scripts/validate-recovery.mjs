import worker from '../src/worker.js';

class MemoryBucket {
  constructor() {
    this.store = new Map();
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

function createFetchMock({ failRuntimeProbe = false } = {}) {
  let restartCalls = 0;

  const mock = async (url) => {
    if (url === 'https://etymology.luischav.es/health') {
      return new Response('unhealthy', { status: 503 });
    }

    if (url === 'https://tfl.luischav.es/' || url === 'https://api-tfl.luischav.es/latest.json') {
      return new Response('ok', { status: 200 });
    }

    if (url === 'https://huggingface.co/api/spaces/lucharo/etymology/runtime') {
      if (failRuntimeProbe) {
        throw new Error('simulated runtime probe failure');
      }
      return Response.json({ stage: 'RUNTIME_ERROR' });
    }

    if (url === 'https://huggingface.co/api/spaces/lucharo/etymology/restart') {
      restartCalls += 1;
      return Response.json({ stage: 'BUILDING' });
    }

    throw new Error(`Unexpected fetch URL: ${url}`);
  };

  return {
    mock,
    getRestartCalls: () => restartCalls,
  };
}

async function runScheduledTwice(env) {
  const { ctx, flush } = createCtx();
  await worker.scheduled({}, env, ctx);
  await flush();
  await worker.scheduled({}, env, ctx);
  await flush();
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
  const { mock, getRestartCalls } = createFetchMock();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mock;

  try {
    await runScheduledTwice(env);
    const recovery = await readRecoveryPayload(env);

    assert(getRestartCalls() === 1, `Expected 1 restart attempt, got ${getRestartCalls()}`);
    assert(recovery.state.etymology.lastAttemptAt, 'Expected recovery state to record lastAttemptAt');
    assert(recovery.state.etymology.lastRestartStage === 'BUILDING', 'Expected restart stage BUILDING');
    assert(recovery.events[0]?.action === 'restart_succeeded', 'Expected latest recovery event to be restart_succeeded');
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function validateProbeFailureDoesNotBurnCooldown() {
  const env = {
    HF_TOKEN: 'fake-token',
    STATUS_BUCKET: new MemoryBucket(),
  };
  const { mock, getRestartCalls } = createFetchMock({ failRuntimeProbe: true });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mock;

  try {
    await runScheduledTwice(env);
    const recovery = await readRecoveryPayload(env);

    assert(getRestartCalls() === 0, `Expected 0 restart attempts, got ${getRestartCalls()}`);
    assert(recovery.state.etymology.lastProbeFailureAt, 'Expected probe failure timestamp to be recorded');
    assert(!recovery.state.etymology.lastAttemptAt, 'Did not expect lastAttemptAt after a probe failure');
    assert(recovery.events[0]?.action === 'runtime_probe_failed', 'Expected latest recovery event to be runtime_probe_failed');
  } finally {
    globalThis.fetch = originalFetch;
  }
}

await validateRestartSuccess();
await validateProbeFailureDoesNotBurnCooldown();

console.log('Recovery validation passed.');
