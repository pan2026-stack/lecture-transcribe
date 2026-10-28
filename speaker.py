"""声纹：把一段音频变成 192 维说话人向量，再把一节课的向量聚成说话人。

依赖：vendor/onnxrt 里的 onnxruntime + models/campplus_int8.onnx
特征：kaldi 风格 80 维 fbank（25ms 窗 / 10ms 移 / 预加重 0.97 / Hamming），纯 Python 实现，不依赖 numpy。
"""

from __future__ import annotations

import math
import struct
import sys
from pathlib import Path

BASE = Path(__file__).resolve().parent
MODEL = BASE / "models" / "campplus_int8.onnx"
SR = 16000
N_FFT = 512
WIN = 400           # 25ms
HOP = 160           # 10ms
N_MELS = 80
FMIN, FMAX = 20.0, 7600.0
PREEMPH = 0.97

_ORT = None
_SESS = None


def _runtime():
    global _ORT
    if _ORT is not None:
        return _ORT
    vendor = BASE / "vendor" / "onnxrt"
    if vendor.is_dir() and str(vendor) not in sys.path:
        sys.path.insert(0, str(vendor))
    import onnxruntime  # noqa: WPS433
    onnxruntime.set_default_logger_severity(3)
    _ORT = onnxruntime
    return _ORT


def _session():
    global _SESS
    if _SESS is not None:
        return _SESS
    ort = _runtime()
    _SESS = ort.InferenceSession(str(MODEL), providers=["CPUExecutionProvider"])
    return _SESS


# ---------------------------------------------------------------- 读 wav

def read_wav(data: bytes) -> list[float]:
    """只支持 16k 单声道 16bit PCM（我们自己的切片就是这个格式）"""
    if data[:4] != b"RIFF":
        raise ValueError("不是 wav")
    pos = 12
    fmt = None
    while pos + 8 <= len(data):
        cid = data[pos:pos + 4]
        size = struct.unpack("<I", data[pos + 4:pos + 8])[0]
        body = data[pos + 8:pos + 8 + size]
        if cid == b"fmt ":
            fmt = body
        elif cid == b"data":
            if not fmt:
                raise ValueError("wav 缺 fmt")
            channels = struct.unpack("<H", fmt[2:4])[0]
            bits = struct.unpack("<H", fmt[14:16])[0]
            if bits != 16:
                raise ValueError(f"只支持 16bit，当前 {bits}")
            n = len(body) // 2
            samples = struct.unpack("<" + "h" * n, body[:n * 2])
            if channels > 1:
                samples = samples[::channels]
            return [s / 32768.0 for s in samples]
        pos += 8 + size + (size & 1)
    raise ValueError("wav 没有 data 段")


# ---------------------------------------------------------------- fbank

def _mel(f: float) -> float:
    return 2595.0 * math.log10(1.0 + f / 700.0)


def _mel_inv(m: float) -> float:
    return 700.0 * (10 ** (m / 2595.0) - 1.0)


def _mel_bank() -> list[list[tuple[int, float]]]:
    """80 个三角滤波器，稀疏存成 (bin, weight)"""
    lo, hi = _mel(FMIN), _mel(FMAX)
    points = [_mel_inv(lo + (hi - lo) * i / (N_MELS + 1)) for i in range(N_MELS + 2)]
    bins = [int(round(p / (SR / N_FFT))) for p in points]
    bank = []
    for m in range(N_MELS):
        left, center, right = bins[m], bins[m + 1], bins[m + 2]
        if right <= left:
            right = left + 1
        filt = []
        for k in range(left, center):
            filt.append((k, (k - left) / max(1, center - left)))
        for k in range(center, right):
            filt.append((k, (right - k) / max(1, right - center)))
        bank.append(filt)
    return bank


_BANK = None
_HAMMING = [0.54 - 0.46 * math.cos(2 * math.pi * i / (WIN - 1)) for i in range(WIN)]


