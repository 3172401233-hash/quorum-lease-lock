import { StaleFencingTokenError } from './errors.js';

/**
 * 受 fencing token 保护的下游资源。
 *
 * 规则：只接受严格大于已观测 token 的写入。旧 owner（包括发生网络分区后
 * 自以为还在线的 leader）拿着旧 token 写入时会被拒绝，从而杜绝双写。
 * 资源自身需要持久化 lastFencingToken（此处为内存实现，生产环境应落盘）。
 */
export class FencedResource {
  constructor(name) {
    this.name = name;
    this.lastFencingToken = 0;
    this.writes = [];
  }

  /**
   * @param {number} token 调用方携带的 fencing token（租约 term）
   * @param {*} payload 写入内容
   */
  write(token, payload, meta = {}) {
    if (!Number.isInteger(token) || token <= 0) {
      throw new StaleFencingTokenError(this.name, this.lastFencingToken, token);
    }
    if (token <= this.lastFencingToken) {
      throw new StaleFencingTokenError(this.name, this.lastFencingToken, token);
    }
    const record = {
      token,
      payload,
      writer: meta.writer ?? null,
      seq: this.writes.length + 1,
    };
    this.writes.push(record);
    this.lastFencingToken = token;
    return record;
  }

  /**
   * 校验 token 是否仍可用于写入，不产生副作用。
   */
  accepts(token) {
    return Number.isInteger(token) && token > 0 && token > this.lastFencingToken;
  }
}
