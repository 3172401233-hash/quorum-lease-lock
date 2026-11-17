/**
 * 单调时钟抽象。
 *
 * 生产环境使用 perf_hooks.performance.now()（毫秒，单调递增，不受系统墙钟
 * 被 NTP/管理员回拨的影响）。测试可注入自定义实现以模拟时钟漂移与暂停。
 */
export class MonotonicClock {
  constructor(nowFn = () => performance.now()) {
    this.now = nowFn;
  }

  /**
   * 返回单调毫秒时间戳。不同节点的零点没有可比性，只用于度量经过时间。
   */
  now() {}
}