def _fft_power(frame: list[float]) -> list[float]:
    """512 点 FFT 的功率谱（radix-2，纯 Python）"""
    x = [complex(v, 0.0) for v in frame] + [0j] * (N_FFT - WIN)
    n = N_FFT
    j = 0
    for i in range(1, n):
        bit = n >> 1
        while j & bit:
            j ^= bit
            bit >>= 1
        j |= bit
        if i < j:
            x[i], x[j] = x[j], x[i]
    length = 2
    while length <= n:
        ang = -2 * math.pi / length
        wl = complex(math.cos(ang), math.sin(ang))
        half = length // 2
        for i in range(0, n, length):
            w = 1 + 0j
            for k in range(half):
                u = x[i + k]
                v = x[i + k + half] * w
                x[i + k] = u + v
                x[i + k + half] = u - v
                w *= wl
        length <<= 1
    return [abs(v) ** 2 for v in x[: N_FFT // 2 + 1]]


def fbank(samples: list[float]) -> list[list[float]]:
    global _BANK
    if _BANK is None:
        _BANK = _mel_bank()
    if len(samples) < WIN:
        samples = samples + [0.0] * (WIN - len(samples))
    # 预加重
    emph = [samples[0]] + [samples[i] - PREEMPH * samples[i - 1] for i in range(1, len(samples))]
    frames = []
    for start in range(0, len(emph) - WIN + 1, HOP):
        seg = emph[start:start + WIN]
        power = _fft_power([seg[i] * _HAMMING[i] for i in range(WIN)])
        feats = []
        for filt in _BANK:
            energy = 0.0
            for k, w in filt:
                if k < len(power):
                    energy += power[k] * w
            feats.append(math.log(energy + 1e-10))
        frames.append(feats)
    return frames


# ---------------------------------------------------------------- 向量

def embedding(wav_bytes: bytes) -> list[float]:
    """一段音频 -> 192 维单位向量"""
    sess = _session()
    samples = read_wav(wav_bytes)
    frames = fbank(samples)
    if not frames:
        return []
    # 逐帧均值归一化（CAM++ 的训练方式）
    n = len(frames)
    mean = [sum(f[d] for f in frames) / n for d in range(N_MELS)]
    feats = [[f[d] - mean[d] for d in range(N_MELS)] for f in frames]

    import array  # noqa: WPS433
    flat = array.array("f")
    for row in feats:
        flat.extend(row)
    inp = sess.get_inputs()[0]
    shape = [1, len(feats), N_MELS]
    vec = sess.run(None, {inp.name: _to_array(flat, shape)})[0]
    out = list(vec.reshape(-1)) if hasattr(vec, "reshape") else list(vec[0])
    norm = math.sqrt(sum(v * v for v in out)) or 1.0
    return [v / norm for v in out]


def _to_array(flat, shape):
    import array  # noqa: WPS433
    try:
        import numpy as np  # noqa: WPS433
        return np.array(flat, dtype="float32").reshape(shape)
    except Exception:
        return flat


# ---------------------------------------------------------------- 聚类

def _cos(a: list[float], b: list[float]) -> float:
    return sum(x * y for x, y in zip(a, b))


def cluster(vecs: list[list[float]], threshold: float = 0.62) -> list[int]:
    """层次聚类：余弦相似度超过 threshold 就归为一类，返回每段的说话人编号"""
    idx = [i for i, v in enumerate(vecs) if v]
    if not idx:
        return []
    groups: list[list[int]] = [[i] for i in idx]
    while len(groups) > 1:
        best, pair = -1.0, None
        for gi in range(len(groups)):
            for gj in range(gi + 1, len(groups)):
                sims = [_cos(vecs[a], vecs[b]) for a in groups[gi][:6] for b in groups[gj][:6]]
                s = sum(sims) / len(sims)
                if s > best:
                    best, pair = s, (gi, gj)
        if best < threshold or pair is None:
            break
        gi, gj = pair
        groups[gi] = groups[gi] + groups.pop(gj)

    labels = [0] * len(vecs)
    order = sorted(range(len(groups)), key=lambda k: -len(groups[k]))
    for rank, g in enumerate(order):
        for i in groups[g]:
            labels[i] = rank + 1
    return labels
