/** 迭代基-2 FFT, 就地计算。re/im 长度须为 2 的幂。 */
export function fft(re: Float64Array, im: Float64Array, invert: boolean): void {
  const n = re.length
  if (n <= 1) return
  // 位反转置换
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t
      t = im[i]; im[i] = im[j]; im[j] = t
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((2 * Math.PI) / len) * (invert ? -1 : 1)
    const wlRe = Math.cos(ang)
    const wlIm = Math.sin(ang)
    const half = len >> 1
    for (let i = 0; i < n; i += len) {
      let wRe = 1
      let wIm = 0
      for (let j = 0; j < half; j++) {
        const a = i + j
        const b = i + j + half
        const vRe = re[b] * wRe - im[b] * wIm
        const vIm = re[b] * wIm + im[b] * wRe
        re[b] = re[a] - vRe
        im[b] = im[a] - vIm
        re[a] += vRe
        im[a] += vIm
        const t = wRe * wlRe - wIm * wlIm
        wIm = wRe * wlIm + wIm * wlRe
        wRe = t
      }
    }
  }
  if (invert) {
    for (let i = 0; i < n; i++) {
      re[i] /= n
      im[i] /= n
    }
  }
}

/**
 * GCC-PHAT 互相关: 求 b 相对 a 的滞后量。
 * 返回 lag(秒, 正值表示 b 的内容比 a 晚出现 lag 秒)、峰值与置信度。
 * C(τ) = Σ a[m]·b[m+τ], 峰值 τ* 即所求。
 */
export function gccPhat(a: Float32Array, b: Float32Array, fs: number): { lag: number; peak: number; confidence: number } {
  const need = a.length + b.length
  let n = 1
  while (n < need) n <<= 1
  const reA = new Float64Array(n)
  const imA = new Float64Array(n)
  const reB = new Float64Array(n)
  const imB = new Float64Array(n)
  reA.set(a as unknown as number[])
  reB.set(b as unknown as number[])
  fft(reA, imA, false)
  fft(reB, imB, false)
  // R = conj(A) · B, PHAT 白化
  for (let i = 0; i < n; i++) {
    const ar = reA[i], ai = imA[i], br = reB[i], bi = imB[i]
    const rr = ar * br + ai * bi
    const ri = ar * bi - ai * br
    const mag = Math.sqrt(rr * rr + ri * ri) + 1e-12
    reA[i] = rr / mag
    imA[i] = ri / mag
  }
  fft(reA, imA, true)
  // 有效滞后范围: C(τ)=Σ a[m]·b[m+τ] 要求 τ ∈ (-a.length, b.length), 环形存储
  let bestIdx = 0
  let best = -Infinity
  let sumSq = 0
  for (let i = 0; i < n; i++) {
    const v = reA[i]
    sumSq += v * v
    const tau = i <= b.length - 1 ? i : i - n
    if (tau < -(a.length - 1)) continue
    if (v > best) {
      best = v
      bestIdx = i
    }
  }
  const tau = bestIdx <= a.length - 1 ? bestIdx : bestIdx - n
  const rms = Math.sqrt(sumSq / n)
  return {
    lag: tau / fs,
    peak: best,
    confidence: rms > 0 ? best / rms : 0,
  }
}
