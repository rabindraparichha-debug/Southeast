// Unit tests for the VROOM client used by the route-optimize Edge Function (no network).
import { describe, expect, it } from 'vitest';
import {
  buildVroomRequest,
  haversineKm,
  optimizeWithVroom,
  parseVroomOrder,
  pathKm,
  type Stop,
} from '../../supabase/functions/_shared/vroom.ts';

const kitchen = { lat: 20.3553, lng: 85.8197 };
const stops: Stop[] = [
  { id: 'a', lat: 20.3653, lng: 85.8197 },
  { id: 'b', lat: 20.3453, lng: 85.8197 },
  { id: 'c', lat: 20.3553, lng: 85.8297 },
];

describe('VROOM client', () => {
  it('measures distances like the database', () => {
    expect(haversineKm(kitchen, stops[0]!)).toBeCloseTo(1.112, 2); // 0.01° of latitude
    expect(pathKm(kitchen, [stops[0]!])).toBeCloseTo(1.45, 2); // with the 1.3 road factor
  });

  it('builds a matrix request: one vehicle from the kitchen, open route, one job per stop', () => {
    const req = buildVroomRequest(kitchen, stops);
    expect(req.vehicles).toEqual([{ id: 1, profile: 'car', start_index: 0 }]);
    expect(req.vehicles[0]!).not.toHaveProperty('end_index');
    expect(req.jobs.map((j) => j.location_index)).toEqual([1, 2, 3]);
    const d = req.matrices!.car!.durations as number[][];
    expect(d).toHaveLength(4);
    expect(d[0]![0]).toBe(0);
    expect(d[1]![2]).toBe(d[2]![1]);
    expect(d[1]![2]!).toBeGreaterThan(d[0]![1]!); // a→b is twice kitchen→a
  });

  it('builds a coordinate request when VROOM has its own router', () => {
    const req = buildVroomRequest(kitchen, stops, { useRouting: true });
    expect(req.vehicles[0]!.start).toEqual([kitchen.lng, kitchen.lat]);
    expect(req.jobs[1]!.location).toEqual([stops[1]!.lng, stops[1]!.lat]);
    expect(req.matrices).toBeUndefined();
  });

  it('reads the visiting order and rejects incomplete answers', () => {
    const ok = { code: 0, routes: [{ vehicle: 1, steps: [{ type: 'start' }, { type: 'job', job: 3 }, { type: 'job', job: 1 }, { type: 'job', job: 2 }] }] };
    expect(parseVroomOrder(ok, stops)).toEqual(['c', 'a', 'b']);
    expect(() => parseVroomOrder({ code: 2, error: 'bad input' }, stops)).toThrow(/vroom_error/);
    expect(() => parseVroomOrder({ ...ok, unassigned: [{ id: 2 }] }, stops)).toThrow(/vroom_unassigned/);
    expect(() =>
      parseVroomOrder({ code: 0, routes: [{ vehicle: 1, steps: [{ type: 'job', job: 1 }] }] }, stops),
    ).toThrow(/vroom_incomplete/);
  });

  it('posts to the VROOM server and returns stop ids', async () => {
    let sent: { jobs: unknown[] } | undefined;
    const fetchFn = (async (_url: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ code: 0, routes: [{ vehicle: 1, steps: [{ type: 'job', job: 2 }, { type: 'job', job: 1 }, { type: 'job', job: 3 }] }] }));
    }) as unknown as typeof fetch;
    expect(await optimizeWithVroom('http://vroom:3000', kitchen, stops, { fetchFn })).toEqual(['b', 'a', 'c']);
    expect(sent?.jobs).toHaveLength(3);
  });

  it('fails loudly on an HTTP error so the caller can fall back to the built-in optimiser', async () => {
    const fetchFn = (async () => new Response('down', { status: 503 })) as unknown as typeof fetch;
    await expect(optimizeWithVroom('http://vroom:3000', kitchen, stops, { fetchFn })).rejects.toThrow('vroom_http_503');
  });
});
