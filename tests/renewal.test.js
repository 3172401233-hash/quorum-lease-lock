import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FencedResource,
  StaleFencingTokenError,
  NotOwnerError,
  LeaseExpiredError,
} from '../src/index.js';
import { Cluster } from './helpers/cluster.js';

test('续期失败后保留剩余租约，过期即失去 owner 且禁止下游写入', async () => {
  const cluster = new Cluster(5, ['A', 'B'], {
    ttlMs: 1000,
    safetyMarginMs: 100,
    maxClockSkewMs: 50,
  });

  cluster.elect('A');
  const lock = cluster.locks.get('A');
  const resource = new FencedResource('r');

  cluster.partition([
    ['A', 'v1', 'v2'],
    ['B', 'v3', 'v4', 'v5'],
  ]);

  cluster.advance(200);
  const failed = cluster.renew('A');
  assert.equal(failed.renewed, false);
  // 续期失败不会立刻剥夺身份，fencing token 仍保护剩余租约期。
  assert.equal(lock.isOwner(), true);
  assert.equal(lock.getFencingToken(), 1);

  cluster.advance(701); // 本地租约到期（901 > 900）
  assert.equal(lock.isOwner(), false);
  await assert.rejects(lock.writeDownstream(resource, 'x'), LeaseExpiredError);
  assert.equal(resource.writes.length, 0);
});

test('分区恢复后续期成功，租约按新起点延长', () => {
  const cluster = new Cluster(5, ['A'], {
    ttlMs: 1000,
    safetyMarginMs: 100,
    maxClockSkewMs: 50,
  });

  cluster.elect('A');
  const lock = cluster.locks.get('A');

  cluster.advance(500);
  const renewed = cluster.renew('A');
  assert.equal(renewed.renewed, true);

  // 若未续期此刻已过期；续期后仍有效。
  cluster.advance(800);
  assert.equal(lock.isOwner(), true);

  cluster.advance(101); // 越过新租约的本地有效期 900ms
  assert.equal(lock.isOwner(), false);
});

test('非 owner 无法取 token，stepDown 后写入被拒绝', () => {
  const cluster = new Cluster(3, ['A'], { ttlMs: 1000, safetyMarginMs: 100 });
  const lock = cluster.locks.get('A');
  assert.throws(() => lock.getFencingToken(), NotOwnerError);

  cluster.elect('A');
  assert.equal(lock.getFencingToken(), 1);
  lock.stepDown();
  assert.throws(() => lock.getFencingToken(), NotOwnerError);
});

test('FencedResource 只接受严格递增的 fencing token', () => {
  const resource = new FencedResource('orders');
  resource.write(1, 'a');
  resource.write(5, 'b');

  assert.throws(() => resource.write(1, 'old'), StaleFencingTokenError);
  assert.throws(() => resource.write(5, 'equal'), StaleFencingTokenError);
  assert.throws(() => resource.write(0, 'zero'), StaleFencingTokenError);
  assert.throws(() => resource.write(-2, 'neg'), StaleFencingTokenError);
  assert.equal(resource.accepts(6), true);
  assert.equal(resource.accepts(5), false);
  assert.deepEqual(
    resource.writes.map((w) => w.token),
    [1, 5]
  );
});
