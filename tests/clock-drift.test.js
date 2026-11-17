import test from 'node:test';
import assert from 'node:assert/strict';
import { Cluster } from './helpers/cluster.js';

const TTL = 1000;
const MARGIN = 250;
const SKEW = 200;

test('候选者时钟偏快：安全余量内本地先放弃，不会带着过期租约写入', () => {
  // A 的时钟走速是服务端的 1.2 倍。
  const cluster = new Cluster(5, ['A'], {
    ttlMs: TTL,
    safetyMarginMs: MARGIN,
    maxClockSkewMs: SKEW,
    clockRates: { A: 1.2 },
  });

  const elected = cluster.elect('A');
  assert.equal(elected.acquired, true);
  const lock = cluster.locks.get('A');

  // 虚拟时间推进 600ms：服务端 600ms，A 本地 720ms。
  cluster.advance(600);
  // 本地剩余 = 1000 - 250 - 720 = 30ms，仍有效。
  assert.equal(lock.isOwner(), true);

  cluster.advance(30); // A 本地 756ms，已越过本地有效期 750ms
  assert.equal(lock.isOwner(), false);
  // 服务端视角授予仍有效（630 < 800），但 A 已保守退出，杜绝过期写入。
  const counts = cluster.activeTermCounts();
  assert.equal(counts.get(1), 5);
});

test('候选者时钟偏慢：租约起点相对服务端来自未来，超出偏差上限被拒绝', () => {
  const cluster = new Cluster(5, ['A'], {
    ttlMs: TTL,
    safetyMarginMs: MARGIN,
    maxClockSkewMs: SKEW,
    clockOffsets: { A: 300 }, // A 的时钟落后 voter 300ms，其“现在”在 voter 看来是未来
  });

  const result = cluster.elect('A');
  assert.equal(result.acquired, false);
  assert.ok(
    result.responses.every((r) => r.granted === false && r.reason === 'lease-start-in-future')
  );
  assert.equal(cluster.locks.get('A').isOwner(), false);
});

test('偏差落在安全余量内：选举与续期正常，本地有效期保守缩短', () => {
  const cluster = new Cluster(5, ['A'], {
    ttlMs: TTL,
    safetyMarginMs: MARGIN,
    maxClockSkewMs: SKEW,
    clockRates: { A: 1.1 }, // 漂移速率有界
  });

  assert.equal(cluster.elect('A').acquired, true);

  cluster.advance(400);
  const renewal = cluster.renew('A');
  assert.equal(renewal.renewed, true);
  assert.equal(cluster.locks.get('A').isOwner(), true);

  // 续期后本地租约按新起点重新计算。
  cluster.advance(600); // A 本地已走 660ms
  assert.equal(cluster.locks.get('A').isOwner(), true); // 1000-250-660 > 0
  cluster.advance(100); // A 本地 770ms
  assert.equal(cluster.locks.get('A').isOwner(), false);
  cluster.assertAtMostOneOwner();
});

test('安全余量必须覆盖声明的时钟漂移上限，配置非法时快速失败', () => {
  assert.throws(
    () =>
      new Cluster(3, ['A'], {
        ttlMs: TTL,
        safetyMarginMs: 50,
        maxClockSkewMs: 200,
      }),
    /maxClockSkewMs/
  );
});
