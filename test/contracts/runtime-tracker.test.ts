import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { DeviceManifest } from '@mega-yfue/eufy-sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { CompleteDeviceSnapshot } from '../../src/device/snapshot.js';
import { RuntimeTracker, type RuntimeTrackerUpdate } from '../../src/runtime/tracker.js';

const PUBLISHED_FIELDS = ['complete', 'generation', 'snapshot', 'source', 'state', 'status', 'updatedAt', 'version'];

const SUBMITTED_PASSWORD = 'synthetic-password-must-never-be-published';
const SUBMITTED_ANSWER = 'synthetic-challenge-answer-must-never-be-published';

function manifest(): DeviceManifest {
  return {
    sn: 'synthetic-sensor',
    name: 'Synthetic Sensor',
    model: 'T8910',
    modelName: 'Synthetic Sensor',
    codec: 'sensor',
    source: 'inferred',
    bound: true,
    capabilities: ['contact'] as DeviceManifest['capabilities'],
    details: [
      {
        capability: 'contact',
        accessor: 'contact',
        reads: [{ accessor: 'open', property: 'synthetic', type: 'bool', writable: false }],
        actions: [],
        undescribedActions: [],
        events: [],
      },
    ],
  };
}

function snapshot(): CompleteDeviceSnapshot {
  return { version: 1, complete: true, devices: [manifest()] };
}

describe('runtime tracker publication', () => {
  let root: string;
  let path: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'homebridge-eufy-tracker-'));
    path = join(root, 'tracker.json');
  });

  afterEach(async () => {
    await rm(root, { force: true, recursive: true });
  });

  it('publishes exactly the closed record fields and drops caller-supplied extras', async () => {
    const tracker = new RuntimeTracker(path, 90_000, () => Date.parse('2026-08-25T12:00:00.000Z'));

    expect(
      tracker.update('ready', {
        generation: 'synthetic-generation',
        complete: true,
        snapshot: snapshot(),
        password: SUBMITTED_PASSWORD,
        answer: SUBMITTED_ANSWER,
        authToken: 'synthetic-token',
        configuration: { password: SUBMITTED_PASSWORD },
      } as RuntimeTrackerUpdate),
    ).toBe(true);

    const published = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    expect(Object.keys(published).sort()).toEqual(PUBLISHED_FIELDS);
    expect(published.state).toBe('ready');
    expect(published.status).toBe('connected');
    expect(published.complete).toBe(true);
  });

  it('never writes a credential or challenge answer into advisory runtime evidence', async () => {
    const tracker = new RuntimeTracker(path, 90_000, () => Date.parse('2026-08-25T12:00:00.000Z'));

    tracker.update('ready', {
      generation: 'synthetic-generation',
      complete: true,
      snapshot: snapshot(),
      password: SUBMITTED_PASSWORD,
      answer: SUBMITTED_ANSWER,
    } as RuntimeTrackerUpdate);
    tracker.update('degraded');
    tracker.update('authentication-required');
    tracker.update('owner-conflict');
    tracker.stop();

    const text = await readFile(path, 'utf8');
    expect(text).not.toContain(SUBMITTED_PASSWORD);
    expect(text).not.toContain(SUBMITTED_ANSWER);
    expect(text).not.toMatch(/password|credential|captcha|answer|authToken|cookie|secret/i);
  });

  it('keeps advisory runtime evidence owner-only', async () => {
    const tracker = new RuntimeTracker(join(root, 'nested', 'tracker.json'), 90_000, () =>
      Date.parse('2026-08-25T12:00:00.000Z'),
    );

    tracker.update('ready', { complete: true, snapshot: snapshot() });

    await expect(stat(join(root, 'nested')).then((info) => info.mode & 0o777)).resolves.toBe(0o700);
    await expect(stat(join(root, 'nested', 'tracker.json')).then((info) => info.mode & 0o777)).resolves.toBe(0o600);
  });

  it('retains the latest complete snapshot across a state change without republishing it as fresh', async () => {
    const tracker = new RuntimeTracker(path, 90_000, () => Date.parse('2026-08-25T12:00:00.000Z'));

    tracker.update('ready', { generation: 'synthetic-generation', complete: true, snapshot: snapshot() });
    tracker.update('stopping');

    const retained = await tracker.read();
    expect(retained?.state).toBe('stopping');
    expect(retained?.generation).toBe('synthetic-generation');
    expect(retained?.snapshot?.devices).toHaveLength(1);
    await expect(tracker.fresh()).resolves.toEqual({ state: 'stopping', updatedAt: '2026-08-25T12:00:00.000Z' });
  });
});
