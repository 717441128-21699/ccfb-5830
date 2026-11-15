#!/usr/bin/env python3
"""Generate a transparent RGBA timecode strip video on stdout (rawvideo).

Each frame shows "<LABEL> HH:MM:SS.mmm" where the time is the *session*
time (media time + offset), so burned-in timecodes can be checked against
the timeline after alignment.
"""
import argparse
import sys

FONT = {
    '0': ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
    '1': ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
    '2': ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
    '3': ["11110", "00001", "00001", "01110", "00001", "00001", "11110"],
    '4': ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
    '5': ["11111", "10000", "11110", "00001", "00001", "10001", "01110"],
    '6': ["00110", "01000", "10000", "11110", "10001", "10001", "01110"],
    '7': ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
    '8': ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
    '9': ["01110", "10001", "10001", "01111", "00001", "00010", "01100"],
    'A': ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
    'C': ["01110", "10001", "10000", "10000", "10000", "10001", "01110"],
    'M': ["10001", "11011", "10101", "10101", "10001", "10001", "10001"],
    'R': ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
    'E': ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
    ':': ["00000", "00100", "00100", "00000", "00100", "00100", "00000"],
    '.': ["00000", "00000", "00000", "00000", "00000", "01100", "01100"],
    ' ': ["00000"] * 7,
    '-': ["00000", "00000", "00000", "01110", "00000", "00000", "00000"],
}

SCALE = 6
GW, GH = 5 * SCALE, 7 * SCALE  # glyph size
ADV = GW + SCALE               # advance per char


def build_glyphs():
    """Pre-render each glyph as an RGBA bytes block (white text)."""
    glyphs = {}
    for ch, rows in FONT.items():
        buf = bytearray(GW * GH * 4)
        for gy, row in enumerate(rows):
            for gx, bit in enumerate(row):
                if bit == '1':
                    for sy in range(SCALE):
                        for sx in range(SCALE):
                            px = gx * SCALE + sx
                            py = gy * SCALE + sy
                            i = (py * GW + px) * 4
                            buf[i:i + 4] = b'\xff\xff\xff\xff'
        glyphs[ch] = bytes(buf)
    return glyphs


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--fps', type=float, required=True)
    ap.add_argument('--duration', type=float, required=True)
    ap.add_argument('--offset', type=float, default=0.0, help='session time at media t=0')
    ap.add_argument('--label', default='CAM 1')
    ap.add_argument('--width', type=int, default=700)
    ap.add_argument('--height', type=int, default=96)
    args = ap.parse_args()

    W, H = args.width, args.height
    glyphs = build_glyphs()
    n_frames = int(round(args.duration * args.fps))
    out = sys.stdout.buffer

    text_y = (H - GH) // 2
    text_x = 20

    for n in range(n_frames):
        t_media = n / args.fps
        t_session = t_media + args.offset
        neg = t_session < 0
        ts = abs(t_session)
        hh = int(ts // 3600)
        mm = int(ts % 3600 // 60)
        ss = int(ts % 60)
        ms = int(round(ts % 1 * 1000))
        if ms >= 1000:
            ms = 999
        sign = '-' if neg else ' '
        text = f"{args.label}{sign}{hh:02d}:{mm:02d}:{ss:02d}.{ms:03d}"

        frame = bytearray(W * H * 4)
        # semi-transparent background box behind text
        box_w = len(text) * ADV + 24
        for y in range(12, H - 12):
            row = y * W * 4
            for x in range(8, min(box_w, W - 8)):
                i = row + x * 4
                frame[i + 3] = 150  # alpha; rgb stays 0
        # blit glyphs
        cx = text_x
        for ch in text:
            g = glyphs.get(ch, glyphs[' '])
            for gy in range(GH):
                dst = ((text_y + gy) * W + cx) * 4
                src = gy * GW * 4
                row = g[src:src + GW * 4]
                for px in range(GW):
                    if row[px * 4 + 3]:
                        i = dst + px * 4
                        frame[i:i + 4] = row[px * 4:px * 4 + 4]
            cx += ADV
        out.write(frame)
    out.flush()


if __name__ == '__main__':
    main()
