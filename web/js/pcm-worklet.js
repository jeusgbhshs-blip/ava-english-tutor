/**
 * Ava · PCM 采集 AudioWorkletProcessor（SPEC v1.4 §C3）
 *
 * 把麦克风输入的 Float32（设备采样率，通常 48kHz）**线性插值重采样**为
 * 16kHz mono s16le，每 20ms（320 samples = 640 bytes）通过 port 发给主线程，
 * 由 `doubao-voice.js` 直接作为二进制 WebSocket 帧发给本地服务桥。
 *
 * 模块由 `doubao-voice.js` 自动加载注册（`audioWorklet.addModule`），
 * 主线程无需 import；AudioWorklet 不可用时自动回退 ScriptProcessor 实现。
 *
 * 处理器名：`'ava-pcm-16k'`
 * 消息格式：`{ type:'pcm', buffer:ArrayBuffer(640), sampleRate:16000, samples:320, seq }`
 *
 * @module pcm-worklet
 */

const DEFAULT_TARGET_RATE = 16000
const DEFAULT_CHUNK_MS = 20

class AvaPcm16kProcessor extends AudioWorkletProcessor {
  /**
   * @param {{processorOptions?: {targetRate?: number, chunkMs?: number}}} [options]
   */
  constructor(options) {
    super()
    const processorOptions =
      (options && options.processorOptions && typeof options.processorOptions === 'object'
        ? options.processorOptions
        : {}) || {}
    const targetRate = Number(processorOptions.targetRate) > 0 ? Number(processorOptions.targetRate) : DEFAULT_TARGET_RATE
    const chunkMs = Number(processorOptions.chunkMs) > 0 ? Number(processorOptions.chunkMs) : DEFAULT_CHUNK_MS

    this.targetRate = targetRate
    /** 设备采样率 / 目标采样率（48k→16k 时通常为 3，44.1k→16k 约 2.756） */
    this.ratio = sampleRate / targetRate
    this.chunkSamples = Math.max(1, Math.round((targetRate * chunkMs) / 1000))
    /** @type {Int16Array} */
    this.int16 = new Int16Array(this.chunkSamples)
    this.count = 0
    /** 跨 process() 块保留的少量输入样本（保证插值连续） @type {Float32Array} */
    this.carry = new Float32Array(0)
    this.pos = 0
    this.seq = 0
  }

  /**
   * 写入一个重采样样本，凑满 20ms 就 postMessage 给主线程。
   * @param {number} value
   */
  emitSample(value) {
    const v = value > 1 ? 1 : value < -1 ? -1 : value
    this.int16[this.count] = v < 0 ? v * 0x8000 : v * 0x7fff
    this.count += 1
    if (this.count < this.chunkSamples) return
    const copy = this.int16.slice(0, this.chunkSamples)
    this.count = 0
    this.seq += 1
    this.port.postMessage(
      { type: 'pcm', buffer: copy.buffer, sampleRate: this.targetRate, samples: copy.length, seq: this.seq },
      [copy.buffer],
    )
  }

  /**
   * @param {Float32Array[][]} inputs 输入音频（channels）
   * @returns {boolean} 保持处理器存活
   */
  process(inputs) {
    const input = inputs[0]
    const channel = input && input[0]
    if (!channel || channel.length === 0) return true

    // carry（上一块末尾）+ 本块，作为连续信号处理
    const src = new Float32Array(this.carry.length + channel.length)
    if (this.carry.length) src.set(this.carry, 0)
    src.set(channel, this.carry.length)

    let pos = this.pos
    const ratio = this.ratio
    while (pos + 1 < src.length) {
      const index = Math.floor(pos)
      const frac = pos - index
      const s0 = src[index]
      const s1 = src[index + 1]
      this.emitSample(s0 + (s1 - s0) * frac)
      pos += ratio
    }

    // 保留最后一个未完成的插值区间，供下一块继续
    let keep = Math.floor(pos)
    if (keep > src.length - 1) keep = src.length - 1
    if (keep < 0) keep = 0
    this.carry = src.slice(keep)
    this.pos = pos - keep
    return true
  }
}

registerProcessor('ava-pcm-16k', AvaPcm16kProcessor)
