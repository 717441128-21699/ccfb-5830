// 对齐算法自测: 构造已知偏移的信号, 验证 gccPhat 求出的滞后量
import { gccPhat } from '../src/fft.ts'

const fs = 8000
// 确定性伪随机
let seed = 42
const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff - 0.5

// 30s "现场"信号: 噪声底 + 不规则啁啾
const session = new Float32Array(30 * fs).map(() => rand() * 0.05)
for (const t0 of [3.2, 11.7, 24.1]) {
  for (let i = 0; i < 0.7 * fs; i++) {
    const t = i / fs
    session[Math.floor(t0 * fs) + i] += 0.5 * Math.sin(2 * Math.PI * (500 + 900 * t) * t)
  }
}

function segment(startS: number, durS: number): Float32Array {
  const out = new Float32Array(Math.floor(durS * fs))
  const off = Math.round(startS * fs)
  for (let i = 0; i < out.length; i++) out[i] = (session[off + i] ?? 0) + rand() * 0.01
  return out
}

const ref = segment(0, 30) // 基准: 覆盖全部会话 0~30s
const cases: Array<[string, number, number]> = [
  ['cam2 晚开机 8.4s', 8.4, 10],
  ['cam3 晚开机 21.75s', 21.75, 8],
  ['recorder 早开机 6.3s', -6.3, 20],
]

let fail = 0
for (const [name, trueOffset, dur] of cases) {
  const sig = segment(trueOffset, dur)
  const { lag, peak, confidence } = gccPhat(ref, sig, fs)
  const offset = 0 - lag
  const errMs = Math.abs(offset - trueOffset) * 1000
  const ok = errMs < 1 // 8kHz 下 1 样本 = 0.125ms
  if (!ok) fail++
  console.log(
    `${ok ? 'PASS' : 'FAIL'} ${name}: 期望 ${trueOffset}s, 解出 ${offset.toFixed(4)}s, 误差 ${errMs.toFixed(2)}ms, 峰 ${peak.toFixed(3)}, 置信 ${confidence.toFixed(1)}`,
  )
}
process.exit(fail ? 1 : 0)
