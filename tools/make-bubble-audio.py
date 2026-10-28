"""把气泡提示音按 JS 里同样的参数合成成 WAV，顺便做两个备选版本。"""
import pathlib
import struct

import numpy as np

RATE = 44100
OUT = pathlib.Path(__file__).resolve().parent.parent / 'shots' / 'audio'
OUT.mkdir(parents=True, exist_ok=True)


def envelope(n, attack, total, peak):
    t = np.arange(n) / RATE
    env = np.zeros(n)
    a = max(attack, 1e-4)
    atk = t < a
    env[atk] = peak * (t[atk] / a)
    dec = ~atk
    env[dec] = peak * np.exp(-(t[dec] - a) / max(total - a, 1e-4) * 4.2)
    return env


def tone(freq_from, freq_to, dur, peak, attack, kind='sine'):
    n = int(RATE * dur)
    t = np.arange(n) / RATE
    f = freq_from * (freq_to / freq_from) ** (t / dur)
    phase = 2 * np.pi * np.cumsum(f) / RATE
    if kind == 'sine':
        wave = np.sin(phase)
    else:   # triangle
        wave = 2 / np.pi * np.arcsin(np.sin(phase))
    return wave * envelope(n, attack, dur, peak)


def make(peak_main=0.055, peak_sub=0.035, f1=(620, 980), f2=(180, 120),
         d1=0.13, d2=0.11, a1=0.012, a2=0.010, extra=None):
    n = int(RATE * max(d1, d2))
    buf = np.zeros(n)
    s1 = tone(f1[0], f1[1], d1, peak_main, a1, 'sine')
    buf[:len(s1)] += s1
    s2 = tone(f2[0], f2[1], d2, peak_sub, a2, 'triangle')
    buf[:len(s2)] += s2
    if extra is not None:
        buf[:len(extra)] += extra
    # 尾部淡出，避免爆音
    fade = int(RATE * 0.012)
    buf[-fade:] *= np.linspace(1, 0, fade)
    return buf


def write_wav(path, buf):
    data = np.clip(buf, -1, 1)
    pcm = (data * 32767).astype('<i2').tobytes()
    header = (b'RIFF' + struct.pack('<I', 36 + len(pcm)) + b'WAVEfmt '
              + struct.pack('<IHHIIHH', 16, 1, 1, RATE, RATE * 2, 2, 16)
              + b'data' + struct.pack('<I', len(pcm)))
    path.write_bytes(header + pcm)
    print(f'{path.name}  {len(pcm) / 1024:.1f} KB  {len(buf) / RATE * 1000:.0f} ms')


# A：当前线上版本
a = make()

# B：更轻更闷（音量降 40%，频率下移）
b = make(peak_main=0.033, peak_sub=0.024, f1=(520, 760), f2=(150, 100), d1=0.15, d2=0.13)

# C：更亮更“啵”一点（加一个短促高频泛音）
overtone = tone(1400, 1900, 0.06, 0.02, 0.006, 'sine')
c = make(peak_main=0.05, peak_sub=0.03, extra=overtone)

for name, buf in (('气泡音A-当前.wav', a), ('气泡音B-更轻.wav', b), ('气泡音C-更亮.wav', c)):
    write_wav(OUT / name, buf)

# 一段包含三次播放的合集，方便一次听完
gap = np.zeros(int(RATE * 0.7))
allt = np.concatenate([a, gap, b, gap, c])
write_wav(OUT / '气泡音-三版合集.wav', allt)
