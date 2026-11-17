# quorum-lease-lock

基于**多数派投票 + 租约 + fencing token** 的 Node.js 分布式锁核心，零运行时依赖。
解决主备切换场景中“旧 leader 失去多数派后仍继续写入、与新 leader 双写”的问题：

- 只有拿到多数派（quorum）投票且租约在本地仍然有效，节点才能成为 owner；
- owner 每次下游写入必须携带单调递增的 fencing token（即当选 term）；
- 下游资源拒绝任何不大于已观测值的 token，旧 owner 的迟到写入被直接拒绝。

## 模型与模块

| 模块 | 角色 |
| --- | --- |
| `src/voter.js` `Voter` | 投票节点（锁服务端）。维护 term 单调、同一时刻只授予一个有效租约、`(term, nonce)` 幂等去重 |
| `src/lease-lock.js` `LeaseLock` | 候选者/持有者。发起选举、收票、本地租约判定、续期、fencing token 发放 |
| `src/fenced-resource.js` `FencedResource` | 受保护的下游资源，强制写入 token 严格递增 |
| `src/clock.js` `MonotonicClock` | 单调时钟抽象，默认基于全局 `performance.now()`，测试可注入虚拟时钟 |

多数派阈值为 `floor(N/2) + 1`，因此节点数应取奇数（推荐 3 或 5）。

## 快速使用

```js
import { Voter, LeaseLock, FencedResource } from 'quorum-lease-lock';

const voters = [1, 2, 3, 4, 5].map((i) => new Voter(`v${i}`));
const lock = new LeaseLock('node-A', voters.length, { ttlMs: 10_000 });

// 1. 发起选举并把请求广播给所有 voter
const request = lock.startElection();
for (const voter of voters) {
  lock.handleVote(voter.requestVote(request));
}

// 2. 多数派且租约有效才成为 owner
const owner = lock.tryAcquire();
if (!owner) throw new Error('未获得多数派，不能成为 owner');

// 3. 带 fencing token 写下游，旧 token 会被资源拒绝
const resource = new FencedResource('inventory');
await lock.writeDownstream(resource, { sku: 'x', qty: 1 });

// 4. 租约到期前周期性续期；续期失败应停止写入并等待过期/重新选举
const renewal = lock.buildRenewalRequest();
const responses = voters.map((v) => v.requestVote(renewal));
lock.handleRenewalResponses(responses);
```

## 安全余量与时钟假设

锁不依赖分布式墙钟一致性，而是建立在**有界漂移 + 单调时钟 + 保守余量**之上：

1. **单调时钟**：所有时长判定基于 `performance.now()` 之类的单调时钟，系统时间被
   NTP 回拨不会让租约“续命”或提前失效。注意单调时钟只用于度量经过时间，不能跨节点
   比较绝对值。
2. **有界漂移假设**：假设节点间时钟偏差始终小于 `maxClockSkewMs`（默认 `ttl/20`）。
   voter 会拒绝“租约起点来自未来且超出偏差上限”的请求，挡住时钟异常的候选者。
3. **本地安全余量 `safetyMarginMs`**（默认 `ttl/10`，且必须 ≥ `maxClockSkewMs`）：
   持有者本地判定的有效期为 `ttl - safetyMarginMs`，比服务端授予提前结束。即使存在
   漂移、网络抖动或事件循环停顿，节点也会在服务端租约真正过期**之前**主动放弃写入。
4. **fencing 是最后防线**：即使旧 owner 因长时间 GC、时钟错觉而误判自己仍持有租约，
   它携带的旧 term 也会被 `FencedResource` 拒绝。因此正确性不依赖 owner 自觉下线，
   但要求下游资源持久化已观测的最大 token（本库为内存实现，生产环境需落盘/随数据原子写入）。
5. **租约互斥**：voter 在旧授予仍有效时拒绝更高 term 的投票请求，保证任意时刻全局
   至多一个 term 拥有多数派有效授予（由 `tests/invariant.test.js` 随机故障序列持续校验）。

续期失败不会立刻剥夺 owner 身份——剩余本地租约期内的写入仍受 fencing 保护；调用方
应当停止新写入、重试续期，等待本地过期或 `stepDown()` 后再发起新一轮选举。

## 依赖假设

- Node.js >= 18（使用全局 `performance`、`node:test`、ESM）。
- **零第三方运行时依赖**；投票节点的持久化、RPC 传输与消息通道由集成方提供，
  本库只实现可单测的纯逻辑核心。
- 消息可以丢失、重复、乱序：重复请求由 `(term, nonce)` 幂等处理，迟到的旧轮次
  响应按 term 忽略；但要求 term 全局单调（由候选者本地递增 + voter 拒绝旧 term 保证）。
- 下游存储需要支持“比较并拒绝旧 token”的写入条件（等价于 CAS / check-and-set）。

## 测试

```bash
node --test
# 或
npm test
```

覆盖场景（共 16 个用例）：

- **网络分区**：少数派不能当选；分区中旧 leader 续期失败、过期停写，新 leader 当选后
  旧 token 直写被 fencing 拦截，无双写；网络恢复后 owner 重新选举。
- **时钟漂移**：快钟节点在安全余量内提前放弃；慢钟节点的未来租约被拒；偏差边界内
  选举/续期正常；非法余量配置快速失败。
- **投票重放**：同请求重放幂等且不延长租约；旧 term 请求拒绝；迟到响应被忽略。
- **租约续期失败与 owner 恢复**：续期失败保留剩余租约、过期即禁写；恢复后续期成功。
- **不变量**：300 步随机混合分区/选举/续期/漂移，持续断言任意时刻至多一个多数派
  owner，且成功写入的 fencing token 严格递增。
