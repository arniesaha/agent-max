import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { createRequire } from 'module';
import { BasicTracerProvider, SimpleSpanProcessor, InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { SpanStatusCode } from '@opentelemetry/api';
import { AgentWeaveConfig, PROV_ACTIVITY_TYPE, ACTIVITY_AGENT_TURN, ACTIVITY_TOOL_CALL, PROV_AGENT_ID, PROV_WAS_ASSOCIATED_WITH } from 'agentweave';

// Resolve @opentelemetry/api from agentweave's perspective so we register the
// provider on the same global singleton that agentweave's withSpan/traceTool use.
// (agent-max and agentweave ship different @opentelemetry/api versions.)
const require = createRequire(import.meta.url);
const agentweaveApiPath = require.resolve('@opentelemetry/api', {
  paths: [require.resolve('agentweave')],
});
const otelApi = await import(agentweaveApiPath);

const contextManager = new AsyncLocalStorageContextManager();
const provider = new BasicTracerProvider();
const exporter = new InMemorySpanExporter();
provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
// Register context manager on the local API and the provider on agentweave's API
otelApi.context.setGlobalContextManager(contextManager);
otelApi.trace.setGlobalTracerProvider(provider);

// Mock the logger to avoid side effects
jest.unstable_mockModule('../src/logger.js', () => ({
  log: jest.fn(),
}));

const { initTracing, traceTools, traceAgentTurn } = await import('../src/tracing.js');

beforeEach(() => {
  exporter.reset();
  AgentWeaveConfig.enabled = false;
  delete process.env.AGENTWEAVE_OTLP_ENDPOINT;
  delete process.env.DEFAULT_MODEL;
});

// ── initTracing ──────────────────────────────────────────────────────

describe('initTracing', () => {
  it('keeps tracing disabled when AGENTWEAVE_OTLP_ENDPOINT is not set', () => {
    initTracing();
    expect(AgentWeaveConfig.enabled).toBe(false);
  });

  it('initialises config when AGENTWEAVE_OTLP_ENDPOINT is set', () => {
    // We can't call the real setup() because it starts NodeSDK + OTLP exporter.
    // Instead, verify initTracing reads env and calls setup with correct args.
    const setupSpy = jest.spyOn(AgentWeaveConfig, 'setup').mockImplementation(() => {
      AgentWeaveConfig.enabled = true;
    });

    process.env.AGENTWEAVE_OTLP_ENDPOINT = 'http://localhost:4318';
    process.env.DEFAULT_MODEL = 'gpt-4o';
    initTracing();

    expect(setupSpy).toHaveBeenCalledWith({
      agentId: 'max-v1',
      agentModel: 'gpt-4o',
      otlpEndpoint: 'http://localhost:4318/v1/traces',
      capturesInput: false,
      capturesOutput: false,
    });
    expect(AgentWeaveConfig.enabled).toBe(true);

    setupSpy.mockRestore();
  });
});

// ── traceTools ───────────────────────────────────────────────────────

describe('traceTools', () => {
  const makeTool = (name: string, executeFn?: (...args: any[]) => any) => ({
    name,
    label: name,
    description: `${name} tool`,
    parameters: {},
    execute: executeFn ?? jest.fn<(...args: any[]) => Promise<string>>().mockResolvedValue(`${name}-result`),
  }) as any;

  it('returns tools unchanged when tracing is disabled', () => {
    const tools = [makeTool('read'), makeTool('write')];
    const result = traceTools(tools);

    expect(result).toBe(tools); // same array reference
    expect(result[0].execute).toBe(tools[0].execute); // same function reference
  });

  it('creates a span with tool.<name> and ACTIVITY_TOOL_CALL when enabled', async () => {
    AgentWeaveConfig.enabled = true;
    AgentWeaveConfig.agentId = 'max-v1';

    const tools = [makeTool('read')];
    const wrapped = traceTools(tools);

    expect(wrapped[0].execute).not.toBe(tools[0].execute);
    await (wrapped[0].execute as any)('call-1', {});

    const spans = exporter.getFinishedSpans();
    const toolSpan = spans.find(s => s.name === 'tool.read');
    expect(toolSpan).toBeDefined();
    expect(toolSpan!.attributes[PROV_ACTIVITY_TYPE]).toBe(ACTIVITY_TOOL_CALL);
  });

  it('records error and re-throws when tool execute fails', async () => {
    AgentWeaveConfig.enabled = true;
    AgentWeaveConfig.agentId = 'max-v1';

    const error = new Error('disk full');
    const tools = [makeTool('write', () => { throw error; })];
    const wrapped = traceTools(tools);

    expect(() => (wrapped[0].execute as any)()).toThrow('disk full');

    const spans = exporter.getFinishedSpans();
    const toolSpan = spans.find(s => s.name === 'tool.write');
    expect(toolSpan).toBeDefined();
    expect(toolSpan!.status.code).toBe(SpanStatusCode.ERROR);

    const exceptionEvent = toolSpan!.events.find(e => e.name === 'exception');
    expect(exceptionEvent).toBeDefined();
  });

  it('wraps all tools in the array', async () => {
    AgentWeaveConfig.enabled = true;
    AgentWeaveConfig.agentId = 'max-v1';

    const tools = [makeTool('read'), makeTool('write'), makeTool('shell')];
    const wrapped = traceTools(tools);

    expect(wrapped).toHaveLength(3);
    for (let i = 0; i < wrapped.length; i++) {
      expect(wrapped[i].name).toBe(tools[i].name);
      expect(wrapped[i].execute).not.toBe(tools[i].execute);
    }

    await (wrapped[0].execute as any)('c1', {});
    await (wrapped[1].execute as any)('c2', {});
    await (wrapped[2].execute as any)('c3', {});

    const names = exporter.getFinishedSpans().map(s => s.name);
    expect(names).toContain('tool.read');
    expect(names).toContain('tool.write');
    expect(names).toContain('tool.shell');
  });
});

// ── traceAgentTurn ───────────────────────────────────────────────────

describe('traceAgentTurn', () => {
  it('runs fn() without creating a span when tracing is disabled', async () => {
    const fn = jest.fn<() => Promise<string>>().mockResolvedValue('done');
    const result = await traceAgentTurn('test-turn', fn);

    expect(result).toBe('done');
    expect(fn).toHaveBeenCalled();
    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });

  it('creates agent.<name> span with PROV attributes when enabled', async () => {
    AgentWeaveConfig.enabled = true;
    AgentWeaveConfig.agentId = 'max-v1';

    await traceAgentTurn('planning', async () => 'plan-result');

    const spans = exporter.getFinishedSpans();
    const agentSpan = spans.find(s => s.name === 'agent.planning');
    expect(agentSpan).toBeDefined();
    expect(agentSpan!.attributes[PROV_ACTIVITY_TYPE]).toBe(ACTIVITY_AGENT_TURN);
    expect(agentSpan!.attributes[PROV_AGENT_ID]).toBe('max-v1');
    expect(agentSpan!.attributes[PROV_WAS_ASSOCIATED_WITH]).toBe('max-v1');
  });

  it('wraps async functions correctly and returns their result', async () => {
    AgentWeaveConfig.enabled = true;
    AgentWeaveConfig.agentId = 'max-v1';

    const result = await traceAgentTurn('compute', async () => {
      await new Promise(r => setTimeout(r, 10));
      return 42;
    });

    expect(result).toBe(42);
    expect(exporter.getFinishedSpans().find(s => s.name === 'agent.compute')).toBeDefined();
  });

  it('records exception and re-throws on error', async () => {
    AgentWeaveConfig.enabled = true;
    AgentWeaveConfig.agentId = 'max-v1';

    await expect(
      traceAgentTurn('failing', async () => { throw new Error('boom'); })
    ).rejects.toThrow('boom');

    const spans = exporter.getFinishedSpans();
    const span = spans.find(s => s.name === 'agent.failing');
    expect(span).toBeDefined();
    // withSpan records the exception but does not set status code
    expect(span!.events.find(e => e.name === 'exception')).toBeDefined();
  });
});

// ── context propagation ──────────────────────────────────────────────

describe('context propagation', () => {
  it('tool span is a child of the agent turn span', async () => {
    AgentWeaveConfig.enabled = true;
    AgentWeaveConfig.agentId = 'max-v1';

    const tool = {
      name: 'search',
      label: 'search',
      description: 'search tool',
      parameters: {},
      execute: jest.fn<(...args: any[]) => Promise<string>>().mockResolvedValue('found'),
    } as any;
    const [wrappedTool] = traceTools([tool]);

    await traceAgentTurn('orchestrate', async () => {
      await (wrappedTool.execute as any)('call-1', {});
    });

    const spans = exporter.getFinishedSpans();
    const agentSpan = spans.find(s => s.name === 'agent.orchestrate');
    const toolSpan = spans.find(s => s.name === 'tool.search');

    expect(agentSpan).toBeDefined();
    expect(toolSpan).toBeDefined();
    expect(toolSpan!.parentSpanId).toBe(agentSpan!.spanContext().spanId);
  });

  it('nested agent turns produce correct parent chain', async () => {
    AgentWeaveConfig.enabled = true;
    AgentWeaveConfig.agentId = 'max-v1';

    await traceAgentTurn('outer', async () => {
      await traceAgentTurn('inner', async () => {
        return 'nested-result';
      });
    });

    const spans = exporter.getFinishedSpans();
    const outerSpan = spans.find(s => s.name === 'agent.outer');
    const innerSpan = spans.find(s => s.name === 'agent.inner');

    expect(outerSpan).toBeDefined();
    expect(innerSpan).toBeDefined();
    expect(innerSpan!.parentSpanId).toBe(outerSpan!.spanContext().spanId);
  });
});
