#!/usr/bin/env python3
"""生成桌面桌宠的点击音效（原创合成，无第三方素材）。

输出 4 枚 WAV 到 out_dir，再由 ffmpeg 转 MP3：
    duck-press.wav     小黄鸭风格 —— 按下（上扬的"吱"）
    duck-release.wav   小黄鸭风格 —— 松开（下行的"叽"）
    dingdong-press.wav 叮咚 —— 按下（高音"叮"）
    dingdong-release.wav 叮咚 —— 松开（低音"咚"）

只依赖 Python 标准库（wave / math / struct / random）+ 本地 ffmpeg。
用法：
    python scripts/make-sounds.py [输出目录]
"""

import math
import os
import random
import struct
import subprocess
import sys
import wave

SR = 44100            # 采样率
PEAK = 0.72           # 归一化目标峰值（留足余量，避免削波）


def _env_ad(t, attack, decay_tau, total):
    """快起 + 指数衰减包络。t 为当前时刻，返回 0~1。"""
    if t < attack:
        return t / attack
    x = (t - attack) / max(decay_tau, 1e-6)
    tail = math.exp(-x)
    # 末尾 15% 加一段平滑淡出，杜绝爆音
    fade = 1.0
    if total > 0 and t > total * 0.85:
        fade = max(0.0, (total - t) / (total * 0.15))
    return tail * fade


def duck(descending=False):
    """小黄鸭风格 squeak：音高先扬后抑 + 轻微颤音，带一点"橡胶摩擦"噪声。"""
    total = 0.14 if descending else 0.22
    n = int(SR * total)
    if descending:
        f0, f1 = 640.0, 330.0
    else:
        f0, f1 = 660.0, 1180.0
    rnd = random.Random(41019 if descending else 73501)
    out = []
    for i in range(n):
        t = i / SR
        p = t / total
        # 音高轨迹：上行取 sin 拱形（先升后回落），下行取线性下落
        if descending:
            f = f0 + (f1 - f0) * p
        else:
            f = f0 + (f1 - f0) * math.sin(math.pi * min(p / 0.72, 1.0))
        # 颤音（28 Hz，深度 5%）
        f *= 1.0 + 0.05 * math.sin(2 * math.pi * 28.0 * t)
        phase = 2 * math.pi * f * t
        # 谐波堆叠，令音色偏"玩具哨子"
        v = (
            math.sin(phase)
            + 0.34 * math.sin(2 * phase)
            + 0.12 * math.sin(3 * phase)
            + 0.05 * math.sin(4 * phase)
        )
        # 起音处 4ms 的噪声，模拟橡胶摩擦
        if t < 0.004:
            v += (rnd.random() * 2 - 1) * 0.35 * (1 - t / 0.004)
        out.append(v * _env_ad(t, 0.006, 0.055 if descending else 0.085, total))
    return out


def chime(freq, total, tau, partials):
    """钟/铃：若干（近似）谐波分音，各自独立衰减。"""
    n = int(SR * total)
    out = [0.0] * n
    for mult, amp, tau_mult in partials:
        f = freq * mult
        for i in range(n):
            t = i / SR
            if t >= total:
                break
            out[i] += amp * math.exp(-t / (tau * tau_mult)) * math.sin(2 * math.pi * f * t)
    for i in range(n):
        out[i] *= _env_ad(i / SR, 0.002, tau * 4, total)
    return out


def write_wav(path, buf):
    peak = max(1e-9, max(abs(v) for v in buf))
    scale = PEAK / peak
    with wave.open(path, 'w') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        frames = bytearray()
        for v in buf:
            s = int(max(-1.0, min(1.0, v * scale)) * 32767)
            frames += struct.pack('<h', s)
        w.writeframes(bytes(frames))


BUILD = {
    'duck-press': lambda: duck(descending=False),
    'duck-release': lambda: duck(descending=True),
    'dingdong-press': lambda: chime(
        1174.7, 0.40, 0.085,
        [(1.0, 1.00, 1.0), (2.01, 0.42, 0.80), (2.99, 0.22, 0.60), (4.21, 0.10, 0.45)],
    ),
    'dingdong-release': lambda: chime(
        880.0, 0.52, 0.130,
        [(1.0, 1.00, 1.0), (2.00, 0.30, 0.75), (2.96, 0.12, 0.50)],
    ),
}


def main():
    out_dir = sys.argv[1] if len(sys.argv) > 1 else os.path.dirname(os.path.abspath(__file__))
    os.makedirs(out_dir, exist_ok=True)
    for name, fn in BUILD.items():
        wav = os.path.join(out_dir, name + '.wav')
        write_wav(wav, fn())
        print('  wav  -> %s (%d bytes)' % (wav, os.path.getsize(wav)))


if __name__ == '__main__':
    main()
