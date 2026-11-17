import test from 'node:test';
import assert from 'node:assert/strict';
import { FencedResource, StaleFencingTokenError } from '../src/index.js';
import { Cluster, mulberry32 } from './helpers/cluster.js';

test('随机混合故障下：任意时刻最多一个多数派 owner，成功写入 token 严格递增', async () => {
  const TTL = 1000;
  const random = mulberry32(20261117);
  const cluster = new Cluster(5, ['A', 'B'], {
    ttlMs: TTL,
    safetyMarginMs: 120,
    maxClockSkewMs: 60,
    clockRates: { A: 1.02, B: 0.98 },
    clockOffsets: { A: 10, B: -10 },
  });
  const resource = new FencedResource('shared');
  const candidates = ['A', 'B'];
  let partitioned = false;

  for (let step = 0; step < 300; step += 1) {
    const roll = random();

    if (roll < 0.2 && !partitioned) {
      // 随机二选一的分区切法。
      if (random() < 0.5) {
        cluster.partition([
          ['A', 'v1', 'v2'],
          ['B', 'v3', 'v4', 'v5'],
        ]);
      } else {
        cluster.partition([
          ['A', 'v1', 'v2', 'v3'],
          ['B', 'v4', 'v5'],
        ]);
      }
      partitioned = true;
    } else if (roll < 0.3 && partitioned) {
      cluster.heal();
      partitioned = false;
    } else if (roll < 0.6) {
      const id = candidates[Math.floor(random() * candidates.length)];
      cluster.elect(id);
    } else if (roll < 0.8) {
      const id = candidates[Math.floor(random() * candidates.length)];
      if (cluster.locks.get(id).isOwner()) {
        cluster.renew(id);
      }
    }

    // 每个有效 owner 尝试下游写入：要么成功且 token 更大，要么被 fencing 拒绝。
    for (const id of candidates) {
      const lock = cluster.locks.get(id);
      if (lock.isOwner()) {
        try {
          await lock.writeDownstream(resource, { step, id });
        } catch (err) {
          assert.ok(err instanceof StaleFencingTokenError);
        }
      }
    }

    cluster.advance(40 + Math.floor(random() * 120));
    cluster.assertAtMostOneOwner();

    // 资源侧二次确认：成功写入的 token 序列严格递增、无重复。
    const tokens = resource.writes.map((w) => w.token);
    for (let i = 1; i < tokens.length; i += 1) {
      assert.ok(tokens[i] > tokens[i - 1], 'fencing token 必须严格递增');
    }
  }

  cluster.heal();
  cluster.assertAtMostOneOwner();
  assert.ok(resource.writes.length > 0, '随机序列中应当发生过成功写入');
});
