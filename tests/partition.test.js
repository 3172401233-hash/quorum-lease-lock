import test from 'node:test';
import assert from 'node:assert/strict';
import { FencedResource, StaleFencingTokenError, LeaseExpiredError } from '../src/index.js';
import { Cluster } from './helpers/cluster.js';

const TTL = 1000;
const MARGIN = 100;

test('获得多数派投票才能成为 owner，少数派不行', async () => {
  const cluster = new Cluster(5, ['A', 'B'], {
    ttlMs: TTL,
    safetyMarginMs: MARGIN,
  });

  cluster.partition([
    ['A', 'v1', 'v2'],
    ['B', 'v3', 'v4', 'v5'],
  ]);

  const a = cluster.elect('A');
  assert.equal(a.acquired, false);
  assert.equal(a.votes, 2);
  assert.equal(cluster.locks.get('A').isOwner(), false);

  const b = cluster.elect('B');
  assert.equal(b.acquired, true);
  assert.equal(b.votes, 3);
  assert.equal(cluster.locks.get('B').isOwner(), true);
  cluster.assertAtMostOneOwner();
});

test('分区后旧 leader 写入被 fencing token 拦截，新 leader 独占写入', async () => {
  const cluster = new Cluster(5, ['A', 'B'], {
    ttlMs: TTL,
    safetyMarginMs: MARGIN,
  });
  const resource = new FencedResource('inventory');

  // A 在完整网络中当选 term 1。
  const first = cluster.elect('A');
  assert.equal(first.acquired, true);
  const lockA = cluster.locks.get('A');
  assert.equal(lockA.getFencingToken(), 1);

  cluster.advance(200);
  await lockA.writeDownstream(resource, { qty: 1 });
  assert.equal(resource.lastFencingToken, 1);

  // 分区：A 只剩 2 票，B 握有 3 票。
  cluster.partition([
    ['A', 'v1', 'v2'],
    ['B', 'v3', 'v4', 'v5'],
  ]);

  // A 的租约尚未到期，但 B 无法在旧租约存活期内夺权。
  cluster.advance(100);
  const blocked = cluster.elect('B');
  assert.equal(blocked.acquired, false);
  cluster.assertAtMostOneOwner();

  // A 续期失败（少数派），但本地租约内仍自以为是 owner。
  const renewal = cluster.renew('A');
  assert.equal(renewal.renewed, false);

  // 推进到 A 本地租约失效（ttl - margin = 900ms）。
  cluster.advance(601);
  assert.equal(lockA.isOwner(), false);
  await assert.rejects(
    lockA.writeDownstream(resource, { qty: 2 }),
    LeaseExpiredError
  );

  // 服务端授予在 ttl - maxClockSkew = 950ms 后才真正过期，
  // 届时 B 才能拿到多数派（v1/v2 上被续期的授予不足多数派）。
  cluster.advance(60);
  const second = cluster.elect('B');
  assert.equal(second.acquired, true);
  const lockB = cluster.locks.get('B');
  assert.equal(lockB.getFencingToken(), 2);
  await lockB.writeDownstream(resource, { qty: 3 });
  assert.equal(resource.lastFencingToken, 2);

  // 模拟 A 因 GC 停顿/时钟错觉仍持旧 token 直写下游：被 fencing 拒绝。
  assert.throws(
    () => resource.write(1, { qty: 99 }, { writer: 'A-stale' }),
    (err) => {
      assert.ok(err instanceof StaleFencingTokenError);
      assert.equal(err.rejectedToken, 1);
      assert.equal(err.seenToken, 2);
      return true;
    }
  );

  // 只有两次成功写入，不存在双写。
  assert.deepEqual(
    resource.writes.map((w) => [w.writer, w.token]),
    [['A', 1], ['B', 2]]
  );
});

test('网络恢复后 owner 恢复：重新选举并沿用单调 fencing token', async () => {
  const cluster = new Cluster(5, ['A', 'B'], {
    ttlMs: TTL,
    safetyMarginMs: MARGIN,
  });
  const resource = new FencedResource('inventory');

  cluster.elect('A');
  await cluster.locks.get('A').writeDownstream(resource, 'v1');

  cluster.partition([
    ['A', 'v1', 'v2'],
    ['B', 'v3', 'v4', 'v5'],
  ]);
  cluster.advance(950); // 跨过完整 TTL，所有 voter 上的 term1 授予均过期
  cluster.heal();

  // A 已不再是 owner，需要重新选举。
  const lockA = cluster.locks.get('A');
  assert.equal(lockA.isOwner(), false);

  const reElected = cluster.elect('A');
  assert.equal(reElected.acquired, true);
  assert.equal(lockA.getFencingToken(), 2);
  await lockA.writeDownstream(resource, 'v2');

  // term 继续单调，旧 token 永久失效。
  assert.throws(() => resource.write(1, 'stale'), StaleFencingTokenError);
  assert.equal(resource.writes.length, 2);
  cluster.assertAtMostOneOwner();
});
